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
  type ResolvedReviewerConfig,
  type ResolvedWorkerRuntime,
  type SwarmConfig,
} from "./lib/config.ts";
import {
  HerdrClient,
  sanitizeHerdrAgentName,
  type HerdrAgent,
  type HerdrTab,
} from "./lib/herdr.ts";
import { buildMachineRegistryEntry, publishMachineRegistry } from "./lib/registry.ts";
import {
  buildFixRoundPrompt,
  defaultGitChangeDetector,
  findReadyForReviewReply,
  findReviewVerdictReply,
  renderReviewerPrompt,
  type GitChangeDetector,
} from "./lib/review.ts";
import {
  formatReviewTabLabel,
  formatTabLabel,
  renderWorkerPrompt,
  selectEligibleTasks,
  shortTaskId,
  type CandidateTask,
} from "./lib/routing.ts";

type WorkerPhase = "implementing" | "reviewing" | "fixing";

interface ActiveReviewerSession {
  boardProfile: string;
  runtime: ResolvedWorkerRuntime;
  tabId: string;
  paneId: string;
  agentName: string;
  startedAtMs: number;
  promptSent: boolean;
  promptText: string;
  uiBlockedNotified: boolean;
  idleSinceMs: number | null;
  idleReminderSent: boolean;
}

interface ActiveWorker {
  taskId: string;
  channel: string;
  projectSlug: string;
  repoPath: string;
  baseBranch: string;
  branch: string;
  useWorktree: boolean;
  boardProfile: string;
  runtime: ResolvedWorkerRuntime;
  reviewConfig: ResolvedReviewerConfig;
  startHeadSha: string | null;
  phase: WorkerPhase;
  reviewRound: number;
  phaseSeenReplyIds: Set<string>;
  lastImplSummary: string;
  reviewer?: ActiveReviewerSession;
  workspaceId: string;
  tabId: string;
  paneId: string;
  agentName: string;
  startedAtMs: number;
  lastLeaseRenewMs: number;
  promptSent: boolean;
  promptText: string;
  uiBlockedNotified: boolean;
  idleSinceMs: number | null;
  idleReminderSent: boolean;
}

interface ParkedTab {
  taskId: string;
  projectSlug: string;
  useWorktree: boolean;
  workspaceId: string;
  tabId: string;
  reason: "blocked" | "failed";
  parkedAtMs: number;
}

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
    if (arg === "--once") {
      once = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--machine" && argv[i + 1]) {
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
  if (level === "ERROR") {
    console.error(line);
  } else {
    console.log(line);
  }
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

  readonly activeWorkers = new Map<string, ActiveWorker>();
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

  requestStop(): void {
    this.stopping = true;
  }

  private getBusyPlainTabProjects(): Set<string> {
    const busy = new Set<string>();
    for (const worker of this.activeWorkers.values()) {
      if (!worker.useWorktree) {
        busy.add(worker.projectSlug);
      }
    }
    for (const parked of this.parkedTabs.values()) {
      if (!parked.useWorktree) {
        busy.add(parked.projectSlug);
      }
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
    const allTasks = await this.board.listTasks(prefix, { state: "all", limit: 200 });
    const tasksById = new Map<string, BoardTask>();
    for (const t of allTasks) {
      tasksById.set(t.id, t);
    }

    // Reconcile existing active workers & parked tabs against Herdr + Board
    if (this.activeWorkers.size > 0 || this.parkedTabs.size > 0) {
      await this.reconcileRunningWorkers(tasksById);
    }

    if (this.stopping) return;

    // Check slot capacity
    const availableSlots = machineCfg.maxWorkers - this.activeWorkers.size;
    if (availableSlots <= 0) {
      return;
    }

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

    const readyTasks = allTasks.filter((t) => t.state === "ready");
    if (readyTasks.length === 0) {
      return;
    }

    const { candidates, skips } = selectEligibleTasks({
      tasks: readyTasks,
      swarm: this.swarm,
      projects: this.projects,
      machineName: this.machineName,
      busyPlainTabProjects: this.getBusyPlainTabProjects(),
      alreadyTrackedTaskIds: this.getTrackedTaskIds(),
      availableAgentKinds: this.availableAgentKinds,
    });

    for (const skip of skips) {
      if (this.dryRun) {
        log("INFO", `[dry-run] Skip task #${skip.taskId}: ${skip.reason}`);
      }
    }

    let slotsLeft = availableSlots;
    const claimedProjectsThisTick = new Set<string>();

    for (const candidate of candidates) {
      if (slotsLeft <= 0 || this.stopping) break;
      if (!candidate.useWorktree && claimedProjectsThisTick.has(candidate.projectSlug)) {
        continue;
      }

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

  private getPromptTemplate(): string {
    const promptPath = resolve(this.repoRoot, "prompts/worker-prompt.md");
    if (existsSync(promptPath)) {
      return readFileSync(promptPath, "utf8");
    }
    return this.promptTemplate;
  }

  private getReviewerPromptTemplate(): string {
    const promptPath = resolve(this.repoRoot, "prompts/reviewer-prompt.md");
    if (existsSync(promptPath)) {
      return readFileSync(promptPath, "utf8");
    }
    return this.reviewerPromptTemplate;
  }

  private buildBoardEnv(boardProfile: string): Record<string, string> {
    const env: Record<string, string> = {
      BOARD_PROFILE: boardProfile,
    };
    if (this.swarm.board.scope) {
      env.VERCEL_SCOPE = this.swarm.board.scope;
    }
    if (this.swarm.board.boardName) {
      env.VERCEL_BOARD_NAME = this.swarm.board.boardName;
    }
    return env;
  }

  private async claimAndSpawn(candidate: CandidateTask): Promise<boolean> {
    const { task, projectSlug, project, repoPath, useWorktree, runtime, reviewer } = candidate;
    const shortId = shortTaskId(task.id);
    const boardProfile = `worker-${this.machineName}-${shortId}`;
    const lease = this.swarm.board.leaseDuration;

    try {
      await this.board.claimTaskById(task.id, { asProfile: boardProfile, lease });
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

    const env = this.buildBoardEnv(boardProfile);
    const tabLabel = formatTabLabel(task.id, runtime.profileName);
    const agentName = sanitizeHerdrAgentName("w", shortId);
    const branch = `task/${shortId}`;

    try {
      const startHeadSha = reviewer.enabled ? this.gitDetector.captureHeadSha(repoPath) : null;
      const phaseSeenReplyIds = new Set<string>();
      if (reviewer.enabled) {
        const existingThread = await this.board.readThread(task.id).catch(() => null);
        if (existingThread) {
          for (const reply of existingThread.replies) {
            phaseSeenReplyIds.add(reply.id);
          }
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

      const startResult = await this.herdr.startAgent({
        name: agentName,
        kind: runtime.kind,
        paneId: spawnedPane.paneId,
        args: runtime.cliArgs,
        timeoutMs: 60_000,
      });

      const now = Date.now();
      const worker: ActiveWorker = {
        taskId: task.id,
        channel: task.channel,
        projectSlug,
        repoPath,
        baseBranch: project.baseBranch,
        branch,
        useWorktree,
        boardProfile,
        runtime,
        reviewConfig: reviewer,
        startHeadSha,
        phase: "implementing",
        reviewRound: 0,
        phaseSeenReplyIds,
        lastImplSummary: `Completed task #${task.id}`,
        workspaceId: spawnedPane.workspaceId,
        tabId: spawnedPane.tabId,
        paneId: spawnedPane.paneId,
        agentName,
        startedAtMs: now,
        lastLeaseRenewMs: now,
        promptSent: false,
        promptText,
        uiBlockedNotified: false,
        idleSinceMs: null,
        idleReminderSent: false,
      };

      this.activeWorkers.set(task.id, worker);

      if (startResult.blockedOnStartup) {
        log(
          "WARN",
          `Worker ${agentName} for task #${task.id} hit an interactive prompt on startup; marking tab [BLOCKED] for Sheprd.`,
        );
        await this.markWorkerUiBlocked(
          worker,
          `Worker (${runtime.profileName}) paused on startup prompt in Sheprd on \`${this.machineName}\` (workspace \`${projectSlug}\`, tab \`${formatTabLabel(task.id, runtime.profileName, "BLOCKED")}\`). Approve/dismiss it in Sheprd to continue.`,
        );
      } else {
        await this.herdr.promptAgent(agentName, promptText);
        worker.promptSent = true;
        log(
          "INFO",
          `Spawned ${agentName} (${runtime.kind}) in ${spawnedPane.tabId} and delivered task #${task.id} prompt.`,
        );
      }

      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log("ERROR", `Failed to spawn worker for task #${task.id}: ${detail}`);
      try {
        await this.board.reply(
          task.id,
          `Dispatcher on \`${this.machineName}\` failed to spawn \`${runtime.profileName}\` worker and released the task:\n\`\`\`\n${detail.slice(0, 600)}\n\`\`\``,
          { asProfile: boardProfile },
        );
      } catch {
        // Ignore secondary reply failure
      }
      try {
        await this.board.releaseTask(task.id, { asProfile: boardProfile });
      } catch {
        // Ignore secondary release failure
      }
      return false;
    }
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

    // Prune parked tabs that the human already closed in Sheprd
    for (const [taskId, parked] of this.parkedTabs.entries()) {
      if (!tabsById.has(parked.tabId)) {
        log(
          "INFO",
          `Parked tab ${parked.tabId} for task #${taskId} was closed in Sheprd; freeing slot.`,
        );
        this.parkedTabs.delete(taskId);
      }
    }

    const now = Date.now();
    const renewIntervalMs = this.swarm.board.leaseRenewIntervalSeconds * 1000;
    const idleTimeoutMs = this.swarm.workerDefaults.idleTimeoutSeconds * 1000;

    for (const worker of this.activeWorkers.values()) {
      const boardTask = tasksById.get(worker.taskId);
      const boardState = boardTask?.state ?? "unknown";
      const tabExists = tabsById.has(worker.tabId);
      const reviewerTabExists = worker.reviewer ? tabsById.has(worker.reviewer.tabId) : false;

      // 1. Completed or canceled on Board -> clean up tab(s)/worktree and release slot
      if (boardState === "completed" || boardState === "canceled") {
        log(
          "INFO",
          `Task #${worker.taskId} is ${boardState} on Board; cleaning up worker ${worker.agentName}.`,
        );
        await this.cleanupReviewerTab(worker, reviewerTabExists);
        await this.cleanupFinishedWorker(worker, tabExists);
        this.activeWorkers.delete(worker.taskId);
        continue;
      }

      // 2. Blocked on Board -> park tab in Sheprd, stop lease renewal, free active slot
      if (boardState === "blocked") {
        log(
          "INFO",
          `Task #${worker.taskId} marked blocked on Board; parking tab ${worker.tabId} in Sheprd.`,
        );
        await this.cleanupReviewerTab(worker, reviewerTabExists);
        if (tabExists) {
          await this.safeRenameTab(
            worker.tabId,
            formatTabLabel(worker.taskId, worker.runtime.profileName, "BLOCKED"),
          );
          this.parkTab(worker, worker.tabId, "blocked", now);
        }
        this.activeWorkers.delete(worker.taskId);
        continue;
      }

      // 3. Failed on Board -> park tab as [FAILED] in Sheprd
      if (boardState === "failed") {
        log(
          "WARN",
          `Task #${worker.taskId} is failed on Board; parking tab ${worker.tabId} as [FAILED].`,
        );
        await this.cleanupReviewerTab(worker, reviewerTabExists);
        if (tabExists) {
          await this.safeRenameTab(
            worker.tabId,
            formatTabLabel(worker.taskId, worker.runtime.profileName, "FAILED"),
          );
          this.parkTab(worker, worker.tabId, "failed", now);
        }
        this.activeWorkers.delete(worker.taskId);
        continue;
      }

      // 4. Renew Board lease while still claimed (across implementing, reviewing, and fixing)
      if (boardState === "claimed" && now - worker.lastLeaseRenewMs >= renewIntervalMs) {
        try {
          await this.board.renewTask(worker.taskId, {
            asProfile: worker.boardProfile,
            lease: this.swarm.board.leaseDuration,
          });
          worker.lastLeaseRenewMs = now;
          log("INFO", `Renewed lease for task #${worker.taskId} (${worker.boardProfile}).`);
        } catch (err) {
          log(
            "WARN",
            `Lease renewal failed for task #${worker.taskId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (worker.phase === "reviewing" && worker.reviewer) {
        await this.reconcileReviewingPhase({
          worker,
          boardTask,
          boardState,
          implTabExists: tabExists,
          reviewerTabExists,
          agentsByPaneId,
          now,
          idleTimeoutMs,
        });
      } else {
        await this.reconcileImplementingOrFixingPhase({
          worker,
          boardTask,
          boardState,
          tabExists,
          agentsByPaneId,
          now,
          idleTimeoutMs,
        });
      }
    }
  }

  private parkTab(
    worker: ActiveWorker,
    tabId: string,
    reason: "blocked" | "failed",
    now: number,
  ): void {
    this.parkedTabs.set(worker.taskId, {
      taskId: worker.taskId,
      projectSlug: worker.projectSlug,
      useWorktree: worker.useWorktree,
      workspaceId: worker.workspaceId,
      tabId,
      reason,
      parkedAtMs: now,
    });
  }

  private getActiveImplTag(worker: ActiveWorker): string | undefined {
    return worker.phase === "fixing" ? `fix-r${worker.reviewRound}` : undefined;
  }

  private async reconcileImplementingOrFixingPhase(params: {
    worker: ActiveWorker;
    boardTask: BoardTask | undefined;
    boardState: string;
    tabExists: boolean;
    agentsByPaneId: Map<string, HerdrAgent>;
    now: number;
    idleTimeoutMs: number;
  }): Promise<void> {
    const { worker, boardTask, boardState, tabExists, agentsByPaneId, now, idleTimeoutMs } = params;
    const liveAgent = agentsByPaneId.get(worker.paneId) ?? null;

    // 5. Tab manually closed or agent exited unexpectedly while task is still claimed
    const pastStartupGrace = now - worker.startedAtMs > 20_000;
    if (!tabExists || (!liveAgent && pastStartupGrace)) {
      log(
        "ERROR",
        `Worker ${worker.agentName} for task #${worker.taskId} exited unexpectedly (tabExists=${tabExists}, agentAlive=${Boolean(liveAgent)}).`,
      );
      let tail = "";
      if (tabExists) {
        tail = await this.herdr.paneRead(worker.paneId, { lines: 40 }).catch(() => "");
        await this.safeRenameTab(
          worker.tabId,
          formatTabLabel(worker.taskId, worker.runtime.profileName, "FAILED"),
        );
        this.parkTab(worker, worker.tabId, "failed", now);
      }

      if (boardState === "claimed") {
        const snippet = tail.trim().slice(-1200);
        const msg = snippet
          ? `Worker \`${worker.agentName}\` on \`${this.machineName}\` exited before completing/blocking the task.\n\nLast terminal output:\n\`\`\`\n${snippet}\n\`\`\``
          : `Worker \`${worker.agentName}\` on \`${this.machineName}\` closed or exited before completing/blocking the task.`;
        await this.board
          .reply(worker.taskId, msg, { asProfile: worker.boardProfile })
          .catch(() => {});
        await this.board
          .failTask(worker.taskId, `Worker exited unexpectedly on ${this.machineName}`, {
            asProfile: worker.boardProfile,
          })
          .catch(() => {});
      }
      this.activeWorkers.delete(worker.taskId);
      return;
    }

    if (!liveAgent) return;

    // 6. Startup-blocked worker just became idle -> deliver initial prompt!
    if (
      !worker.promptSent &&
      (liveAgent.agent_status === "idle" || liveAgent.agent_status === "done")
    ) {
      try {
        await this.herdr.promptAgent(worker.agentName, worker.promptText);
        worker.promptSent = true;
        worker.uiBlockedNotified = false;
        worker.idleSinceMs = null;
        await this.safeRenameTab(
          worker.tabId,
          formatTabLabel(
            worker.taskId,
            worker.runtime.profileName,
            undefined,
            this.getActiveImplTag(worker),
          ),
        );
        log(
          "INFO",
          `Delivered queued prompt to previously startup-blocked worker ${worker.agentName}.`,
        );
      } catch (err) {
        log(
          "WARN",
          `Could not deliver queued prompt to ${worker.agentName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    // 7. Check for `STATUS: READY_FOR_REVIEW` on Board thread when review gate is enabled
    const isAgentIdle = liveAgent.agent_status === "idle" || liveAgent.agent_status === "done";
    const maybeNewReplies = (boardTask?.replyCount ?? Infinity) > worker.phaseSeenReplyIds.size;
    if (
      worker.reviewConfig.enabled &&
      worker.promptSent &&
      boardState === "claimed" &&
      (maybeNewReplies || isAgentIdle)
    ) {
      const thread = await this.board.readThread(worker.taskId).catch((err) => {
        log(
          "WARN",
          `Failed to read Board thread #${worker.taskId} for review handoff: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      });
      if (thread) {
        const reviewerProfileName = `reviewer-${this.machineName}-${shortTaskId(worker.taskId)}`;
        const readyMatch = findReadyForReviewReply(
          thread.replies,
          worker.phaseSeenReplyIds,
          reviewerProfileName,
        );
        if (readyMatch) {
          for (const reply of thread.replies) {
            worker.phaseSeenReplyIds.add(reply.id);
          }
          worker.lastImplSummary = readyMatch.summary;
          worker.idleSinceMs = null;
          worker.idleReminderSent = false;

          const reviewCwd = worker.useWorktree
            ? (liveAgent.cwd ?? liveAgent.foreground_cwd ?? worker.repoPath)
            : worker.repoPath;

          if (!worker.reviewConfig.required && worker.reviewConfig.skipIfNoDiff) {
            const gitCheck = this.gitDetector.detectChanges(
              reviewCwd,
              worker.startHeadSha,
              worker.baseBranch,
            );
            if (!gitCheck.hasChanges) {
              log(
                "INFO",
                `Task #${worker.taskId} signaled READY_FOR_REVIEW with no local git changes (${gitCheck.detail}); skipping review and completing.`,
              );
              await this.board
                .reply(
                  worker.taskId,
                  `Dispatcher skipped automated code review (${gitCheck.detail}) and marked task complete.`,
                  { asProfile: worker.boardProfile },
                )
                .catch(() => {});
              await this.board
                .completeTask(worker.taskId, worker.lastImplSummary, {
                  asProfile: worker.boardProfile,
                })
                .catch((err) => {
                  log(
                    "ERROR",
                    `Failed to complete task #${worker.taskId} after diff-skip: ${err instanceof Error ? err.message : String(err)}`,
                  );
                });
              await this.cleanupFinishedWorker(worker, tabExists);
              this.activeWorkers.delete(worker.taskId);
              return;
            }
          }

          await this.startReviewRound(worker, reviewCwd, now);
          return;
        }
      }
    }

    // 8. Herdr detected approval/question UI block
    if (liveAgent.agent_status === "blocked") {
      worker.idleSinceMs = null;
      if (!worker.uiBlockedNotified) {
        await this.markWorkerUiBlocked(
          worker,
          `Worker \`${worker.agentName}\` (${worker.runtime.profileName}) is waiting on an interactive prompt in Sheprd on \`${this.machineName}\` (workspace \`${worker.projectSlug}\`, tab \`${formatTabLabel(worker.taskId, worker.runtime.profileName, "BLOCKED")}\`).`,
        );
      }
      return;
    }

    // 9. Recovered from UI block -> restore normal tab label
    if (liveAgent.agent_status === "working") {
      worker.idleSinceMs = null;
      if (worker.uiBlockedNotified) {
        worker.uiBlockedNotified = false;
        await this.safeRenameTab(
          worker.tabId,
          formatTabLabel(
            worker.taskId,
            worker.runtime.profileName,
            undefined,
            this.getActiveImplTag(worker),
          ),
        );
      }
      return;
    }

    // 10. Worker went idle/done without completing or signaling READY_FOR_REVIEW
    if (worker.promptSent && boardState === "claimed" && isAgentIdle) {
      if (worker.idleSinceMs === null) {
        worker.idleSinceMs = now;
      } else if (now - worker.idleSinceMs >= idleTimeoutMs) {
        if (!worker.idleReminderSent) {
          worker.idleReminderSent = true;
          worker.idleSinceMs = now;
          log(
            "INFO",
            `Worker ${worker.agentName} idle while task #${worker.taskId} still claimed; sending reminder.`,
          );
          const reminderText = worker.reviewConfig.enabled
            ? `Task #${worker.taskId} is still in state "claimed" and awaiting code review. If you finished implementing and committed your changes, post your summary reply to thread ${worker.taskId} ending with \`STATUS: READY_FOR_REVIEW\` (do NOT call \`vercel board tasks complete\`). If you need input or approval, run \`vercel board tasks block ${worker.taskId} "<reason>" --kind needs_input\`.`
            : `Task #${worker.taskId} is still in state "claimed". If you finished, run \`vercel board tasks complete ${worker.taskId} "<summary>"\`. If you need input or approval, run \`vercel board tasks block ${worker.taskId} "<reason>" --kind needs_input\`.`;
          await this.herdr.promptAgent(worker.agentName, reminderText).catch(() => {});
        } else {
          log(
            "WARN",
            `Worker ${worker.agentName} remained idle after reminder; marking task #${worker.taskId} blocked and parking tab.`,
          );
          await this.safeRenameTab(
            worker.tabId,
            formatTabLabel(worker.taskId, worker.runtime.profileName, "BLOCKED"),
          );
          await this.board
            .blockTask(
              worker.taskId,
              `Worker ${worker.agentName} on ${this.machineName} went idle without completing; inspect tab in Sheprd.`,
              { asProfile: worker.boardProfile, kind: "needs_input" },
            )
            .catch(() => {});
          this.parkTab(worker, worker.tabId, "blocked", now);
          this.activeWorkers.delete(worker.taskId);
        }
      }
    }
  }

  private async startReviewRound(
    worker: ActiveWorker,
    reviewCwd: string,
    now: number,
  ): Promise<void> {
    const reviewRuntime = worker.reviewConfig.runtime;
    if (!reviewRuntime) {
      return;
    }

    const shortId = shortTaskId(worker.taskId);
    const nextRound = worker.reviewRound + 1;
    const reviewerBoardProfile = `reviewer-${this.machineName}-${shortId}`;
    const reviewerAgentName = sanitizeHerdrAgentName(`r${nextRound}`, shortId);
    const reviewTabLabel = formatReviewTabLabel(
      worker.taskId,
      reviewRuntime.profileName,
      nextRound,
    );

    try {
      const reviewPane = await this.herdr.createTab({
        workspaceId: worker.workspaceId,
        cwd: reviewCwd,
        label: reviewTabLabel,
        env: this.buildBoardEnv(reviewerBoardProfile),
        focus: false,
      });

      const baseRef = worker.startHeadSha ?? worker.baseBranch;
      const reviewPrompt = renderReviewerPrompt(this.getReviewerPromptTemplate(), {
        taskId: worker.taskId,
        channel: worker.channel,
        project: worker.projectSlug,
        boardProfile: reviewerBoardProfile,
        baseRef,
        branch: worker.branch,
        round: nextRound,
        maxRounds: worker.reviewConfig.maxRounds,
        reviewerProfile: reviewRuntime.profileName,
        humanHandle: this.swarm.board.humanHandle,
      });

      const startResult = await this.herdr.startAgent({
        name: reviewerAgentName,
        kind: reviewRuntime.kind,
        paneId: reviewPane.paneId,
        args: reviewRuntime.cliArgs,
        timeoutMs: 60_000,
      });

      worker.reviewRound = nextRound;
      worker.phase = "reviewing";
      worker.idleSinceMs = null;
      worker.idleReminderSent = false;
      worker.reviewer = {
        boardProfile: reviewerBoardProfile,
        runtime: reviewRuntime,
        tabId: reviewPane.tabId,
        paneId: reviewPane.paneId,
        agentName: reviewerAgentName,
        startedAtMs: now,
        promptSent: false,
        promptText: reviewPrompt,
        uiBlockedNotified: false,
        idleSinceMs: null,
        idleReminderSent: false,
      };

      await this.safeRenameTab(
        worker.tabId,
        formatTabLabel(
          worker.taskId,
          worker.runtime.profileName,
          undefined,
          `[IN-REVIEW r${nextRound}]`,
        ),
      );

      if (startResult.blockedOnStartup) {
        log(
          "WARN",
          `Reviewer ${reviewerAgentName} for task #${worker.taskId} hit an interactive prompt on startup; marking tab [BLOCKED] for Sheprd.`,
        );
        worker.reviewer.uiBlockedNotified = true;
        await this.safeRenameTab(
          reviewPane.tabId,
          formatReviewTabLabel(worker.taskId, reviewRuntime.profileName, nextRound, "BLOCKED"),
        );
        await this.board
          .reply(
            worker.taskId,
            `Reviewer (${reviewRuntime.profileName}, round ${nextRound}/${worker.reviewConfig.maxRounds}) paused on startup prompt in Sheprd on \`${this.machineName}\` (workspace \`${worker.projectSlug}\`). Approve/dismiss it in Sheprd to continue.`,
            { asProfile: reviewerBoardProfile },
          )
          .catch(() => {});
      } else {
        await this.herdr.promptAgent(reviewerAgentName, reviewPrompt);
        worker.reviewer.promptSent = true;
        log(
          "INFO",
          `Spawned reviewer ${reviewerAgentName} (${reviewRuntime.profileName}/${reviewRuntime.kind}) for task #${worker.taskId} round ${nextRound}/${worker.reviewConfig.maxRounds}.`,
        );
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log("ERROR", `Failed to spawn reviewer for task #${worker.taskId}: ${detail}`);
      await this.board
        .reply(
          worker.taskId,
          `Dispatcher on \`${this.machineName}\` failed to start reviewer \`${reviewRuntime.profileName}\` (round ${nextRound}):\n\`\`\`\n${detail.slice(0, 600)}\n\`\`\``,
          { asProfile: worker.boardProfile },
        )
        .catch(() => {});
      await this.board
        .blockTask(
          worker.taskId,
          `Failed to start reviewer ${reviewRuntime.profileName} on ${this.machineName}; inspect Sheprd.`,
          { asProfile: worker.boardProfile, kind: "needs_input" },
        )
        .catch(() => {});
      await this.safeRenameTab(
        worker.tabId,
        formatTabLabel(worker.taskId, worker.runtime.profileName, "BLOCKED"),
      );
      this.parkTab(worker, worker.tabId, "blocked", now);
      this.activeWorkers.delete(worker.taskId);
    }
  }

  private async reconcileReviewingPhase(params: {
    worker: ActiveWorker;
    boardTask: BoardTask | undefined;
    boardState: string;
    implTabExists: boolean;
    reviewerTabExists: boolean;
    agentsByPaneId: Map<string, HerdrAgent>;
    now: number;
    idleTimeoutMs: number;
  }): Promise<void> {
    const {
      worker,
      boardTask,
      boardState,
      implTabExists,
      reviewerTabExists,
      agentsByPaneId,
      now,
      idleTimeoutMs,
    } = params;
    const reviewer = worker.reviewer;
    if (!reviewer) return;

    const liveReviewer = agentsByPaneId.get(reviewer.paneId) ?? null;

    // 5. Check for reviewer verdict on Board thread FIRST (even if reviewer just exited after posting)
    const isReviewerIdle =
      liveReviewer !== null &&
      (liveReviewer.agent_status === "idle" || liveReviewer.agent_status === "done");
    const maybeNewReplies = (boardTask?.replyCount ?? Infinity) > worker.phaseSeenReplyIds.size;

    if (
      reviewer.promptSent &&
      boardState === "claimed" &&
      (maybeNewReplies || isReviewerIdle || !liveReviewer)
    ) {
      const thread = await this.board.readThread(worker.taskId).catch((err) => {
        log(
          "WARN",
          `Failed to read Board thread #${worker.taskId} for reviewer verdict: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      });
      if (thread) {
        const verdictMatch = findReviewVerdictReply(
          thread.replies,
          worker.phaseSeenReplyIds,
          reviewer.boardProfile,
        );
        if (verdictMatch) {
          for (const reply of thread.replies) {
            worker.phaseSeenReplyIds.add(reply.id);
          }

          await this.cleanupReviewerTab(worker, reviewerTabExists);

          if (verdictMatch.verdict === "approve") {
            const completionSummary = `${worker.lastImplSummary} (Reviewed & approved by ${reviewer.runtime.profileName}, round ${worker.reviewRound}/${worker.reviewConfig.maxRounds})`;
            log(
              "INFO",
              `Reviewer ${reviewer.agentName} APPROVED task #${worker.taskId} (round ${worker.reviewRound}/${worker.reviewConfig.maxRounds}); completing task.`,
            );
            await this.board
              .completeTask(worker.taskId, completionSummary, { asProfile: worker.boardProfile })
              .catch((err) => {
                log(
                  "ERROR",
                  `Failed to mark task #${worker.taskId} completed after approval: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
            await this.cleanupFinishedWorker(worker, implTabExists);
            this.activeWorkers.delete(worker.taskId);
            return;
          }

          // REQUEST_CHANGES
          if (worker.reviewRound < worker.reviewConfig.maxRounds) {
            log(
              "INFO",
              `Reviewer ${reviewer.agentName} requested changes on task #${worker.taskId} (round ${worker.reviewRound}/${worker.reviewConfig.maxRounds}); waking original implementer ${worker.agentName}.`,
            );
            await this.handBackToImplementer({
              worker,
              reviewerProfile: reviewer.runtime.profileName,
              implTabExists,
              agentsByPaneId,
              now,
            });
            return;
          }

          // Max review rounds exhausted -> escalate to human / @lead
          log(
            "WARN",
            `Task #${worker.taskId} reached max review rounds (${worker.reviewRound}/${worker.reviewConfig.maxRounds}) with blocking issues; escalating to blocked.`,
          );
          await this.board
            .reply(
              worker.taskId,
              `Review round cap (${worker.reviewRound}/${worker.reviewConfig.maxRounds}) reached on task \`${worker.taskId}\` with blocking issues remaining from \`${reviewer.runtime.profileName}\`. Pausing for review/decision (${this.swarm.board.humanHandle} @lead).`,
              { asProfile: worker.boardProfile },
            )
            .catch(() => {});
          await this.board
            .blockTask(
              worker.taskId,
              `Review round cap (${worker.reviewConfig.maxRounds}) reached; inspect review thread & Sheprd tab.`,
              { asProfile: worker.boardProfile, kind: "awaiting_approval" },
            )
            .catch(() => {});
          if (implTabExists) {
            await this.safeRenameTab(
              worker.tabId,
              formatTabLabel(worker.taskId, worker.runtime.profileName, "BLOCKED"),
            );
            this.parkTab(worker, worker.tabId, "blocked", now);
          }
          this.activeWorkers.delete(worker.taskId);
          return;
        }
      }
    }

    // 6. Reviewer crashed or tab closed unexpectedly without posting a verdict
    const pastStartupGrace = now - reviewer.startedAtMs > 20_000;
    if (!reviewerTabExists || (!liveReviewer && pastStartupGrace)) {
      log(
        "ERROR",
        `Reviewer ${reviewer.agentName} for task #${worker.taskId} exited unexpectedly (tabExists=${reviewerTabExists}, agentAlive=${Boolean(liveReviewer)}).`,
      );
      let tail = "";
      if (reviewerTabExists) {
        tail = await this.herdr.paneRead(reviewer.paneId, { lines: 40 }).catch(() => "");
        await this.safeRenameTab(
          reviewer.tabId,
          formatReviewTabLabel(
            worker.taskId,
            reviewer.runtime.profileName,
            worker.reviewRound,
            "FAILED",
          ),
        );
        this.parkTab(worker, reviewer.tabId, "failed", now);
      } else if (implTabExists) {
        await this.safeRenameTab(
          worker.tabId,
          formatTabLabel(worker.taskId, worker.runtime.profileName, "FAILED"),
        );
        this.parkTab(worker, worker.tabId, "failed", now);
      }

      if (boardState === "claimed") {
        const snippet = tail.trim().slice(-1200);
        const msg = snippet
          ? `Reviewer \`${reviewer.agentName}\` on \`${this.machineName}\` exited before posting a verdict.\n\nLast terminal output:\n\`\`\`\n${snippet}\n\`\`\``
          : `Reviewer \`${reviewer.agentName}\` on \`${this.machineName}\` closed or exited before posting a verdict.`;
        await this.board
          .reply(worker.taskId, msg, { asProfile: reviewer.boardProfile })
          .catch(() => {});
        await this.board
          .failTask(worker.taskId, `Reviewer exited unexpectedly on ${this.machineName}`, {
            asProfile: worker.boardProfile,
          })
          .catch(() => {});
      }
      this.activeWorkers.delete(worker.taskId);
      return;
    }

    if (!liveReviewer) return;

    // 7. Startup-blocked reviewer just became idle -> deliver queued review prompt
    if (!reviewer.promptSent && isReviewerIdle) {
      try {
        await this.herdr.promptAgent(reviewer.agentName, reviewer.promptText);
        reviewer.promptSent = true;
        reviewer.uiBlockedNotified = false;
        reviewer.idleSinceMs = null;
        await this.safeRenameTab(
          reviewer.tabId,
          formatReviewTabLabel(worker.taskId, reviewer.runtime.profileName, worker.reviewRound),
        );
        log(
          "INFO",
          `Delivered queued prompt to previously startup-blocked reviewer ${reviewer.agentName}.`,
        );
      } catch (err) {
        log(
          "WARN",
          `Could not deliver queued prompt to reviewer ${reviewer.agentName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    // 8. Reviewer hit UI block in Herdr
    if (liveReviewer.agent_status === "blocked") {
      reviewer.idleSinceMs = null;
      if (!reviewer.uiBlockedNotified) {
        reviewer.uiBlockedNotified = true;
        const blockedLabel = formatReviewTabLabel(
          worker.taskId,
          reviewer.runtime.profileName,
          worker.reviewRound,
          "BLOCKED",
        );
        await this.safeRenameTab(reviewer.tabId, blockedLabel);
        await this.board
          .reply(
            worker.taskId,
            `Reviewer \`${reviewer.agentName}\` (${reviewer.runtime.profileName}) is waiting on an interactive prompt in Sheprd on \`${this.machineName}\` (workspace \`${worker.projectSlug}\`, tab \`${blockedLabel}\`).`,
            { asProfile: reviewer.boardProfile },
          )
          .catch(() => {});
      }
      return;
    }

    // 9. Reviewer recovered from UI block
    if (liveReviewer.agent_status === "working") {
      reviewer.idleSinceMs = null;
      if (reviewer.uiBlockedNotified) {
        reviewer.uiBlockedNotified = false;
        await this.safeRenameTab(
          reviewer.tabId,
          formatReviewTabLabel(worker.taskId, reviewer.runtime.profileName, worker.reviewRound),
        );
      }
      return;
    }

    // 10. Reviewer went idle/done without posting VERDICT: APPROVE or VERDICT: REQUEST_CHANGES
    if (reviewer.promptSent && boardState === "claimed" && isReviewerIdle) {
      if (reviewer.idleSinceMs === null) {
        reviewer.idleSinceMs = now;
      } else if (now - reviewer.idleSinceMs >= idleTimeoutMs) {
        if (!reviewer.idleReminderSent) {
          reviewer.idleReminderSent = true;
          reviewer.idleSinceMs = now;
          log(
            "INFO",
            `Reviewer ${reviewer.agentName} idle without posting verdict for task #${worker.taskId}; sending reminder.`,
          );
          await this.herdr
            .promptAgent(
              reviewer.agentName,
              `Please post your code review reply to thread \`${worker.taskId}\` using \`vercel board reply ${worker.taskId} ...\` ending with either \`VERDICT: APPROVE\` or \`VERDICT: REQUEST_CHANGES\`.`,
            )
            .catch(() => {});
        } else {
          log(
            "WARN",
            `Reviewer ${reviewer.agentName} remained idle without verdict; blocking task #${worker.taskId} and parking tab.`,
          );
          await this.safeRenameTab(
            reviewer.tabId,
            formatReviewTabLabel(
              worker.taskId,
              reviewer.runtime.profileName,
              worker.reviewRound,
              "BLOCKED",
            ),
          );
          await this.board
            .blockTask(
              worker.taskId,
              `Reviewer ${reviewer.agentName} on ${this.machineName} went idle without posting a verdict; inspect tab in Sheprd.`,
              { asProfile: worker.boardProfile, kind: "needs_input" },
            )
            .catch(() => {});
          this.parkTab(worker, reviewer.tabId, "blocked", now);
          this.activeWorkers.delete(worker.taskId);
        }
      }
    }
  }

  private async handBackToImplementer(params: {
    worker: ActiveWorker;
    reviewerProfile: string;
    implTabExists: boolean;
    agentsByPaneId: Map<string, HerdrAgent>;
    now: number;
  }): Promise<void> {
    const { worker, reviewerProfile, implTabExists, agentsByPaneId, now } = params;
    const fixPrompt = buildFixRoundPrompt({
      taskId: worker.taskId,
      round: worker.reviewRound,
      maxRounds: worker.reviewConfig.maxRounds,
      reviewerProfile,
    });

    worker.phase = "fixing";
    worker.idleSinceMs = null;
    worker.idleReminderSent = false;
    worker.uiBlockedNotified = false;
    worker.promptText = fixPrompt;

    const fixLabel = formatTabLabel(
      worker.taskId,
      worker.runtime.profileName,
      undefined,
      `fix-r${worker.reviewRound}`,
    );

    if (!implTabExists) {
      log(
        "WARN",
        `Original implementer tab ${worker.tabId} for task #${worker.taskId} was closed; escalating to blocked.`,
      );
      await this.board
        .blockTask(
          worker.taskId,
          `Reviewer requested changes, but original implementer tab on ${this.machineName} was closed.`,
          { asProfile: worker.boardProfile, kind: "needs_input" },
        )
        .catch(() => {});
      this.activeWorkers.delete(worker.taskId);
      return;
    }

    await this.safeRenameTab(worker.tabId, fixLabel);

    const liveImpl = agentsByPaneId.get(worker.paneId) ?? null;
    try {
      if (liveImpl) {
        await this.herdr.promptAgent(worker.agentName, fixPrompt);
        worker.promptSent = true;
      } else {
        // Self-heal if original implementer exited while waiting for review
        worker.startedAtMs = now;
        const restart = await this.herdr.startAgent({
          name: worker.agentName,
          kind: worker.runtime.kind,
          paneId: worker.paneId,
          args: worker.runtime.cliArgs,
          timeoutMs: 60_000,
        });
        if (restart.blockedOnStartup) {
          worker.promptSent = false;
          await this.markWorkerUiBlocked(
            worker,
            `Implementer (${worker.runtime.profileName}) paused on startup prompt while resuming fix round ${worker.reviewRound} in Sheprd on \`${this.machineName}\`.`,
          );
        } else {
          await this.herdr.promptAgent(worker.agentName, fixPrompt);
          worker.promptSent = true;
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log(
        "ERROR",
        `Failed to deliver fix prompt to implementer ${worker.agentName} for task #${worker.taskId}: ${detail}`,
      );
      await this.board
        .blockTask(
          worker.taskId,
          `Failed to wake implementer ${worker.agentName} for review fixes: ${detail.slice(0, 300)}`,
          { asProfile: worker.boardProfile, kind: "needs_input" },
        )
        .catch(() => {});
      await this.safeRenameTab(
        worker.tabId,
        formatTabLabel(worker.taskId, worker.runtime.profileName, "BLOCKED"),
      );
      this.parkTab(worker, worker.tabId, "blocked", now);
      this.activeWorkers.delete(worker.taskId);
    }
  }

  private async cleanupReviewerTab(
    worker: ActiveWorker,
    reviewerTabExists: boolean,
  ): Promise<void> {
    const reviewer = worker.reviewer;
    worker.reviewer = undefined;
    if (!reviewer || !reviewerTabExists || !this.swarm.workerDefaults.closeTabOnComplete) {
      return;
    }
    try {
      await this.herdr.closeTab(reviewer.tabId);
      log("INFO", `Closed reviewer tab ${reviewer.tabId} for task #${worker.taskId}.`);
    } catch (err) {
      log(
        "WARN",
        `Failed to close reviewer tab ${reviewer.tabId} for task #${worker.taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async markWorkerUiBlocked(worker: ActiveWorker, boardMessage: string): Promise<void> {
    worker.uiBlockedNotified = true;
    await this.safeRenameTab(
      worker.tabId,
      formatTabLabel(worker.taskId, worker.runtime.profileName, "BLOCKED"),
    );
    await this.board
      .reply(worker.taskId, boardMessage, { asProfile: worker.boardProfile })
      .catch(() => {});
  }

  private async safeRenameTab(tabId: string, label: string): Promise<void> {
    try {
      await this.herdr.renameTab(tabId, label);
    } catch (err) {
      log(
        "WARN",
        `Failed to rename tab ${tabId} to "${label}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async cleanupFinishedWorker(worker: ActiveWorker, tabExists: boolean): Promise<void> {
    if (!this.swarm.workerDefaults.closeTabOnComplete) {
      return;
    }
    try {
      if (worker.useWorktree) {
        await this.herdr.removeWorktree(worker.workspaceId);
        log("INFO", `Removed worktree workspace ${worker.workspaceId} for task #${worker.taskId}.`);
      } else if (tabExists) {
        await this.herdr.closeTab(worker.tabId);
        log("INFO", `Closed tab ${worker.tabId} for completed task #${worker.taskId}.`);
      }
    } catch (err) {
      log(
        "WARN",
        `Cleanup failed for task #${worker.taskId} (${worker.tabId}): ${err instanceof Error ? err.message : String(err)}`,
      );
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

  const board = new BoardClient({
    scope: swarm.board.scope,
    boardName: swarm.board.boardName,
  });
  const herdr = new HerdrClient({
    target: machineCfg.herdrTarget,
  });

  const dispatcher = new SwarmDispatcher({
    repoRoot,
    swarm,
    projects,
    projectsConfigPath,
    machineName,
    board,
    herdr,
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
