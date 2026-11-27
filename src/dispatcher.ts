import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardClient, type BoardTask } from "./lib/board.ts";
import {
  BUILTIN_AGENT_KINDS,
  loadProjectsConfig,
  loadProjectsConfigOptional,
  loadSwarmConfig,
  resolveCurrentMachineName,
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
  HerdrClient,
  sanitizeHerdrAgentName,
  type HerdrAgent,
  type HerdrTab,
} from "./lib/herdr.ts";
import { buildMachineRegistryEntry, publishMachineRegistry } from "./lib/registry.ts";
import {
  defaultGitChangeDetector,
  findReadyForReviewReply,
  findReviewVerdictReply,
  type GitChangeDetector,
} from "./lib/review.ts";
import {
  formatTabLabel,
  renderWorkerPrompt,
  selectEligibleTasks,
  shortTaskId,
  type CandidateTask,
} from "./lib/routing.ts";
import { createManagedSession, type SessionHandle } from "./lib/session-fsm.ts";
import {
  getImplHandle,
  getReviewerHandle,
  stepParkedTab,
  stepTask,
  type ActiveTask,
  type ThreadSignal,
} from "./lib/task-fsm.ts";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
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

export class SwarmDispatcher {
  readonly repoRoot: string;
  readonly swarm: SwarmConfig;
  projects: ProjectsConfig;
  readonly projectsConfigPath: string | null;
  readonly machineName: string;
  readonly board: BoardClient;
  readonly herdr: HerdrClient;
  readonly promptTemplate: string;
  readonly reviewerPromptTemplate: string;
  readonly gitDetector: GitChangeDetector;
  readonly availableAgentKinds: Set<string>;
  readonly dryRun: boolean;

  readonly activeWorkers = new Map<string, ActiveTask>();
  readonly parkedTabs = new Map<string, ParkedTab>();
  private stopping = false;
  private lastProjectsMtimeMs = 0;
  private registryPublishedOnce = false;

  constructor(params: {
    repoRoot: string;
    swarm: SwarmConfig;
    projects: ProjectsConfig;
    projectsConfigPath?: string;
    machineName: string;
    board: BoardClient;
    herdr: HerdrClient;
    promptTemplate: string;
    reviewerPromptTemplate?: string;
    gitDetector?: GitChangeDetector;
    availableAgentKinds: Set<string>;
    dryRun: boolean;
  }) {
    this.repoRoot = params.repoRoot;
    this.swarm = params.swarm;
    this.projects = params.projects;
    this.projectsConfigPath = params.projectsConfigPath ?? null;
    this.machineName = params.machineName;
    this.board = params.board;
    this.herdr = params.herdr;
    this.promptTemplate = params.promptTemplate;
    this.reviewerPromptTemplate = params.reviewerPromptTemplate ?? "";
    this.gitDetector = params.gitDetector ?? defaultGitChangeDetector;
    this.availableAgentKinds = params.availableAgentKinds;
    this.dryRun = params.dryRun;
    if (this.projectsConfigPath && existsSync(this.projectsConfigPath)) {
      this.lastProjectsMtimeMs = statSync(this.projectsConfigPath).mtimeMs;
    }
  }

  requestStop(): void {
    this.stopping = true;
  }

  private getEffectDeps(): EffectExecutorDeps {
    return {
      swarm: this.swarm,
      machineName: this.machineName,
      board: this.board,
      herdr: this.herdr,
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

  async tick(): Promise<void> {
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

    if (this.activeWorkers.size > 0 || this.parkedTabs.size > 0) {
      await this.reconcileRunningWorkers(tasksById);
    }

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
    const agentName = sanitizeHerdrAgentName("w", shortId);
    const branch = `task/${shortId}`;

    try {
      const startHeadSha = reviewer.enabled ? this.gitDetector.captureHeadSha(repoPath) : null;
      const phaseSeenReplyIds = new Set<string>();
      if (reviewer.enabled) {
        const existingThread = await this.board.readThread(task.id).catch(() => null);
        if (existingThread) {
          for (const reply of existingThread.replies) phaseSeenReplyIds.add(reply.id);
        }
      }

      const spawnedPane = useWorktree
        ? await this.herdr.createWorktree({
            cwd: repoPath,
            branch,
            base: project.baseBranch,
            label: tabLabel,
            env,
          })
        : await this.herdr.findOrCreateProjectTab({
            workspaceLabel: projectSlug,
            cwd: repoPath,
            tabLabel,
            env,
          });

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

      const startRes = await this.herdr.startAgent({
        name: agentName,
        kind: runtime.kind,
        paneId: spawnedPane.paneId,
        args: runtime.cliArgs,
        timeoutMs: 60_000,
      });

      const nowMs = Date.now();
      const implHandle: SessionHandle = {
        boardProfile,
        runtime,
        tabId: spawnedPane.tabId,
        paneId: spawnedPane.paneId,
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
          workspaceId: spawnedPane.workspaceId,
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
            blockedOnStartup: startRes.blockedOnStartup,
          }),
        },
        lastLeaseRenewMs: nowMs,
        phaseSeenReplyIds,
        lastImplSummary: `Completed task #${task.id}`,
      };

      this.activeWorkers.set(task.id, activeTask);

      if (startRes.blockedOnStartup) {
        log(
          "WARN",
          `Worker ${agentName} for task #${task.id} hit an interactive prompt on startup; marking tab [BLOCKED] for Sheprd.`,
        );
        const blockedLabel = formatTabLabel(task.id, runtime.profileName, "BLOCKED");
        await this.herdr.renameTab(spawnedPane.tabId, blockedLabel).catch(() => {});
        await this.board
          .reply(
            task.id,
            `Worker (${runtime.profileName}) paused on startup prompt in Sheprd on \`${this.machineName}\` (workspace \`${projectSlug}\`, tab \`${blockedLabel}\`). Approve/dismiss it in Sheprd to continue.`,
            { asProfile: boardProfile },
          )
          .catch(() => {});
      } else {
        await this.herdr.promptAgent(agentName, promptText);
        log(
          "INFO",
          `Spawned ${agentName} (${runtime.kind}) in ${spawnedPane.tabId} and delivered task #${task.id} prompt.`,
        );
      }

      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log("ERROR", `Failed to spawn worker for task #${task.id}: ${detail}`);
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
    liveImpl: HerdrAgent | null,
    liveReviewer: HerdrAgent | null,
  ): Promise<ThreadSignal> {
    if (!task.ctx.reviewConfig.enabled || boardTask?.state !== "claimed") {
      return { kind: "none" };
    }

    const maybeNewReplies = (boardTask.replyCount ?? Infinity) > task.phaseSeenReplyIds.size;

    if (task.phase.kind === "reviewing") {
      const revSession = task.phase.reviewer;
      if (revSession.lifecycle.kind === "awaiting_prompt") return { kind: "none" };
      const revIdleOrGone =
        liveReviewer === null ||
        liveReviewer.agent_status === "idle" ||
        liveReviewer.agent_status === "done";
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
      liveImpl !== null && (liveImpl.agent_status === "idle" || liveImpl.agent_status === "done");
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
      ? (liveImpl?.cwd ?? liveImpl?.foreground_cwd ?? task.ctx.repoPath)
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

  private async reconcileRunningWorkers(tasksById: Map<string, BoardTask>): Promise<void> {
    const [tabs, agents] = await Promise.all([
      this.herdr.listTabs().catch(() => [] as HerdrTab[]),
      this.herdr.listAgents().catch(() => [] as HerdrAgent[]),
    ]);

    const tabsById = new Map<string, HerdrTab>();
    for (const tab of tabs) tabsById.set(tab.tab_id, tab);

    const agentsByPaneId = new Map<string, HerdrAgent>();
    for (const agent of agents) agentsByPaneId.set(agent.pane_id, agent);

    const nowMs = Date.now();
    const leaseRenewIntervalMs = this.swarm.board.leaseRenewIntervalSeconds * 1000;
    const idleTimeoutMs = this.swarm.workerDefaults.idleTimeoutSeconds * 1000;
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
        parkedTabExists: tabsById.has(parked.tabId),
        implTabExists: tabsById.has(implHandle.tabId),
        reviewerTabExists: revHandle ? tabsById.has(revHandle.tabId) : false,
        parkedAgentAlive: agentsByPaneId.has(parkedPaneId),
        nowMs,
      });

      await applyParkedTabOutcome(deps, parked, outcome, nowMs);
    }

    for (const task of this.activeWorkers.values()) {
      const boardTask = tasksById.get(task.ctx.taskId);
      const implHandle = getImplHandle(task.phase);
      const revHandle = getReviewerHandle(task.phase);

      const liveImpl = agentsByPaneId.get(implHandle.paneId) ?? null;
      const liveReviewer = revHandle ? (agentsByPaneId.get(revHandle.paneId) ?? null) : null;
      const signal = await this.observeThreadSignal(task, boardTask, liveImpl, liveReviewer);

      const outcome = stepTask(task, {
        boardState: boardTask?.state ?? "unknown",
        implTabExists: tabsById.has(implHandle.tabId),
        implAgentStatus: liveImpl?.agent_status ?? null,
        reviewerTabExists: revHandle ? tabsById.has(revHandle.tabId) : false,
        reviewerAgentStatus: liveReviewer?.agent_status ?? null,
        signal,
        nowMs,
        leaseRenewIntervalMs,
        idleTimeoutMs,
        startupGraceMs: STARTUP_GRACE_MS,
      });

      await applyTaskStepOutcome(deps, task, outcome, nowMs);
    }
  }

  async runLoop(once: boolean): Promise<void> {
    const machineCfg = this.swarm.machines[this.machineName];
    if (!machineCfg) {
      throw new Error(`Unknown machine "${this.machineName}"`);
    }

    log(
      "INFO",
      `Starting Worker Dispatcher on "${this.machineName}" (herdrTarget=${machineCfg.herdrTarget}, maxWorkers=${machineCfg.maxWorkers}, defaultAgent=${this.swarm.workerDefaults.defaultAgent}, installedAgents=[${[...this.availableAgentKinds].join(",")}], dryRun=${this.dryRun})`,
    );

    if (machineCfg.maxWorkers <= 0 && !this.dryRun) {
      log(
        "WARN",
        `maxWorkers is 0 for "${this.machineName}"; dispatcher will idle without claiming tasks.`,
      );
    }

    while (!this.stopping) {
      try {
        await this.tick();
      } catch (err) {
        log("ERROR", `Dispatcher tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (once || this.stopping) break;
      await sleep(this.swarm.workerDefaults.pollIntervalSeconds * 1000);
    }

    log(
      "INFO",
      `Dispatcher stopped cleanly (activeWorkers=${this.activeWorkers.size}, parkedTabs=${this.parkedTabs.size}).`,
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

  const dispatcher = new SwarmDispatcher({
    repoRoot,
    swarm,
    projects,
    projectsConfigPath,
    machineName,
    board: new BoardClient({
      scope: swarm.board.scope,
      boardName: swarm.board.boardName,
      onWarn: (message) => log("WARN", message),
    }),
    herdr: new HerdrClient({ target: machineCfg.herdrTarget }),
    promptTemplate,
    reviewerPromptTemplate,
    availableAgentKinds: detectAvailableAgentKinds(swarm),
    dryRun: flags.dryRun,
  });

  const onSignal = (sig: NodeJS.Signals) => {
    log("INFO", `Received ${sig}; stopping dispatcher after current cycle...`);
    dispatcher.requestStop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  await dispatcher.runLoop(flags.once);
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    log("ERROR", err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
