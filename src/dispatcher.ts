import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectReconcileIntervalMs } from "./bus/bus.ts";
import {
  createDaemonEventSources,
  describeHealth,
  type DaemonEventWiring,
} from "./bus/daemon-events.ts";
import type { SwarmEvent } from "./bus/events.ts";
import {
  describeReactors,
  executeEffects,
  ReactorRegistry,
  type EffectHandlers,
  type Reactor,
} from "./bus/reactor.ts";
import { WakeScheduler } from "./bus/scheduler.ts";
import { realTimers, type Timers } from "./bus/timers.ts";
import { BoardClient, type BoardTask } from "./lib/board.ts";
import {
  BUILTIN_AGENT_KINDS,
  DEFAULT_RECONCILE_INTERVAL_SECONDS,
  DEFAULT_STARTUP_TIMEOUT_SECONDS,
  loadProjectsConfig,
  loadProjectsConfigOptional,
  loadSwarmConfig,
  resolveCurrentMachineName,
  resolveMachineRuntime,
  type MachineConfig,
  type ProjectsConfig,
  type SwarmConfig,
} from "./lib/config.ts";
import {
  applyParkedTabOutcome,
  applyTaskStepOutcome,
  buildBoardEnv,
  type EffectExecutorDeps,
  type ParkedTab,
} from "./lib/dispatcher-effects.ts";
import {
  dispatcherStateFingerprint,
  loadDispatcherState,
  resolveDispatcherStatePath,
  saveDispatcherState,
  toPersisted,
} from "./lib/dispatcher-state.ts";
import { HerdrClient } from "./lib/herdr.ts";
import {
  blockedAdoptionLabel,
  buildAdoptedTask,
  buildParkedAdoption,
  decideOrphan,
  findUntrackedOwnClaims,
  type OrphanDecision,
} from "./lib/orphan-sweep.ts";
import { buildMachineRegistryEntry, publishMachineRegistry } from "./lib/registry.ts";
import {
  defaultGitChangeDetector,
  findReadyForReviewReply,
  findReviewVerdictReply,
  type GitChangeDetector,
} from "./lib/review.ts";
import { RexClient } from "./lib/rex.ts";
import {
  formatTabLabel,
  renderWorkerPrompt,
  resolveTaskRouting,
  selectEligibleTasks,
  shortTaskId,
  type CandidateTask,
} from "./lib/routing.ts";
import {
  buildSessionRef,
  sanitizeAgentName,
  type LiveAgent,
  type SnapshotRef,
  type WorkerRuntime,
} from "./lib/runtime.ts";
import { HerdrRuntime } from "./lib/runtimes/herdr-runtime.ts";
import { RexRuntime } from "./lib/runtimes/rex-runtime.ts";
import { assertNever, createManagedSession, type SessionHandle } from "./lib/session-fsm.ts";
import {
  getImplHandle,
  getReviewerHandle,
  stepParkedTab,
  stepTask,
  type ActiveTask,
  type ThreadSignal,
} from "./lib/task-fsm.ts";
import { defaultGitWorktreeManager, type GitWorktreeManager } from "./lib/worktree.ts";
import {
  createConfiguredEffectHandlers,
  createConfiguredReactors,
  type CommandRunner,
} from "./reactors/configured.ts";
import {
  createDispatcherWakeReactor,
  createProjectsReloadReactor,
  type DispatcherWakeContext,
} from "./reactors/dispatcher-wake.ts";

const STARTUP_GRACE_MS = 20_000;
/** Page size for open-task discovery; `listTasks` follows the cursor across pages. */
const TASK_PAGE_SIZE = 100;

interface CliFlags {
  machine?: string;
  once: boolean;
  dryRun: boolean;
}

function parseCliFlags(argv: string[]): CliFlags {
  let machine: string | undefined;
  let once = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") once = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--machine" && argv[i + 1]) {
      machine = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--machine=")) {
      machine = arg.slice("--machine=".length);
    }
  }

  return { machine, once, dryRun };
}

function log(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${message}`;
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

function detectAvailableAgentKinds(swarm: SwarmConfig): Set<string> {
  const available = new Set<string>();
  const kinds = new Set<string>(BUILTIN_AGENT_KINDS);
  for (const profile of Object.values(swarm.workerDefaults.agents)) {
    kinds.add(profile.kind);
  }

  for (const kind of kinds) {
    try {
      execFileSync("which", [kind], { stdio: "ignore", timeout: 5_000 });
      available.add(kind);
    } catch {
      // Binary not on PATH on this machine
    }
  }
  return available;
}

export function createWorkerRuntime(
  machineCfg: Pick<MachineConfig, "runtime" | "herdrTarget">,
): WorkerRuntime {
  const rt = resolveMachineRuntime(machineCfg);
  if (rt.kind === "rex") {
    return new RexRuntime(new RexClient({ binary: rt.binary }));
  }
  return new HerdrRuntime(new HerdrClient({ target: rt.target }));
}

export class SwarmDispatcher {
  readonly repoRoot: string;
  readonly swarm: SwarmConfig;
  projects: ProjectsConfig;
  readonly projectsConfigPath: string | null;
  readonly machineName: string;
  readonly board: BoardClient;
  readonly runtime: WorkerRuntime;
  readonly worktreeManager: GitWorktreeManager;
  readonly promptTemplate: string;
  readonly reviewerPromptTemplate: string;
  readonly gitDetector: GitChangeDetector;
  readonly availableAgentKinds: Set<string>;
  readonly dryRun: boolean;
  /** Where tracked tasks are persisted across restarts; null disables persistence. */
  readonly statePath: string | null;

  readonly activeWorkers = new Map<string, ActiveTask>();
  readonly parkedTabs = new Map<string, ParkedTab>();
  private stopping = false;
  private readonly stopController = new AbortController();
  private lastPersistedFingerprint: string | null = null;
  private lastProjectsMtimeMs = 0;
  private registryPublishedOnce = false;
  /** Live event wiring; null means polling only (the pre-bus behavior). */
  private readonly events: DaemonEventWiring | null;
  private readonly timers: Timers;
  private scheduler: WakeScheduler | null = null;
  /** Built-in (and configured) "when X, do Y" rules, run for every bus event. */
  readonly reactors: ReactorRegistry<DispatcherWakeContext>;
  /** Runs `run_command` / `post` effects of configured reactors (keeps their cooldowns). */
  private readonly configuredEffects: EffectHandlers;

  constructor(params: {
    repoRoot: string;
    swarm: SwarmConfig;
    projects: ProjectsConfig;
    projectsConfigPath?: string;
    machineName: string;
    board: BoardClient;
    /** Terminal runtime hosting worker agents. Either `runtime` or legacy `herdr` must be provided. */
    runtime?: WorkerRuntime;
    /** Legacy back-compat alias for `runtime: new HerdrRuntime(herdr)`. */
    herdr?: HerdrClient;
    worktreeManager?: GitWorktreeManager;
    promptTemplate: string;
    reviewerPromptTemplate?: string;
    gitDetector?: GitChangeDetector;
    availableAgentKinds: Set<string>;
    dryRun: boolean;
    statePath?: string;
    /** Live Board/Herdr/Rex events; omitted, the dispatcher polls exactly as before. */
    events?: DaemonEventWiring;
    timers?: Timers;
    /** Additional reactors (config-driven ones), run after the built-ins. */
    extraReactors?: Array<Reactor<DispatcherWakeContext>>;
    commandRunner?: CommandRunner;
  }) {
    if (!params.runtime && !params.herdr) {
      throw new Error("SwarmDispatcher requires either `runtime` or `herdr`.");
    }
    this.repoRoot = params.repoRoot;
    this.swarm = params.swarm;
    this.projects = params.projects;
    this.projectsConfigPath = params.projectsConfigPath ?? null;
    this.machineName = params.machineName;
    this.board = params.board;
    this.runtime = params.runtime ?? new HerdrRuntime(params.herdr!);
    this.worktreeManager = params.worktreeManager ?? defaultGitWorktreeManager;
    this.promptTemplate = params.promptTemplate;
    this.reviewerPromptTemplate = params.reviewerPromptTemplate ?? "";
    this.gitDetector = params.gitDetector ?? defaultGitChangeDetector;
    this.availableAgentKinds = params.availableAgentKinds;
    this.dryRun = params.dryRun;
    this.statePath = params.dryRun ? null : (params.statePath ?? null);
    this.events = params.events ?? null;
    this.timers = params.timers ?? realTimers;
    this.reactors = new ReactorRegistry<DispatcherWakeContext>(
      [
        createDispatcherWakeReactor({
          projectChannelPrefix: this.swarm.board.projectChannelPrefix,
        }),
        createProjectsReloadReactor({ projectsConfigPath: this.projectsConfigPath }),
        ...createConfiguredReactors(this.swarm.reactors, "dispatcher"),
        ...(params.extraReactors ?? []),
      ],
      log,
    );
    this.configuredEffects = createConfiguredEffectHandlers({
      board: this.board,
      log,
      dryRun: this.dryRun,
      runner: params.commandRunner,
    });
    if (this.projectsConfigPath && existsSync(this.projectsConfigPath)) {
      this.lastProjectsMtimeMs = statSync(this.projectsConfigPath).mtimeMs;
    }
    this.restoreState();
  }

  requestStop(): void {
    this.stopping = true;
    this.stopController.abort();
  }

  /** Pane, tab, and group/session IDs of every tracked session (active and parked). */
  private getTrackedRuntimeIds(): {
    panes: Set<string>;
    tabs: Set<string>;
    groups: Set<string>;
  } {
    const panes = new Set<string>();
    const tabs = new Set<string>();
    const groups = new Set<string>();
    const add = (task: ActiveTask): void => {
      if (task.ctx.workspaceId) groups.add(task.ctx.workspaceId);
      const impl = getImplHandle(task.phase);
      const rev = getReviewerHandle(task.phase);
      for (const h of rev ? [impl, rev] : [impl]) {
        if (h.paneId) panes.add(h.paneId);
        if (h.tabId) tabs.add(h.tabId);
      }
    };
    for (const task of this.activeWorkers.values()) add(task);
    for (const parked of this.parkedTabs.values()) {
      add(parked.task);
      if (parked.tabId) tabs.add(parked.tabId);
      if (parked.workspaceId) groups.add(parked.workspaceId);
    }
    return { panes, tabs, groups };
  }

  /** Periodic reconcile interval for the current source health and workload. */
  currentIntervalMs(): number {
    const defaults = this.swarm.workerDefaults;
    return selectReconcileIntervalMs({
      sourcesHealthy: this.events?.health.allHealthy ?? false,
      // Idle reminders and lease renewals are clock-driven, so keep the poll cadence while working.
      timeSensitiveWork: this.activeWorkers.size > 0,
      pollMs: defaults.pollIntervalSeconds * 1000,
      reconcileMs: (defaults.reconcileIntervalSeconds ?? DEFAULT_RECONCILE_INTERVAL_SECONDS) * 1000,
    });
  }

  /** Bus subscriber: track source health and wake the scheduler for relevant events. */
  handleEvent(event: SwarmEvent): void {
    if (event.kind === "source.health") {
      if (this.events?.health.apply(event)) {
        log(
          event.healthy ? "INFO" : "WARN",
          describeHealth(this.events.health, this.currentIntervalMs()),
        );
        this.scheduler?.refreshInterval();
      }
      return;
    }
    const { panes, tabs } = this.getTrackedRuntimeIds();
    const effects = this.reactors.collect(event, {
      trackedTaskIds: this.getTrackedTaskIds(),
      trackedPaneIds: panes,
      trackedTabIds: tabs,
    });
    if (effects.length > 0) void executeEffects(effects, this.effectHandlers(), log);
  }

  /** How this dispatcher runs reactor effects (Lead-only effects are not handled here). */
  private effectHandlers(): EffectHandlers {
    return {
      ...this.configuredEffects,
      wake: (effect) => this.scheduler?.wake(effect.reason),
      // The tick's mtime check decides whether projects.json really changed.
      projects_reload: () => this.scheduler?.wake("projects_reload"),
    };
  }

  /** Keeps per-pane (Herdr) and per-session (Rex) event subscriptions in line with tracked tasks. */
  private syncPaneSubscriptions(): void {
    const { panes, groups } = this.getTrackedRuntimeIds();
    this.events?.paneWatcher?.setWatchedPanes(panes);
    this.events?.sessionWatcher?.setWatchedSessions(groups);
  }

  /**
   * Loads persisted tracking. Loading never closes tabs or touches Board tasks: restored entries
   * go through the normal reconcile on the next tick, where the FSMs decide what to do.
   */
  private restoreState(): void {
    if (!this.statePath) return;
    let res: ReturnType<typeof loadDispatcherState>;
    try {
      res = loadDispatcherState(this.statePath, { machine: this.machineName });
    } catch (err) {
      log(
        "WARN",
        `Could not load dispatcher state ${this.statePath}; starting empty: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    switch (res.kind) {
      case "missing":
        log("INFO", `No dispatcher state at ${this.statePath}; starting empty.`);
        break;
      case "other_machine":
        log(
          "WARN",
          `Ignoring dispatcher state ${this.statePath}: written for machine "${res.machine}", not "${this.machineName}". It will be overwritten on the next save; give each machine its own DISPATCHER_STATE_PATH.`,
        );
        break;
      case "quarantined":
        log(
          "WARN",
          `Dispatcher state ${this.statePath} was invalid; moved it to ${res.quarantinePath} and starting empty:\n${res.error}`,
        );
        break;
      case "loaded":
        for (const [id, task] of res.state.activeWorkers) this.activeWorkers.set(id, task);
        for (const [id, parked] of res.state.parkedTabs) this.parkedTabs.set(id, parked);
        log(
          "INFO",
          `Restored ${this.activeWorkers.size} active and ${this.parkedTabs.size} parked task(s) from ${this.statePath} (saved ${new Date(res.savedAtMs).toISOString()}).`,
        );
        break;
      default:
        assertNever(res);
    }
    this.lastPersistedFingerprint = dispatcherStateFingerprint(this, this.machineName);
  }

  /** Atomically writes tracked state when it changed since the last write. */
  persistState(): void {
    if (!this.statePath) return;
    const fingerprint = dispatcherStateFingerprint(this, this.machineName);
    if (fingerprint === this.lastPersistedFingerprint) return;
    try {
      saveDispatcherState(this.statePath, toPersisted(this, this.machineName, Date.now()));
      this.lastPersistedFingerprint = fingerprint;
    } catch (err) {
      log(
        "WARN",
        `Failed to persist dispatcher state to ${this.statePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private getEffectDeps(): EffectExecutorDeps {
    return {
      swarm: this.swarm,
      machineName: this.machineName,
      board: this.board,
      runtime: this.runtime,
      worktreeManager: this.worktreeManager,
      activeWorkers: this.activeWorkers,
      parkedTabs: this.parkedTabs,
      getReviewerPromptTemplate: () => this.getReviewerPromptTemplate(),
      log,
    };
  }

  private getPromptTemplate(): string {
    const promptPath = resolve(this.repoRoot, "prompts/worker-prompt.md");
    return existsSync(promptPath) ? readFileSync(promptPath, "utf8") : this.promptTemplate;
  }

  private getReviewerPromptTemplate(): string {
    const promptPath = resolve(this.repoRoot, "prompts/reviewer-prompt.md");
    return existsSync(promptPath) ? readFileSync(promptPath, "utf8") : this.reviewerPromptTemplate;
  }

  private async maybeReloadProjectsAndPublishRegistry(): Promise<void> {
    let projectsChanged = false;
    if (this.projectsConfigPath && existsSync(this.projectsConfigPath)) {
      const mtimeMs = statSync(this.projectsConfigPath).mtimeMs;
      if (mtimeMs !== this.lastProjectsMtimeMs) {
        try {
          this.projects = loadProjectsConfig(this.repoRoot, this.projectsConfigPath);
          this.lastProjectsMtimeMs = mtimeMs;
          projectsChanged = true;
          log(
            "INFO",
            `Hot-reloaded ${this.projectsConfigPath} (${Object.keys(this.projects.projects).length} project(s)).`,
          );
        } catch (err) {
          log(
            "WARN",
            `Failed to hot-reload ${this.projectsConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (this.dryRun || (this.registryPublishedOnce && !projectsChanged)) {
      return;
    }

    try {
      const entry = buildMachineRegistryEntry({
        swarm: this.swarm,
        projects: this.projects,
        machineName: this.machineName,
        availableAgentKinds: this.availableAgentKinds,
      });
      const res = await publishMachineRegistry({
        board: this.board,
        registryChannel: this.swarm.board.registryChannel,
        entry,
      });
      this.registryPublishedOnce = true;
      if (res.action !== "unchanged") {
        log(
          "INFO",
          `Published machine registry to #${this.swarm.board.registryChannel} (${res.action}, projects=[${entry.projects.map((p) => p.slug).join(",")}]).`,
        );
      }
    } catch (err) {
      log(
        "WARN",
        `Failed to publish machine registry to #${this.swarm.board.registryChannel}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private getBusyPlainTabProjects(): Set<string> {
    const busy = new Set<string>();
    for (const task of this.activeWorkers.values()) {
      if (!task.ctx.useWorktree) busy.add(task.ctx.projectSlug);
    }
    for (const parked of this.parkedTabs.values()) {
      if (!parked.useWorktree) busy.add(parked.projectSlug);
    }
    return busy;
  }

  private getTrackedTaskIds(): Set<string> {
    const ids = new Set<string>();
    for (const id of this.activeWorkers.keys()) ids.add(id);
    for (const id of this.parkedTabs.keys()) ids.add(id);
    return ids;
  }

  /** Pane IDs of any active session currently waiting in `awaiting_prompt`. */
  private getAwaitingPromptPaneIds(): Set<string> {
    const ids = new Set<string>();
    for (const task of this.activeWorkers.values()) {
      if (task.phase.kind === "reviewing") {
        if (task.phase.reviewer.lifecycle.kind === "awaiting_prompt") {
          ids.add(task.phase.reviewer.handle.paneId);
        }
      } else if (task.phase.impl.lifecycle.kind === "awaiting_prompt") {
        ids.add(task.phase.impl.handle.paneId);
      }
    }
    return ids;
  }

  async tick(): Promise<void> {
    const awaitingBefore = this.getAwaitingPromptPaneIds();
    try {
      await this.runTick();
    } finally {
      this.persistState();
      // Covers spawns, adoptions, and sessions restored from the state file.
      this.syncPaneSubscriptions();
      // A fast-starting Rex agent may emit its initial `idle` before `rex events -s <session>`
      // finishes attaching; schedule one debounced check so it never waits for the poll interval.
      if (this.runtime.kind === "rex") {
        for (const paneId of this.getAwaitingPromptPaneIds()) {
          if (!awaitingBefore.has(paneId)) {
            this.scheduler?.wake("rex_awaiting_prompt");
            break;
          }
        }
      }
    }
  }

  private async runTick(): Promise<void> {
    const machineCfg = this.swarm.machines[this.machineName];
    if (!machineCfg) {
      throw new Error(`Missing machine config for "${this.machineName}"`);
    }

    await this.maybeReloadProjectsAndPublishRegistry();

    const prefix = this.swarm.board.projectChannelPrefix;
    const openTasks = await this.board.listTasks(prefix, { state: "open", limit: TASK_PAGE_SIZE });
    const tasksById = new Map<string, BoardTask>();
    for (const t of openTasks) tasksById.set(t.id, t);
    await this.lookupTrackedTasksMissingFromOpenList(tasksById);

    // Tasks reconcile finishes this tick still look `claimed` in the (pre-reconcile) list;
    // remember them so the orphan sweep does not mistake them for orphans.
    const trackedAtTickStart = this.getTrackedTaskIds();
    if (this.activeWorkers.size > 0 || this.parkedTabs.size > 0) {
      await this.reconcileRunningWorkers(tasksById);
    }

    await this.sweepOrphans(openTasks, trackedAtTickStart);

    if (this.stopping) return;

    const availableSlots = machineCfg.maxWorkers - this.activeWorkers.size;
    if (availableSlots <= 0) return;

    if (
      this.parkedTabs.size >= this.swarm.workerDefaults.maxParkedTabs &&
      this.swarm.workerDefaults.maxParkedTabs > 0
    ) {
      log(
        "WARN",
        `Parked tab cap reached (${this.parkedTabs.size}/${this.swarm.workerDefaults.maxParkedTabs}); skipping new claims until blocked/failed tabs are closed in Sheprd.`,
      );
      return;
    }

    const readyTasks = openTasks.filter((t) => t.state === "ready");
    if (readyTasks.length === 0) return;

    const { candidates, skips } = selectEligibleTasks({
      tasks: readyTasks,
      swarm: this.swarm,
      projects: this.projects,
      machineName: this.machineName,
      busyPlainTabProjects: this.getBusyPlainTabProjects(),
      alreadyTrackedTaskIds: this.getTrackedTaskIds(),
      availableAgentKinds: this.availableAgentKinds,
    });

    if (this.dryRun) {
      for (const skip of skips) {
        log("INFO", `[dry-run] Skip task #${skip.taskId}: ${skip.reason}`);
      }
    }

    let slotsLeft = availableSlots;
    const claimedProjectsThisTick = new Set<string>();

    for (const candidate of candidates) {
      if (slotsLeft <= 0 || this.stopping) break;
      if (!candidate.useWorktree && claimedProjectsThisTick.has(candidate.projectSlug)) continue;

      if (!existsSync(candidate.repoPath)) {
        log(
          "WARN",
          `Skipping task #${candidate.task.id}: repo path does not exist locally (${candidate.repoPath})`,
        );
        continue;
      }

      if (this.dryRun) {
        const revLabel =
          candidate.reviewer.enabled && candidate.reviewer.runtime
            ? ` reviewer=${candidate.reviewer.runtime.profileName}${candidate.reviewer.runtime.model ? `(${candidate.reviewer.runtime.model})` : ""}`
            : " reviewer=off";
        log(
          "INFO",
          `[dry-run] Would claim #${candidate.task.id} (${candidate.task.channel}) -> ${candidate.repoPath} using agent=${candidate.runtime.profileName} (${candidate.runtime.kind} ${candidate.runtime.cliArgs.join(" ")})${revLabel}`,
        );
        slotsLeft -= 1;
        if (!candidate.useWorktree) claimedProjectsThisTick.add(candidate.projectSlug);
        continue;
      }

      const spawned = await this.claimAndSpawn(candidate);
      if (spawned) {
        slotsLeft -= 1;
        if (!candidate.useWorktree) claimedProjectsThisTick.add(candidate.projectSlug);
      }
    }
  }

  /**
   * The open-task list omits terminal tasks (completed/canceled/failed), so a tracked task that
   * dropped out of it is resolved with a point lookup. Without this, a finished task would sit
   * forever as `unknown` with its tab open and its repo lock held.
   */
  private async lookupTrackedTasksMissingFromOpenList(
    tasksById: Map<string, BoardTask>,
  ): Promise<void> {
    const missing = [...this.getTrackedTaskIds()].filter((id) => !tasksById.has(id));
    if (missing.length === 0) return;

    const results = await Promise.all(
      missing.map(async (id) => {
        try {
          return { id, task: await this.board.getTask(id), error: null };
        } catch (err) {
          return { id, task: null, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );

    for (const { id, task, error } of results) {
      if (task && task.state !== "unknown") {
        tasksById.set(id, task);
        continue;
      }
      log(
        "WARN",
        `Tracked task #${id} is not in the open-task list and its state could not be resolved (${error ?? "lookup returned no task state"}); treating it as unknown this tick.`,
      );
    }
  }

  /**
   * Recovers tasks the Board says this machine holds but nothing tracks (no or corrupt state
   * file). Decisions come from the pure `decideOrphan`; this only runs the I/O.
   */
  private async sweepOrphans(
    openTasks: readonly BoardTask[],
    trackedAtTickStart: ReadonlySet<string>,
  ): Promise<void> {
    const tracked = new Set([...trackedAtTickStart, ...this.getTrackedTaskIds()]);
    const orphans = findUntrackedOwnClaims(openTasks, tracked, this.machineName);
    if (orphans.length === 0) return;

    const machineConfig = this.swarm.machines[this.machineName];
    if (!machineConfig) return;

    let agents: LiveAgent[];
    try {
      agents = await this.runtime.listLiveAgents();
    } catch (err) {
      // Never release work because the runtime was briefly unreachable
      log(
        "WARN",
        `Orphan sweep skipped: could not list ${this.runtime.kind} agents (${err instanceof Error ? err.message : String(err)}); ${orphans.length} untracked claim(s) left for next tick.`,
      );
      return;
    }

    for (const orphan of orphans) {
      if (this.stopping) return;
      const routing = resolveTaskRouting({
        task: orphan.task,
        swarm: this.swarm,
        projects: this.projects,
        machineName: this.machineName,
        machineConfig,
        availableAgentKinds: this.availableAgentKinds,
      });
      const decision = decideOrphan(orphan, agents, routing);
      if (this.dryRun) {
        log("INFO", `[dry-run] Orphan sweep would ${decision.kind} task #${orphan.task.id}.`);
        continue;
      }
      await this.applyOrphanDecision(decision);
    }
  }

  private async applyOrphanDecision(decision: OrphanDecision): Promise<void> {
    const { orphan } = decision;
    const taskId = orphan.task.id;
    const nowMs = Date.now();

    switch (decision.kind) {
      case "skip":
        log("WARN", `Orphan sweep left task #${taskId} alone: ${decision.reason}.`);
        return;

      case "release": {
        log(
          "WARN",
          `Task #${taskId} is claimed by ${orphan.boardProfile} but untracked and no live ${orphan.implAgentName} agent exists; releasing it.`,
        );
        await this.board
          .reply(
            taskId,
            `Dispatcher on \`${this.machineName}\` restarted without a record of this task and found no live \`${orphan.implAgentName}\` agent, so it released the task so it can be claimed again.`,
            { asProfile: orphan.boardProfile },
          )
          .catch(() => {});
        await this.board.releaseTask(taskId, { asProfile: orphan.boardProfile }).catch((err) => {
          log(
            "WARN",
            `Failed to release orphaned task #${taskId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        return;
      }

      case "adopt":
      case "park_in_review": {
        const thread = await this.board.readThread(taskId).catch((err) => {
          log(
            "WARN",
            `Orphan sweep could not read thread #${taskId} (${err instanceof Error ? err.message : String(err)}); retrying next tick.`,
          );
          return null;
        });
        if (!thread) return;

        const task = buildAdoptedTask({
          orphan,
          routing: decision.routing,
          impl: decision.impl,
          replyIds: thread.replies.map((r) => r.id),
          machineName: this.machineName,
          humanHandle: this.swarm.board.humanHandle,
          runtimeKind: this.runtime.kind,
          nowMs,
        });

        if (decision.kind === "adopt") {
          this.activeWorkers.set(taskId, task);
          log(
            "INFO",
            `Adopted orphaned task #${taskId}: live agent ${decision.impl.name} in ${decision.impl.tabId} (implementing, ${thread.replies.length} existing repl(ies) marked seen).`,
          );
          return;
        }

        // A reviewer is live too, and we cannot know the round: hand it to a human.
        try {
          await this.board.blockTask(
            taskId,
            `Dispatcher on ${this.machineName} restarted mid-review without state; inspect tabs in ${this.runtime.uiName}.`,
            { asProfile: orphan.boardProfile, kind: "needs_input" },
          );
        } catch (err) {
          log(
            "WARN",
            `Could not block orphaned in-review task #${taskId} (${err instanceof Error ? err.message : String(err)}); retrying next tick.`,
          );
          return;
        }
        const label = blockedAdoptionLabel(task);
        const implRef = buildSessionRef({
          runtime: this.runtime.kind,
          groupId: decision.impl.workspaceId,
          tabId: decision.impl.tabId,
          paneId: decision.impl.paneId,
          agentName: decision.impl.name,
        });
        await this.runtime.rename(implRef, label).catch(() => {});
        await this.board
          .reply(
            taskId,
            `Dispatcher on \`${this.machineName}\` restarted without a record of this task while reviewer \`${decision.reviewerAgentName}\` was still running, so it cannot tell which review round this is. It blocked the task and parked the implementer tab \`${label}\` in workspace \`${decision.routing.projectSlug}\` for a human (${this.swarm.board.humanHandle} @lead). Check both tabs in ${this.runtime.uiName} before unblocking.`,
            { asProfile: orphan.boardProfile },
          )
          .catch(() => {});
        this.parkedTabs.set(taskId, buildParkedAdoption(task, nowMs));
        log(
          "WARN",
          `Orphaned task #${taskId} has live implementer ${decision.impl.name} and reviewer ${decision.reviewerAgentName}; blocked it and parked ${decision.impl.tabId}.`,
        );
        return;
      }

      default:
        assertNever(decision);
    }
  }

  private async claimAndSpawn(candidate: CandidateTask): Promise<boolean> {
    const { task, projectSlug, project, repoPath, useWorktree, runtime, reviewer } = candidate;
    const shortId = shortTaskId(task.id);
    const boardProfile = `worker-${this.machineName}-${shortId}`;

    try {
      await this.board.claimTaskById(task.id, {
        asProfile: boardProfile,
        lease: this.swarm.board.leaseDuration,
      });
    } catch (err) {
      log(
        "WARN",
        `Could not claim task #${task.id} (likely claimed by another host): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }

    const revDesc =
      reviewer.enabled && reviewer.runtime
        ? ` | reviewer=${reviewer.runtime.profileName}${reviewer.runtime.model ? ` (${reviewer.runtime.model})` : ""}`
        : "";
    log(
      "INFO",
      `Claimed task #${task.id} (${task.channel}) as ${boardProfile} -> agent=${runtime.profileName} (${runtime.kind} ${runtime.cliArgs.join(" ")})${revDesc}`,
    );

    const env = buildBoardEnv(this.swarm, boardProfile);
    const tabLabel = formatTabLabel(task.id, runtime.profileName);
    const agentName = sanitizeAgentName("w", shortId);
    const branch = `task/${shortId}`;
    let createdWorktreePath: string | undefined;

    try {
      const startHeadSha = reviewer.enabled ? this.gitDetector.captureHeadSha(repoPath) : null;
      const phaseSeenReplyIds = new Set<string>();
      if (reviewer.enabled) {
        const existingThread = await this.board.readThread(task.id).catch(() => null);
        if (existingThread) {
          for (const reply of existingThread.replies) phaseSeenReplyIds.add(reply.id);
        }
      }

      let spawnCwd = repoPath;
      let nativeWorktree: { branch: string; base?: string } | undefined;
      if (useWorktree) {
        if (this.runtime.kind === "rex") {
          const wt = await this.worktreeManager.create({
            repoPath,
            projectSlug,
            shortId,
            branch,
            baseBranch: project.baseBranch,
            worktreeRoot: this.swarm.workerDefaults.worktreeRoot,
          });
          createdWorktreePath = wt.worktreePath;
          spawnCwd = wt.worktreePath;
        } else {
          nativeWorktree = { branch, base: project.baseBranch };
        }
      }

      const promptText = renderWorkerPrompt(this.getPromptTemplate(), {
        taskId: task.id,
        channel: task.channel,
        project: projectSlug,
        boardProfile,
        branch,
        baseBranch: project.baseBranch,
        agentProfile: runtime.profileName,
        humanHandle: this.swarm.board.humanHandle,
        review: reviewer.enabled
          ? {
              enabled: true,
              reviewerProfile: reviewer.runtime?.profileName,
              maxRounds: reviewer.maxRounds,
            }
          : { enabled: false },
      });

      const spawnRes = await this.runtime.spawn({
        group: projectSlug,
        cwd: spawnCwd,
        label: tabLabel,
        env,
        agent: {
          name: agentName,
          kind: runtime.kind,
          args: runtime.cliArgs,
        },
        worktree: nativeWorktree,
        timeoutMs: 60_000,
      });

      const nowMs = Date.now();
      const implHandle: SessionHandle = {
        boardProfile,
        runtime,
        tabId: spawnRes.ref.tabId,
        paneId: spawnRes.ref.paneId,
        agentName,
        startedAtMs: nowMs,
      };

      const activeTask: ActiveTask = {
        ctx: {
          taskId: task.id,
          channel: task.channel,
          projectSlug,
          repoPath,
          baseBranch: project.baseBranch,
          branch,
          useWorktree,
          ...(createdWorktreePath ? { worktreePath: createdWorktreePath } : {}),
          runtimeKind: this.runtime.kind,
          workspaceId: spawnRes.ref.groupId,
          boardProfile,
          reviewConfig: reviewer,
          startHeadSha,
          machineName: this.machineName,
          humanHandle: this.swarm.board.humanHandle,
        },
        phase: {
          kind: "implementing",
          impl: createManagedSession(implHandle, {
            promptText,
            blockedOnStartup: spawnRes.blockedOnStartup,
            promptNow: spawnRes.promptNow,
          }),
        },
        lastLeaseRenewMs: nowMs,
        phaseSeenReplyIds,
        lastImplSummary: `Completed task #${task.id}`,
      };

      this.activeWorkers.set(task.id, activeTask);

      if (spawnRes.blockedOnStartup) {
        log(
          "WARN",
          `Worker ${agentName} for task #${task.id} hit an interactive prompt on startup; marking tab [BLOCKED] for ${this.runtime.uiName}.`,
        );
        const blockedLabel = formatTabLabel(task.id, runtime.profileName, "BLOCKED");
        await this.runtime.rename(spawnRes.ref, blockedLabel).catch(() => {});
        await this.board
          .reply(
            task.id,
            `Worker (${runtime.profileName}) paused on startup prompt in ${this.runtime.uiName} on \`${this.machineName}\` (workspace \`${projectSlug}\`, tab \`${blockedLabel}\`). Approve/dismiss it in ${this.runtime.uiName} to continue.`,
            { asProfile: boardProfile },
          )
          .catch(() => {});
      } else if (spawnRes.promptNow) {
        await this.runtime.prompt(spawnRes.ref, promptText);
        log(
          "INFO",
          `Spawned ${agentName} (${runtime.kind}) in ${spawnRes.ref.tabId} and delivered task #${task.id} prompt.`,
        );
      } else {
        log(
          "INFO",
          `Spawned ${agentName} (${runtime.kind}) in ${spawnRes.ref.tabId} (${this.runtime.kind}); awaiting ready state before delivering task #${task.id} prompt.`,
        );
      }

      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log("ERROR", `Failed to spawn worker for task #${task.id}: ${detail}`);
      if (createdWorktreePath) {
        await this.worktreeManager
          .remove({ repoPath, worktreePath: createdWorktreePath, branch })
          .catch(() => {});
      }
      await this.board
        .reply(
          task.id,
          `Dispatcher on \`${this.machineName}\` failed to spawn \`${runtime.profileName}\` worker and released the task:\n\`\`\`\n${detail.slice(0, 600)}\n\`\`\``,
          { asProfile: boardProfile },
        )
        .catch(() => {});
      await this.board.releaseTask(task.id, { asProfile: boardProfile }).catch(() => {});
      return false;
    }
  }

  private async observeThreadSignal(
    task: ActiveTask,
    boardTask: BoardTask | undefined,
    liveImpl: LiveAgent | null,
    liveReviewer: LiveAgent | null,
  ): Promise<ThreadSignal> {
    if (!task.ctx.reviewConfig.enabled || boardTask?.state !== "claimed") {
      return { kind: "none" };
    }

    const maybeNewReplies = (boardTask.replyCount ?? Infinity) > task.phaseSeenReplyIds.size;

    if (task.phase.kind === "reviewing") {
      const revSession = task.phase.reviewer;
      if (revSession.lifecycle.kind === "awaiting_prompt") return { kind: "none" };
      const revIdleOrGone =
        liveReviewer === null || liveReviewer.status === "idle" || liveReviewer.status === "done";
      if (!maybeNewReplies && !revIdleOrGone) return { kind: "none" };

      const thread = await this.board.readThread(task.ctx.taskId).catch((err) => {
        log(
          "WARN",
          `Failed to read Board thread #${task.ctx.taskId} for reviewer verdict: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      });
      if (!thread) return { kind: "none" };

      const verdictMatch = findReviewVerdictReply(
        thread.replies,
        task.phaseSeenReplyIds,
        revSession.handle.boardProfile,
      );
      if (!verdictMatch) return { kind: "none" };

      return {
        kind: "verdict",
        verdict: verdictMatch.verdict,
        summary: verdictMatch.summary,
        allReplyIds: thread.replies.map((r) => r.id),
      };
    }

    // implementing or fixing
    if (task.phase.impl.lifecycle.kind === "awaiting_prompt") return { kind: "none" };
    const implIdle =
      liveImpl !== null && (liveImpl.status === "idle" || liveImpl.status === "done");
    if (!maybeNewReplies && !implIdle) return { kind: "none" };

    const thread = await this.board.readThread(task.ctx.taskId).catch((err) => {
      log(
        "WARN",
        `Failed to read Board thread #${task.ctx.taskId} for review handoff: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    });
    if (!thread) return { kind: "none" };

    const reviewerProfileName = `reviewer-${this.machineName}-${shortTaskId(task.ctx.taskId)}`;
    const readyMatch = findReadyForReviewReply(
      thread.replies,
      task.phaseSeenReplyIds,
      reviewerProfileName,
    );
    if (!readyMatch) return { kind: "none" };

    const reviewCwd = task.ctx.useWorktree
      ? (task.ctx.worktreePath ?? liveImpl?.cwd ?? task.ctx.repoPath)
      : task.ctx.repoPath;
    const gitCheck = this.gitDetector.detectChanges(
      reviewCwd,
      task.ctx.startHeadSha,
      task.ctx.baseBranch,
    );

    return {
      kind: "ready_for_review",
      summary: readyMatch.summary,
      allReplyIds: thread.replies.map((r) => r.id),
      hasGitChanges: gitCheck.hasChanges,
      gitDetail: gitCheck.detail,
      reviewCwd,
    };
  }

  private collectTrackedSnapshotRefs(): SnapshotRef[] {
    const byPane = new Map<string, SnapshotRef>();
    const addTask = (task: ActiveTask): void => {
      const impl = getImplHandle(task.phase);
      const rev = getReviewerHandle(task.phase);
      for (const h of rev ? [impl, rev] : [impl]) {
        if (!byPane.has(h.paneId)) {
          byPane.set(h.paneId, {
            runtime: this.runtime.kind,
            groupId: task.ctx.workspaceId,
            tabId: h.tabId,
            paneId: h.paneId,
            agentName: h.agentName,
            startedAtMs: h.startedAtMs,
          });
        }
      }
    };
    for (const task of this.activeWorkers.values()) addTask(task);
    for (const parked of this.parkedTabs.values()) addTask(parked.task);
    return [...byPane.values()];
  }

  private async reconcileRunningWorkers(tasksById: Map<string, BoardTask>): Promise<void> {
    const refs = this.collectTrackedSnapshotRefs();
    const snapshot = await this.runtime.snapshot(refs);
    const { tabIds, agentsByPane } = snapshot;

    const nowMs = Date.now();
    const leaseRenewIntervalMs = this.swarm.board.leaseRenewIntervalSeconds * 1000;
    const idleTimeoutMs = this.swarm.workerDefaults.idleTimeoutSeconds * 1000;
    const startupTimeoutMs =
      (this.swarm.workerDefaults.startupTimeoutSeconds ?? DEFAULT_STARTUP_TIMEOUT_SECONDS) * 1000;
    const deps = this.getEffectDeps();

    // Reconcile parked tabs (auto-close completed/canceled, unpark resumed, prune manually closed)
    for (const [taskId, parked] of this.parkedTabs.entries()) {
      const boardTask = tasksById.get(taskId);
      const implHandle = getImplHandle(parked.task.phase);
      const revHandle = getReviewerHandle(parked.task.phase);
      const parkedPaneId =
        revHandle && parked.tabId === revHandle.tabId ? revHandle.paneId : implHandle.paneId;

      const outcome = stepParkedTab(parked, {
        boardState: boardTask?.state ?? "unknown",
        boardAssignee: boardTask?.assignee,
        parkedTabExists: tabIds.has(parked.tabId),
        implTabExists: tabIds.has(implHandle.tabId),
        reviewerTabExists: revHandle ? tabIds.has(revHandle.tabId) : false,
        parkedAgentAlive: agentsByPane.has(parkedPaneId),
        nowMs,
      });

      await applyParkedTabOutcome(deps, parked, outcome, nowMs);
    }

    for (const task of this.activeWorkers.values()) {
      const boardTask = tasksById.get(task.ctx.taskId);
      const implHandle = getImplHandle(task.phase);
      const revHandle = getReviewerHandle(task.phase);

      const liveImpl = agentsByPane.get(implHandle.paneId) ?? null;
      const liveReviewer = revHandle ? (agentsByPane.get(revHandle.paneId) ?? null) : null;
      const signal = await this.observeThreadSignal(task, boardTask, liveImpl, liveReviewer);

      const outcome = stepTask(task, {
        boardState: boardTask?.state ?? "unknown",
        boardAssignee: boardTask?.assignee,
        implTabExists: tabIds.has(implHandle.tabId),
        implAgentStatus: liveImpl?.status ?? null,
        reviewerTabExists: revHandle ? tabIds.has(revHandle.tabId) : false,
        reviewerAgentStatus: liveReviewer?.status ?? null,
        signal,
        nowMs,
        leaseRenewIntervalMs,
        idleTimeoutMs,
        startupGraceMs: STARTUP_GRACE_MS,
        startupTimeoutMs,
      });

      await applyTaskStepOutcome(deps, task, outcome, nowMs);
    }
  }

  async runLoop(once: boolean): Promise<void> {
    const machineCfg = this.swarm.machines[this.machineName];
    if (!machineCfg) {
      throw new Error(`Unknown machine "${this.machineName}"`);
    }

    const resolvedRuntime = resolveMachineRuntime(machineCfg);
    const runtimeDesc =
      resolvedRuntime.kind === "herdr" ? `herdr(${resolvedRuntime.target})` : "rex";
    log(
      "INFO",
      `Starting Worker Dispatcher on "${this.machineName}" (runtime=${runtimeDesc}, maxWorkers=${machineCfg.maxWorkers}, defaultAgent=${this.swarm.workerDefaults.defaultAgent}, installedAgents=[${[...this.availableAgentKinds].join(",")}], dryRun=${this.dryRun})`,
    );

    if (!once) log("INFO", describeReactors("Dispatcher", this.reactors.names));

    if (machineCfg.maxWorkers <= 0 && !this.dryRun) {
      log(
        "WARN",
        `maxWorkers is 0 for "${this.machineName}"; dispatcher will idle without claiming tasks.`,
      );
    }

    if (once) {
      try {
        await this.tick();
      } catch (err) {
        log("ERROR", `Dispatcher tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (!this.stopping) {
      // Ticks run on wake-ups from live events (debounced) plus a periodic reconcile; with no
      // healthy source the period is pollIntervalSeconds, i.e. the old polling loop.
      const scheduler = new WakeScheduler({
        run: () => this.tick(),
        intervalMs: () => this.currentIntervalMs(),
        timers: this.timers,
        onError: (err) =>
          log(
            "ERROR",
            `Dispatcher tick failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
      });
      this.scheduler = scheduler;
      const unsubscribe = this.events?.bus.subscribe((event) => this.handleEvent(event));
      const stopped = new Promise<void>((resolveStop) => {
        if (this.stopController.signal.aborted) resolveStop();
        else
          this.stopController.signal.addEventListener("abort", () => resolveStop(), { once: true });
      });
      scheduler.start();
      await stopped;
      unsubscribe?.();
      await scheduler.stop();
      this.scheduler = null;
    }

    // Graceful stop: persist and exit. Tabs stay open and claims stay held so agents keep working
    // across a restart; the next dispatcher adopts them from the state file.
    this.persistState();
    log(
      "INFO",
      `Dispatcher stopped cleanly (activeWorkers=${this.activeWorkers.size}, parkedTabs=${this.parkedTabs.size}; tabs and claims left in place${this.statePath ? `, state saved to ${this.statePath}` : ""}).`,
    );
  }
}

async function main(): Promise<void> {
  const flags = parseCliFlags(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");

  const swarm = loadSwarmConfig(repoRoot);
  const projectsConfigPath =
    process.env.PROJECTS_CONFIG_PATH ?? resolve(repoRoot, "config/projects.json");
  const projects = loadProjectsConfigOptional(repoRoot, projectsConfigPath);
  const machineName = resolveCurrentMachineName(swarm, flags.machine, "worker");
  const machineCfg = swarm.machines[machineName];
  if (!machineCfg) {
    throw new Error(`Machine "${machineName}" not found in config/swarm.json`);
  }

  const promptPath = resolve(repoRoot, "prompts/worker-prompt.md");
  const promptTemplate = readFileSync(promptPath, "utf8");
  const reviewerPromptPath = resolve(repoRoot, "prompts/reviewer-prompt.md");
  const reviewerPromptTemplate = existsSync(reviewerPromptPath)
    ? readFileSync(reviewerPromptPath, "utf8")
    : "";

  const board = new BoardClient({
    url: swarm.board.url,
    scope: swarm.board.scope,
    boardName: swarm.board.boardName,
    binary: process.env.BOARD_CLI_BIN,
    onWarn: (message) => log("WARN", message),
  });
  const once = flags.once;
  const machineRuntime = resolveMachineRuntime(machineCfg);
  const sources = once
    ? null
    : createDaemonEventSources({
        swarm,
        board,
        herdrTarget: machineCfg.herdrTarget,
        machineRuntime,
        // The dispatcher only acts on project queues, so it tails just that prefix.
        tailChannel: swarm.board.projectChannelPrefix,
        watchFiles: [projectsConfigPath],
        log,
      });

  const dispatcher = new SwarmDispatcher({
    repoRoot,
    swarm,
    projects,
    projectsConfigPath,
    machineName,
    board,
    events: sources ?? undefined,
    runtime: createWorkerRuntime(machineCfg),
    promptTemplate,
    reviewerPromptTemplate,
    availableAgentKinds: detectAvailableAgentKinds(swarm),
    dryRun: flags.dryRun,
    statePath: resolveDispatcherStatePath(machineName),
  });

  const onSignal = (sig: NodeJS.Signals) => {
    log("INFO", `Received ${sig}; stopping dispatcher after current cycle...`);
    dispatcher.requestStop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // Never leave a `board tail` child behind, even on an unexpected exit.
  process.on("exit", () => sources?.killNow());

  sources?.start();
  try {
    await dispatcher.runLoop(once);
  } finally {
    await sources?.stop();
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    log("ERROR", err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
