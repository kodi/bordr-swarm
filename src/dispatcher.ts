import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardClient, type BoardTask } from "./lib/board.ts";
import {
  loadProjectsConfig,
  loadSwarmConfig,
  resolveCurrentMachineName,
  type ProjectsConfig,
  type ResolvedWorkerRuntime,
  type SwarmConfig,
} from "./lib/config.ts";
import {
  HerdrClient,
  sanitizeHerdrAgentName,
  type HerdrAgent,
  type HerdrTab,
} from "./lib/herdr.ts";
import {
  formatTabLabel,
  renderWorkerPrompt,
  selectEligibleTasks,
  type CandidateTask,
} from "./lib/routing.ts";

interface ActiveWorker {
  taskId: string;
  channel: string;
  projectSlug: string;
  repoPath: string;
  useWorktree: boolean;
  boardProfile: string;
  runtime: ResolvedWorkerRuntime;
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
  const kinds = new Set<string>(["claude", "agy"]);
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
  readonly projects: ProjectsConfig;
  readonly machineName: string;
  readonly board: BoardClient;
  readonly herdr: HerdrClient;
  readonly promptTemplate: string;
  readonly availableAgentKinds: Set<string>;
  readonly dryRun: boolean;

  readonly activeWorkers = new Map<string, ActiveWorker>();
  readonly parkedTabs = new Map<string, ParkedTab>();
  private stopping = false;

  constructor(params: {
    repoRoot: string;
    swarm: SwarmConfig;
    projects: ProjectsConfig;
    machineName: string;
    board: BoardClient;
    herdr: HerdrClient;
    promptTemplate: string;
    availableAgentKinds: Set<string>;
    dryRun: boolean;
  }) {
    this.repoRoot = params.repoRoot;
    this.swarm = params.swarm;
    this.projects = params.projects;
    this.machineName = params.machineName;
    this.board = params.board;
    this.herdr = params.herdr;
    this.promptTemplate = params.promptTemplate;
    this.availableAgentKinds = params.availableAgentKinds;
    this.dryRun = params.dryRun;
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

    if (this.parkedTabs.size >= this.swarm.workerDefaults.maxParkedTabs && this.swarm.workerDefaults.maxParkedTabs > 0) {
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
        log(
          "INFO",
          `[dry-run] Would claim #${candidate.task.id} (${candidate.task.channel}) -> ${candidate.repoPath} using agent=${candidate.runtime.profileName} (${candidate.runtime.kind} ${candidate.runtime.cliArgs.join(" ")})`,
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

  private async claimAndSpawn(candidate: CandidateTask): Promise<boolean> {
    const { task, projectSlug, project, repoPath, useWorktree, runtime } = candidate;
    const boardProfile = `worker-${this.machineName}-${task.id}`;
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

    log(
      "INFO",
      `Claimed task #${task.id} (${task.channel}) as ${boardProfile} -> agent=${runtime.profileName} (${runtime.kind} ${runtime.cliArgs.join(" ")})`,
    );

    const env: Record<string, string> = {
      BOARD_PROFILE: boardProfile,
    };
    if (this.swarm.board.scope) {
      env.VERCEL_SCOPE = this.swarm.board.scope;
    }
    if (this.swarm.board.boardName) {
      env.VERCEL_BOARD_NAME = this.swarm.board.boardName;
    }

    const tabLabel = formatTabLabel(task.id, runtime.profileName);
    const agentName = sanitizeHerdrAgentName("w", task.id);
    const branch = `task/${task.id}`;

    try {
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

      const promptText = renderWorkerPrompt(this.promptTemplate, {
        taskId: task.id,
        channel: task.channel,
        project: projectSlug,
        boardProfile,
        branch,
        agentProfile: runtime.profileName,
        humanHandle: this.swarm.board.humanHandle,
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
        useWorktree,
        boardProfile,
        runtime,
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
        log("INFO", `Parked tab ${parked.tabId} for task #${taskId} was closed in Sheprd; freeing slot.`);
        this.parkedTabs.delete(taskId);
      }
    }

    const now = Date.now();
    const renewIntervalMs = this.swarm.board.leaseRenewIntervalSeconds * 1000;
    const idleTimeoutMs = this.swarm.workerDefaults.idleTimeoutSeconds * 1000;

    for (const worker of [...this.activeWorkers.values()]) {
      const boardTask = tasksById.get(worker.taskId);
      const boardState = boardTask?.state ?? "unknown";
      const tabExists = tabsById.has(worker.tabId);
      const liveAgent = agentsByPaneId.get(worker.paneId) ?? null;

      // 1. Completed or canceled on Board -> clean up tab/worktree and release slot
      if (boardState === "completed" || boardState === "canceled") {
        log("INFO", `Task #${worker.taskId} is ${boardState} on Board; cleaning up worker ${worker.agentName}.`);
        await this.cleanupFinishedWorker(worker, tabExists);
        this.activeWorkers.delete(worker.taskId);
        continue;
      }

      // 2. Blocked on Board -> park tab in Sheprd, stop lease renewal, free active slot
      if (boardState === "blocked") {
        log("INFO", `Task #${worker.taskId} marked blocked on Board; parking tab ${worker.tabId} in Sheprd.`);
        if (tabExists) {
          await this.safeRenameTab(
            worker.tabId,
            formatTabLabel(worker.taskId, worker.runtime.profileName, "BLOCKED"),
          );
          this.parkedTabs.set(worker.taskId, {
            taskId: worker.taskId,
            projectSlug: worker.projectSlug,
            useWorktree: worker.useWorktree,
            workspaceId: worker.workspaceId,
            tabId: worker.tabId,
            reason: "blocked",
            parkedAtMs: now,
          });
        }
        this.activeWorkers.delete(worker.taskId);
        continue;
      }

      // 3. Failed on Board -> park tab as [FAILED] in Sheprd
      if (boardState === "failed") {
        log("WARN", `Task #${worker.taskId} is failed on Board; parking tab ${worker.tabId} as [FAILED].`);
        if (tabExists) {
          await this.safeRenameTab(
            worker.tabId,
            formatTabLabel(worker.taskId, worker.runtime.profileName, "FAILED"),
          );
          this.parkedTabs.set(worker.taskId, {
            taskId: worker.taskId,
            projectSlug: worker.projectSlug,
            useWorktree: worker.useWorktree,
            workspaceId: worker.workspaceId,
            tabId: worker.tabId,
            reason: "failed",
            parkedAtMs: now,
          });
        }
        this.activeWorkers.delete(worker.taskId);
        continue;
      }

      // 4. Renew Board lease while still claimed
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
          this.parkedTabs.set(worker.taskId, {
            taskId: worker.taskId,
            projectSlug: worker.projectSlug,
            useWorktree: worker.useWorktree,
            workspaceId: worker.workspaceId,
            tabId: worker.tabId,
            reason: "failed",
            parkedAtMs: now,
          });
        }

        if (boardState === "claimed") {
          const snippet = tail.trim().slice(-1200);
          const msg = snippet
            ? `Worker \`${worker.agentName}\` on \`${this.machineName}\` exited before completing/blocking the task.\n\nLast terminal output:\n\`\`\`\n${snippet}\n\`\`\``
            : `Worker \`${worker.agentName}\` on \`${this.machineName}\` closed or exited before completing/blocking the task.`;
          await this.board.reply(worker.taskId, msg, { asProfile: worker.boardProfile }).catch(() => {});
          await this.board
            .failTask(worker.taskId, `Worker exited unexpectedly on ${this.machineName}`, {
              asProfile: worker.boardProfile,
            })
            .catch(() => {});
        }
        this.activeWorkers.delete(worker.taskId);
        continue;
      }

      if (!liveAgent) continue;

      // 6. Startup-blocked worker just became idle -> deliver initial prompt!
      if (!worker.promptSent && (liveAgent.agent_status === "idle" || liveAgent.agent_status === "done")) {
        try {
          await this.herdr.promptAgent(worker.agentName, worker.promptText);
          worker.promptSent = true;
          worker.uiBlockedNotified = false;
          worker.idleSinceMs = null;
          await this.safeRenameTab(
            worker.tabId,
            formatTabLabel(worker.taskId, worker.runtime.profileName),
          );
          log("INFO", `Delivered queued prompt to previously startup-blocked worker ${worker.agentName}.`);
        } catch (err) {
          log(
            "WARN",
            `Could not deliver queued prompt to ${worker.agentName}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        continue;
      }

      // 7. Herdr detected approval/question UI block
      if (liveAgent.agent_status === "blocked") {
        worker.idleSinceMs = null;
        if (!worker.uiBlockedNotified) {
          await this.markWorkerUiBlocked(
            worker,
            `Worker \`${worker.agentName}\` (${worker.runtime.profileName}) is waiting on an interactive prompt in Sheprd on \`${this.machineName}\` (workspace \`${worker.projectSlug}\`, tab \`${formatTabLabel(worker.taskId, worker.runtime.profileName, "BLOCKED")}\`).`,
          );
        }
        continue;
      }

      // 8. Recovered from UI block -> restore normal tab label
      if (liveAgent.agent_status === "working") {
        worker.idleSinceMs = null;
        if (worker.uiBlockedNotified) {
          worker.uiBlockedNotified = false;
          await this.safeRenameTab(
            worker.tabId,
            formatTabLabel(worker.taskId, worker.runtime.profileName),
          );
        }
        continue;
      }

      // 9. Worker went idle/done without updating the Board task state
      if (
        worker.promptSent &&
        boardState === "claimed" &&
        (liveAgent.agent_status === "idle" || liveAgent.agent_status === "done")
      ) {
        if (worker.idleSinceMs === null) {
          worker.idleSinceMs = now;
        } else if (now - worker.idleSinceMs >= idleTimeoutMs) {
          if (!worker.idleReminderSent) {
            worker.idleReminderSent = true;
            worker.idleSinceMs = now;
            log(
              "INFO",
              `Worker ${worker.agentName} idle while task #${worker.taskId} still claimed; sending completion/block reminder.`,
            );
            await this.herdr
              .promptAgent(
                worker.agentName,
                `Task #${worker.taskId} is still in state "claimed". If you finished, run \`vercel board tasks complete ${worker.taskId} "<summary>"\`. If you need input or approval, run \`vercel board tasks block ${worker.taskId} "<reason>" --kind needs_input\`.`,
              )
              .catch(() => {});
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
            this.parkedTabs.set(worker.taskId, {
              taskId: worker.taskId,
              projectSlug: worker.projectSlug,
              useWorktree: worker.useWorktree,
              workspaceId: worker.workspaceId,
              tabId: worker.tabId,
              reason: "blocked",
              parkedAtMs: now,
            });
            this.activeWorkers.delete(worker.taskId);
          }
        }
      }
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
      log("WARN", `maxWorkers is 0 for "${this.machineName}"; dispatcher will idle without claiming tasks.`);
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
  const projects = loadProjectsConfig(repoRoot);
  const machineName = resolveCurrentMachineName(swarm, flags.machine, "worker");
  const machineCfg = swarm.machines[machineName];
  if (!machineCfg) {
    throw new Error(`Machine "${machineName}" not found in config/swarm.json`);
  }

  const promptPath = resolve(repoRoot, "prompts/worker-prompt.md");
  const promptTemplate = readFileSync(promptPath, "utf8");

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
    machineName,
    board,
    herdr,
    promptTemplate,
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
    log("ERROR", err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}
