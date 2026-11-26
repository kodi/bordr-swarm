import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardClient, type BoardThreadSummary } from "./lib/board.ts";
import {
  buildAgentCliArgs,
  loadProjectsConfig,
  loadSwarmConfig,
  resolveCurrentMachineName,
  type ProjectsConfig,
  type SwarmConfig,
} from "./lib/config.ts";
import { HerdrClient, type HerdrAgent, type HerdrTab } from "./lib/herdr.ts";
import {
  buildLeadWakePrompt,
  collectLeadEvents,
  createEmptyLeadState,
  enqueueLeadEvents,
  type LeadWakeEvent,
  type LeadWatcherState,
} from "./lib/lead-events.ts";
import {
  buildLeadAgentName,
  formatLeadTabLabel,
  isLeadSessionParked,
  stepLeadSession,
  type LeadSession,
  type LeadSessionEffect,
} from "./lib/lead-fsm.ts";
import {
  catalogFingerprint,
  mergeRegistryIntoLeadCatalog,
  readAllMachineRegistryEntries,
} from "./lib/registry.ts";
import { assertNever } from "./lib/session-fsm.ts";

const LEAD_STARTUP_GRACE_MS = 20_000;

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
  const line = `[${ts}] [lead-watcher] [${level}] ${message}`;
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function parsePendingByThread(raw: unknown): Record<string, LeadWakeEvent[]> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, LeadWakeEvent[]> = {};
  for (const [threadId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const valid = list.filter(
      (item): item is LeadWakeEvent =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as LeadWakeEvent).kind === "string" &&
        typeof (item as LeadWakeEvent).channel === "string" &&
        typeof (item as LeadWakeEvent).threadId === "string" &&
        typeof (item as LeadWakeEvent).author === "string" &&
        typeof (item as LeadWakeEvent).preview === "string",
    );
    if (valid.length > 0) {
      out[threadId] = valid;
    }
  }
  return out;
}

function loadState(statePath: string): LeadWatcherState {
  if (!existsSync(statePath)) {
    return createEmptyLeadState();
  }
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<LeadWatcherState>;
    return {
      seenThreadLatestMsgId:
        typeof raw.seenThreadLatestMsgId === "object" && raw.seenThreadLatestMsgId !== null
          ? raw.seenThreadLatestMsgId
          : {},
      seenBlockedTaskIds: Array.isArray(raw.seenBlockedTaskIds) ? raw.seenBlockedTaskIds : [],
      pendingByThread: parsePendingByThread(raw.pendingByThread),
    };
  } catch (err) {
    log(
      "WARN",
      `Could not read state file ${statePath}; starting fresh: ${err instanceof Error ? err.message : String(err)}`,
    );
    return createEmptyLeadState();
  }
}

function saveState(statePath: string, state: LeadWatcherState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export class LeadWatcher {
  readonly swarm: SwarmConfig;
  readonly board: BoardClient;
  readonly herdr: HerdrClient;
  readonly statePath: string;
  readonly leadWorkspaceDir: string;
  readonly localProjectsPath: string | null;
  readonly dryRun: boolean;
  readonly now: () => number;

  private state: LeadWatcherState;
  private sessions = new Map<string, LeadSession>();
  private stopping = false;
  private parkedLimitWarned = false;
  private lastCatalogFingerprint = "";

  constructor(params: {
    swarm: SwarmConfig;
    board: BoardClient;
    herdr: HerdrClient;
    statePath: string;
    leadWorkspaceDir: string;
    localProjectsPath?: string | null;
    dryRun: boolean;
    now?: () => number;
  }) {
    this.swarm = params.swarm;
    this.board = params.board;
    this.herdr = params.herdr;
    this.statePath = params.statePath;
    this.leadWorkspaceDir = params.leadWorkspaceDir;
    this.localProjectsPath = params.localProjectsPath ?? null;
    this.dryRun = params.dryRun;
    this.now = params.now ?? (() => Date.now());
    this.state = loadState(params.statePath);
  }

  /** Exposed for observability and tests. */
  getTrackedSessions(): ReadonlyMap<string, LeadSession> {
    return this.sessions;
  }

  private persistState(): void {
    if (!this.dryRun) {
      saveState(this.statePath, this.state);
    }
  }

  private consumeQueuedEvents(threadId: string, count: number): void {
    const existing = this.state.pendingByThread[threadId];
    if (!existing || existing.length === 0) return;
    const remaining = existing.slice(count);
    if (remaining.length === 0) {
      delete this.state.pendingByThread[threadId];
    } else {
      this.state.pendingByThread[threadId] = remaining;
    }
    this.persistState();
  }

  private clearQueuedEvents(threadId: string): void {
    if (threadId in this.state.pendingByThread) {
      delete this.state.pendingByThread[threadId];
      this.persistState();
    }
  }

  private async syncRegistryCatalog(): Promise<void> {
    const entries = await readAllMachineRegistryEntries(
      this.board,
      this.swarm.board.registryChannel,
    ).catch(() => []);

    let localProjects: ProjectsConfig | null = null;
    if (this.localProjectsPath && existsSync(this.localProjectsPath)) {
      try {
        localProjects = loadProjectsConfig(process.cwd(), this.localProjectsPath);
      } catch {
        localProjects = null;
      }
    }

    if (entries.length === 0 && !localProjects) {
      return;
    }

    const catalog = mergeRegistryIntoLeadCatalog({ entries, localProjects });
    const fp = catalogFingerprint(catalog);
    if (fp === this.lastCatalogFingerprint) {
      return;
    }

    this.lastCatalogFingerprint = fp;
    if (this.dryRun) {
      log(
        "INFO",
        `[dry-run] Would sync ${Object.keys(catalog.projects).length} project(s) from #${this.swarm.board.registryChannel} into ${resolve(this.leadWorkspaceDir, "projects.json")}`,
      );
      return;
    }

    const dest = resolve(this.leadWorkspaceDir, "projects.json");
    mkdirSync(this.leadWorkspaceDir, { recursive: true });
    // Replace any legacy symlink so we never overwrite repo-local config/projects.json
    try {
      if (lstatSync(dest).isSymbolicLink()) {
        unlinkSync(dest);
      }
    } catch {
      // Destination does not exist yet
    }
    writeFileSync(dest, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    log(
      "INFO",
      `Synced #${this.swarm.board.registryChannel} -> ${dest} (${Object.keys(catalog.machines).length} machine(s), ${Object.keys(catalog.projects).length} project(s)).`,
    );
  }

  requestStop(): void {
    this.stopping = true;
  }

  private async applySessionEffects(effects: LeadSessionEffect[]): Promise<boolean> {
    for (const effect of effects) {
      switch (effect.type) {
        case "rename_tab": {
          await this.herdr.renameTab(effect.tabId, effect.label).catch((err) => {
            log(
              "WARN",
              `Could not rename Lead tab ${effect.tabId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
          break;
        }
        case "deliver_prompt": {
          const prompt = buildLeadWakePrompt(effect.events);
          try {
            await this.herdr.promptAgent(effect.agentName, prompt);
            this.consumeQueuedEvents(effect.threadId, effect.events.length);
            log(
              "INFO",
              `Delivered ${effect.events.length} event(s) to Lead "${effect.agentName}" for thread ${effect.threadId}.`,
            );
          } catch (err) {
            log(
              "ERROR",
              `Failed to prompt Lead "${effect.agentName}" for thread ${effect.threadId}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return false;
          }
          break;
        }
        case "clear_queued_events": {
          this.clearQueuedEvents(effect.threadId);
          break;
        }
        case "close_tab": {
          await this.herdr.closeTab(effect.tabId).catch((err) => {
            log(
              "WARN",
              `Could not close Lead tab ${effect.tabId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
          break;
        }
        case "log": {
          log(effect.level, effect.message);
          break;
        }
        default:
          return assertNever(effect);
      }
    }
    return true;
  }

  private async reconcileSessions(): Promise<void> {
    if (this.sessions.size === 0) {
      return;
    }

    const [tabs, agents] = await Promise.all([this.herdr.listTabs(), this.herdr.listAgents()]);
    const tabsById = new Map<string, HerdrTab>(tabs.map((t) => [t.tab_id, t]));
    const agentsByName = new Map<string, HerdrAgent>();
    const agentsByPane = new Map<string, HerdrAgent>();
    for (const a of agents) {
      if (a.name) agentsByName.set(a.name, a);
      agentsByPane.set(a.pane_id, a);
    }

    const nowMs = this.now();
    const idleCloseMs = this.swarm.lead.idleCloseSeconds * 1000;

    for (const [threadId, session] of this.sessions.entries()) {
      const tabExists = tabsById.has(session.tabId);
      const liveAgent =
        agentsByName.get(session.agentName) ?? agentsByPane.get(session.paneId) ?? null;
      const pendingEventsForThread = this.state.pendingByThread[threadId] ?? [];

      const outcome = stepLeadSession(session, {
        tabExists,
        agentStatus: liveAgent?.agent_status ?? null,
        pendingEventsForThread,
        nowMs,
        startupGraceMs: LEAD_STARTUP_GRACE_MS,
        idleCloseMs,
      });

      const ok = await this.applySessionEffects(outcome.effects);
      if (!ok) {
        // Keep previous session state so next tick retries failed prompt delivery
        continue;
      }

      if (outcome.status === "active") {
        this.sessions.set(threadId, outcome.next);
      } else {
        this.sessions.delete(threadId);
      }
    }
  }

  private async spawnSessionForThread(threadId: string): Promise<"active" | "parked" | "failed"> {
    const events = this.state.pendingByThread[threadId] ?? [];
    if (events.length === 0) {
      return "failed";
    }

    const agentName = buildLeadAgentName(this.swarm.lead.boardProfile, threadId);
    const nowMs = this.now();

    // If an orphaned session for this exact thread still exists in Herdr (e.g. after daemon restart), adopt it
    const existing = await this.herdr.getAgent(agentName).catch(() => null);
    if (existing?.tab_id) {
      const isBlocked = existing.agent_status === "blocked";
      if (isBlocked) {
        await this.herdr
          .renameTab(existing.tab_id, formatLeadTabLabel(threadId, "BLOCKED"))
          .catch(() => {});
        this.sessions.set(threadId, {
          threadId,
          agentName,
          tabId: existing.tab_id,
          paneId: existing.pane_id,
          startedAtMs: nowMs,
          phase: { kind: "startup_blocked" },
        });
        log(
          "WARN",
          `Adopted existing blocked Lead "${agentName}" in tab ${existing.tab_id} for thread ${threadId}.`,
        );
        return "parked";
      }

      if (existing.agent_status === "idle" || existing.agent_status === "done") {
        await this.herdr.promptAgent(agentName, buildLeadWakePrompt(events));
        this.consumeQueuedEvents(threadId, events.length);
        this.sessions.set(threadId, {
          threadId,
          agentName,
          tabId: existing.tab_id,
          paneId: existing.pane_id,
          startedAtMs: nowMs,
          phase: { kind: "prompt_sent", promptedAtMs: nowMs },
        });
        log(
          "INFO",
          `Adopted idle Lead "${agentName}" in tab ${existing.tab_id} and delivered ${events.length} event(s) for thread ${threadId}.`,
        );
        return "active";
      }

      // Already working; adopt and let reconcileSessions deliver queued events once idle
      this.sessions.set(threadId, {
        threadId,
        agentName,
        tabId: existing.tab_id,
        paneId: existing.pane_id,
        startedAtMs: nowMs,
        phase: { kind: "working" },
      });
      log(
        "INFO",
        `Adopted running Lead "${agentName}" in tab ${existing.tab_id} for thread ${threadId}.`,
      );
      return "active";
    }

    const env: Record<string, string> = {
      BOARD_PROFILE: this.swarm.lead.boardProfile,
    };
    if (this.swarm.board.scope) env.VERCEL_SCOPE = this.swarm.board.scope;
    if (this.swarm.board.boardName) env.VERCEL_BOARD_NAME = this.swarm.board.boardName;

    const leadArgs = buildAgentCliArgs({
      kind: "claude",
      model: this.swarm.lead.model,
      effort: this.swarm.lead.effort,
      permissionMode: this.swarm.lead.permissionMode,
      extraArgs: [],
    });

    const pane = await this.herdr.findOrCreateProjectTab({
      workspaceLabel: "swarm-hq",
      cwd: this.leadWorkspaceDir,
      tabLabel: formatLeadTabLabel(threadId),
      env,
    });

    try {
      const startRes = await this.herdr.startAgent({
        name: agentName,
        kind: "claude",
        paneId: pane.paneId,
        args: leadArgs,
        timeoutMs: 60_000,
      });

      if (startRes.blockedOnStartup) {
        await this.herdr
          .renameTab(pane.tabId, formatLeadTabLabel(threadId, "BLOCKED"))
          .catch(() => {});
        this.sessions.set(threadId, {
          threadId,
          agentName,
          tabId: pane.tabId,
          paneId: pane.paneId,
          startedAtMs: nowMs,
          phase: { kind: "startup_blocked" },
        });
        log(
          "WARN",
          `Spawned ephemeral Lead "${agentName}" in ${pane.tabId} for thread ${threadId}, waiting on startup prompt in Sheprd.`,
        );
        return "parked";
      }

      await this.herdr.promptAgent(agentName, buildLeadWakePrompt(events));
      this.consumeQueuedEvents(threadId, events.length);

      this.sessions.set(threadId, {
        threadId,
        agentName,
        tabId: pane.tabId,
        paneId: pane.paneId,
        startedAtMs: nowMs,
        phase: { kind: "prompt_sent", promptedAtMs: nowMs },
      });

      log(
        "INFO",
        `Spawned ephemeral Lead "${agentName}" in ${pane.tabId} for thread ${threadId} (${events.length} event(s)).`,
      );
      return "active";
    } catch (err) {
      log(
        "ERROR",
        `Failed to spawn Lead "${agentName}" for thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.herdr.closeTab(pane.tabId).catch(() => {});
      return "failed";
    }
  }

  private async dispatchQueuedThreads(): Promise<void> {
    const queuedThreadIds = Object.keys(this.state.pendingByThread).filter(
      (threadId) =>
        (this.state.pendingByThread[threadId]?.length ?? 0) > 0 && !this.sessions.has(threadId),
    );
    if (queuedThreadIds.length === 0) {
      return;
    }

    let activeCount = 0;
    let parkedCount = 0;
    for (const session of this.sessions.values()) {
      if (isLeadSessionParked(session)) parkedCount += 1;
      else activeCount += 1;
    }

    const maxConcurrent = this.swarm.lead.maxConcurrentSessions;
    const maxParked = this.swarm.lead.maxParkedTabs;

    if (maxParked > 0 && parkedCount >= maxParked) {
      if (!this.parkedLimitWarned) {
        log(
          "WARN",
          `Paused spawning new Lead sessions: ${parkedCount}/${maxParked} parked [BLOCKED]/[FAILED] Lead tab(s) in Sheprd.`,
        );
        this.parkedLimitWarned = true;
      }
      return;
    }
    this.parkedLimitWarned = false;

    for (const threadId of queuedThreadIds) {
      if (activeCount >= maxConcurrent) {
        break;
      }
      if (maxParked > 0 && parkedCount >= maxParked) {
        break;
      }
      const res = await this.spawnSessionForThread(threadId);
      if (res === "active") activeCount += 1;
      else if (res === "parked") parkedCount += 1;
    }
  }

  async tick(): Promise<void> {
    await this.syncRegistryCatalog();

    const inboxChannel = this.swarm.board.inboxChannel;
    const prefix = this.swarm.board.projectChannelPrefix;

    const [inboxRes, projectChannels, blockedTasks] = await Promise.all([
      this.board.readChannel(inboxChannel, { limit: 30 }),
      this.board.listChannels(prefix).catch(() => [] as string[]),
      this.board.listTasks(prefix, { state: "blocked", limit: 100 }),
    ]);

    const projectThreadsByChannel: Record<string, BoardThreadSummary[]> = {};
    for (const ch of projectChannels) {
      const res = await this.board.readChannel(ch, { limit: 25 });
      projectThreadsByChannel[ch] = res.threads;
    }

    const { events, nextState } = collectLeadEvents({
      inboxChannel,
      inboxThreads: inboxRes.threads,
      projectThreadsByChannel,
      blockedTasks,
      leadProfile: this.swarm.lead.boardProfile,
      state: this.state,
    });

    if (events.length > 0) {
      log("INFO", `Detected ${events.length} new Board event(s) for Lead.`);
      this.state = {
        ...nextState,
        pendingByThread: enqueueLeadEvents(nextState.pendingByThread, events),
      };
      this.persistState();
    } else if (
      nextState.seenBlockedTaskIds.length !== this.state.seenBlockedTaskIds.length ||
      Object.keys(nextState.seenThreadLatestMsgId).length !==
        Object.keys(this.state.seenThreadLatestMsgId).length
    ) {
      this.state = nextState;
      this.persistState();
    }

    if (this.dryRun) {
      for (const [threadId, threadEvents] of Object.entries(this.state.pendingByThread)) {
        if (threadEvents.length === 0) continue;
        log(
          "INFO",
          `[dry-run] Would spawn ephemeral Lead "${buildLeadAgentName(this.swarm.lead.boardProfile, threadId)}" for thread ${threadId}:\n${buildLeadWakePrompt(threadEvents)}`,
        );
      }
      this.state.pendingByThread = {};
      return;
    }

    await this.reconcileSessions();
    await this.dispatchQueuedThreads();
  }

  async runLoop(once: boolean): Promise<void> {
    log(
      "INFO",
      `Starting Lead Watcher (mode=ephemeral, inbox=#${this.swarm.board.inboxChannel}, prefix=${this.swarm.board.projectChannelPrefix}, profile=${this.swarm.lead.boardProfile}, maxConcurrent=${this.swarm.lead.maxConcurrentSessions}, idleClose=${this.swarm.lead.idleCloseSeconds}s, poll=${this.swarm.lead.pollIntervalSeconds}s, dryRun=${this.dryRun})`,
    );

    if (!this.dryRun) {
      await this.board
        .ensureChannel(this.swarm.board.inboxChannel, { asProfile: this.swarm.lead.boardProfile })
        .catch((err) => {
          log(
            "WARN",
            `Could not pre-create #${this.swarm.board.inboxChannel}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    while (!this.stopping) {
      try {
        await this.tick();
      } catch (err) {
        log(
          "ERROR",
          `Lead Watcher tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (once || this.stopping) break;
      await sleep(this.swarm.lead.pollIntervalSeconds * 1000);
    }

    log("INFO", "Lead Watcher stopped cleanly.");
  }
}

async function main(): Promise<void> {
  const flags = parseCliFlags(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const home = homedir();

  const swarm = loadSwarmConfig(repoRoot);
  const machineName = resolveCurrentMachineName(swarm, flags.machine ?? swarm.lead.machine, "main");
  const machineCfg = swarm.machines[machineName];
  if (!machineCfg) {
    throw new Error(`Machine "${machineName}" not found in config/swarm.json`);
  }

  const leadWorkspaceDir = swarm.lead.workspaceDir.startsWith("~/")
    ? resolve(home, swarm.lead.workspaceDir.slice(2))
    : swarm.lead.workspaceDir;

  const statePath =
    process.env.LEAD_WATCHER_STATE_PATH ??
    resolve(home, ".local/state/bordr-swarm/lead-watcher-state.json");

  const watcher = new LeadWatcher({
    swarm,
    board: new BoardClient({
      scope: swarm.board.scope,
      boardName: swarm.board.boardName,
    }),
    herdr: new HerdrClient({ target: machineCfg.herdrTarget }),
    statePath,
    leadWorkspaceDir,
    localProjectsPath:
      process.env.PROJECTS_CONFIG_PATH ?? resolve(repoRoot, "config/projects.json"),
    dryRun: flags.dryRun,
  });

  const onSignal = (sig: NodeJS.Signals) => {
    log("INFO", `Received ${sig}; stopping Lead Watcher...`);
    watcher.requestStop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  await watcher.runLoop(flags.once);
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    log("ERROR", err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
