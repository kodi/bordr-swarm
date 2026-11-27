import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
  type CollectedEffect,
  type EffectHandlers,
  type Reactor,
} from "./bus/reactor.ts";
import { WakeScheduler, type WakeRunInfo } from "./bus/scheduler.ts";
import { realTimers, type Timers } from "./bus/timers.ts";
import { BoardClient, type BoardMessage, type BoardThreadSummary } from "./lib/board.ts";
import {
  buildAgentCliArgs,
  DEFAULT_RECONCILE_INTERVAL_SECONDS,
  loadProjectsConfig,
  loadSwarmConfig,
  resolveCurrentMachineName,
  type ProjectsConfig,
  type SwarmConfig,
} from "./lib/config.ts";
import { HerdrClient, type HerdrAgent, type HerdrTab } from "./lib/herdr.ts";
import {
  applyLiveBoardEventToState,
  buildLeadWakePrompt,
  collectLeadEvents,
  createEmptyLeadState,
  enqueueLeadEvents,
  isMessageAlreadyHandled,
  LEAD_ACK_EMOJI,
  selectMessagesToAcknowledge,
  selectThreadsNeedingRead,
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
import { createBuiltinLeadReactors, type LeadReactorContext } from "./reactors/lead.ts";

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

function parseNumberRecord(raw: unknown): Record<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Loads Lead Watcher state. Tolerant: unknown or malformed fields fall back to empty values, so
 * a state file from before the event bus (no cursor, counts, or handled IDs) loads unchanged.
 */
export function loadLeadWatcherState(statePath: string): LeadWatcherState {
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
      seenThreadReplyCount: parseNumberRecord(raw.seenThreadReplyCount),
      seenThreadLastSeenMs: parseNumberRecord(raw.seenThreadLastSeenMs),
      handledMessageIds: Array.isArray(raw.handledMessageIds)
        ? raw.handledMessageIds.filter((id): id is string => typeof id === "string")
        : [],
      ...(typeof raw.tailCursor === "string" && raw.tailCursor
        ? { tailCursor: raw.tailCursor }
        : {}),
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
  private readonly stopWaiters: Array<() => void> = [];
  private parkedLimitWarned = false;
  private lastCatalogFingerprint = "";
  private lastPersistedJson = "";
  /** Live Board events waiting for the next tick (drained in order at its start). */
  private liveQueue: SwarmEvent[] = [];
  private readonly events: DaemonEventWiring | null;
  private readonly timers: Timers;
  private scheduler: WakeScheduler | null = null;
  /** Built-in (and configured) "when X, do Y" rules. */
  readonly reactors: ReactorRegistry<LeadReactorContext>;

  constructor(params: {
    swarm: SwarmConfig;
    board: BoardClient;
    herdr: HerdrClient;
    statePath: string;
    leadWorkspaceDir: string;
    localProjectsPath?: string | null;
    dryRun: boolean;
    now?: () => number;
    /** Live Board/Herdr events; omitted, Lead Watcher polls exactly as before. */
    events?: DaemonEventWiring;
    timers?: Timers;
    /** Additional reactors (config-driven ones), run after the built-ins. */
    extraReactors?: Array<Reactor<LeadReactorContext>>;
  }) {
    this.swarm = params.swarm;
    this.board = params.board;
    this.herdr = params.herdr;
    this.statePath = params.statePath;
    this.leadWorkspaceDir = params.leadWorkspaceDir;
    this.localProjectsPath = params.localProjectsPath ?? null;
    this.dryRun = params.dryRun;
    this.now = params.now ?? (() => Date.now());
    this.state = loadLeadWatcherState(params.statePath);
    this.events = params.events ?? null;
    this.timers = params.timers ?? realTimers;
    this.reactors = new ReactorRegistry<LeadReactorContext>(
      [
        ...createBuiltinLeadReactors({
          inboxChannel: this.swarm.board.inboxChannel,
          projectChannelPrefix: this.swarm.board.projectChannelPrefix,
          registryChannel: this.swarm.board.registryChannel,
          leadProfile: this.swarm.lead.boardProfile,
        }),
        ...(params.extraReactors ?? []),
      ],
      log,
    );
  }

  private reactorContext(): LeadReactorContext {
    const sessions = [...this.sessions.values()];
    return {
      sessionPaneIds: new Set(sessions.map((s) => s.paneId)),
      sessionTabIds: new Set(sessions.map((s) => s.tabId)),
    };
  }

  /** Persisted Board tail cursor (resume point for `tail --after`). */
  get tailCursor(): string | undefined {
    return this.state.tailCursor;
  }

  /** The tail rejected our cursor: forget it and run a full catch-up reconcile. */
  onTailCursorRejected(): void {
    const { tailCursor: _dropped, ...rest } = this.state;
    this.state = rest;
    this.persistState();
    log("WARN", "Board tail rejected the saved cursor; running a full catch-up reconcile.");
    this.scheduler?.requestReconcile("cursor_rejected");
  }

  /** Periodic reconcile interval for the current source health and open sessions. */
  currentIntervalMs(): number {
    const lead = this.swarm.lead;
    const hasQueued = Object.values(this.state.pendingByThread).some((l) => l.length > 0);
    return selectReconcileIntervalMs({
      sourcesHealthy: this.events?.health.allHealthy ?? false,
      // Idle-close, startup grace, and queued follow-ups are clock-driven.
      timeSensitiveWork: this.sessions.size > 0 || hasQueued,
      pollMs: lead.pollIntervalSeconds * 1000,
      reconcileMs: (lead.reconcileIntervalSeconds ?? DEFAULT_RECONCILE_INTERVAL_SECONDS) * 1000,
    });
  }

  /**
   * Bus subscriber. Board events are queued for the next tick (so live and catch-up handling
   * never interleave) and wake it when they can matter to Lead; Herdr events for Lead's own
   * panes or tabs wake it too.
   */
  handleEvent(event: SwarmEvent): void {
    switch (event.kind) {
      case "source.health":
        if (this.events?.health.apply(event)) {
          log(
            event.healthy ? "INFO" : "WARN",
            describeHealth(this.events.health, this.currentIntervalMs()),
          );
          this.scheduler?.refreshInterval();
        }
        return;
      case "board.message":
      case "board.task":
      case "board.reaction":
      case "board.other":
        // Effects for Board events are computed when the tick drains the queue (after
        // de-duplication); here we only decide whether the event is worth waking for.
        this.liveQueue.push(event);
        if (this.reactors.matchesAny(event)) this.scheduler?.wake(event.kind);
        return;
      default: {
        const effects = this.reactors.collect(event, this.reactorContext());
        if (effects.length > 0) {
          void executeEffects(
            effects,
            { wake: (effect) => this.scheduler?.wake(effect.reason) },
            log,
          );
        }
      }
    }
  }

  /**
   * Applies queued live Board events in order: derives Lead wake events (skipping messages the
   * catch-up path or a replay already handled), collects 👀 targets, and advances seen markers
   * and the tail cursor.
   */
  private drainLiveEvents(): {
    events: LeadWakeEvent[];
    acks: Array<{ messageId: string; threadId: string }>;
    registryChanged: boolean;
  } {
    const queued = this.liveQueue;
    this.liveQueue = [];
    const board = this.swarm.board;
    const ctx = {
      inboxChannel: board.inboxChannel,
      projectChannelPrefix: board.projectChannelPrefix,
      nowMs: this.now(),
    };
    const events: LeadWakeEvent[] = [];
    const acks: Array<{ messageId: string; threadId: string }> = [];
    let registryChanged = false;

    for (const event of queued) {
      const duplicate =
        (event.kind === "board.message" && isMessageAlreadyHandled(event.message, this.state)) ||
        (event.kind === "board.task" &&
          event.op === "blocked" &&
          this.state.seenBlockedTaskIds.includes(event.task.id));
      const effects: CollectedEffect[] = duplicate
        ? []
        : this.reactors.collect(event, this.reactorContext());

      const handledIds: string[] = [];
      for (const { reactor, effect } of effects) {
        switch (effect.type) {
          case "lead_event":
            events.push(effect.event);
            if (effect.event.latestMessageId) handledIds.push(effect.event.latestMessageId);
            break;
          case "react":
            acks.push({ messageId: effect.messageId, threadId: effect.threadId });
            break;
          case "registry_sync":
            registryChanged = true;
            break;
          case "wake":
            break;
          default:
            this.deferredEffects.push({ reactor, effect });
        }
      }
      this.state = applyLiveBoardEventToState(this.state, event, ctx, handledIds);
    }
    return { events, acks, registryChanged };
  }

  /** Effects other than Lead's own (commands, posts) run after the tick's triage. */
  private deferredEffects: CollectedEffect[] = [];

  /** Handlers for effects that are not part of Lead's triage (config-driven reactors). */
  protected extraEffectHandlers(): EffectHandlers {
    return {};
  }

  private async reactAck(messageId: string, threadId: string): Promise<void> {
    const leadProfile = this.swarm.lead.boardProfile;
    if (this.dryRun) {
      log("INFO", `[dry-run] Would react ${LEAD_ACK_EMOJI} on ${messageId} as "${leadProfile}".`);
      return;
    }
    try {
      await this.board.react(messageId, LEAD_ACK_EMOJI, { asProfile: leadProfile });
      log("INFO", `Reacted ${LEAD_ACK_EMOJI} on ${messageId} (thread ${threadId}).`);
    } catch (err) {
      log(
        "WARN",
        `Could not react ${LEAD_ACK_EMOJI} on ${messageId} (thread ${threadId}); continuing with triage: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Exposed for observability and tests. */
  getTrackedSessions(): ReadonlyMap<string, LeadSession> {
    return this.sessions;
  }

  private persistState(): void {
    if (this.dryRun) return;
    const json = JSON.stringify(this.state);
    if (json === this.lastPersistedJson) return;
    saveState(this.statePath, this.state);
    this.lastPersistedJson = json;
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
    for (const resolveStop of this.stopWaiters.splice(0)) resolveStop();
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
    const boardUrl = (this.swarm.board.url || process.env.BOARD_URL || "").trim();
    if (boardUrl) {
      env.BOARD_URL = boardUrl;
    } else {
      if (this.swarm.board.scope) env.VERCEL_SCOPE = this.swarm.board.scope;
      if (this.swarm.board.boardName) env.VERCEL_BOARD_NAME = this.swarm.board.boardName;
    }
    const boardToken = (process.env.BOARD_TOKEN || "").trim();
    if (boardToken) {
      env.BOARD_TOKEN = boardToken;
    }

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

  /**
   * React 👀 (as Lead) on new human messages of a detected `#inbox` event, before any Lead
   * session is spawned or prompted. Best-effort: failures are logged and never block triage.
   * Duplicates are avoided twice over: the persisted seen-state stops re-detection, and
   * messages already carrying Lead's 👀 are skipped (e.g. after a restart mid-tick).
   */
  private async acknowledgeInboxEvent(
    event: LeadWakeEvent,
    summary: BoardThreadSummary | undefined,
    sinceMessageId: string | undefined,
  ): Promise<void> {
    const leadProfile = this.swarm.lead.boardProfile;
    let messages: BoardMessage[];
    let since = sinceMessageId;
    try {
      const detail = await this.board.readThread(event.threadId);
      messages = [detail.message, ...detail.replies];
    } catch (err) {
      log(
        "WARN",
        `Could not read #${event.channel} thread ${event.threadId} for 👀 acknowledgement; falling back to its latest message: ${err instanceof Error ? err.message : String(err)}`,
      );
      messages = summary ? [summary.last ?? summary.message] : [];
      since = undefined;
    }

    const ids = selectMessagesToAcknowledge({ messages, sinceMessageId: since, leadProfile });
    for (const messageId of ids) {
      await this.reactAck(messageId, event.threadId);
    }
  }

  /**
   * One Lead Watcher pass. Live Board events queued since the last pass are handled first (👀
   * and wake events, no channel reads). A periodic pass (`tick()` with no argument, the first
   * pass, the interval timer, or any pass while live events are down) also runs the full
   * catch-up: registry sync, #inbox and every project channel, blocked tasks.
   */
  async tick(info: Pick<WakeRunInfo, "periodic"> = { periodic: true }): Promise<void> {
    try {
      await this.runTick(info.periodic || !(this.events?.health.isHealthy("board") ?? false));
    } finally {
      this.persistState();
      this.events?.paneWatcher?.setWatchedPanes([...this.sessions.values()].map((s) => s.paneId));
    }
  }

  private async runTick(fullReconcile: boolean): Promise<void> {
    const live = this.drainLiveEvents();
    if (fullReconcile || live.registryChanged) {
      await this.syncRegistryCatalog();
    }

    // 👀 first: acknowledge new human #inbox messages before any Lead session is spawned/prompted
    for (const ack of live.acks) {
      await this.reactAck(ack.messageId, ack.threadId);
    }

    const events: LeadWakeEvent[] = [...live.events];
    if (fullReconcile) {
      events.push(...(await this.collectCatchUpEvents()));
    }

    if (events.length > 0) {
      log("INFO", `Detected ${events.length} new Board event(s) for Lead.`);
      this.state = {
        ...this.state,
        pendingByThread: enqueueLeadEvents(this.state.pendingByThread, events),
      };
    }
    this.persistState();

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
    await this.runDeferredEffects();
  }

  private async runDeferredEffects(): Promise<void> {
    const effects = this.deferredEffects;
    this.deferredEffects = [];
    if (effects.length > 0) await executeEffects(effects, this.extraEffectHandlers(), log);
  }

  /** Full poll of #inbox, project channels, and blocked tasks (the pre-bus detection path). */
  private async collectCatchUpEvents(): Promise<LeadWakeEvent[]> {
    const inboxChannel = this.swarm.board.inboxChannel;
    const prefix = this.swarm.board.projectChannelPrefix;
    const leadProfile = this.swarm.lead.boardProfile;

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

    // Threads that advanced by more than one reply need a full read so no mention is skipped.
    const threadMessages: Record<string, BoardMessage[]> = {};
    for (const rootId of selectThreadsNeedingRead({
      projectThreadsByChannel,
      leadProfile,
      state: this.state,
    })) {
      try {
        const detail = await this.board.readThread(rootId);
        threadMessages[rootId] = [detail.message, ...detail.replies];
      } catch (err) {
        log(
          "WARN",
          `Could not read thread ${rootId} to check skipped replies for @${leadProfile}; checking its latest message only: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const { events, nextState } = collectLeadEvents({
      inboxChannel,
      inboxThreads: inboxRes.threads,
      projectThreadsByChannel,
      blockedTasks,
      leadProfile,
      state: this.state,
      threadMessages,
      nowMs: this.now(),
    });

    const inboxSummaries = new Map(inboxRes.threads.map((t) => [t.message.id, t]));
    for (const ev of events) {
      if (ev.kind !== "inbox") continue;
      await this.acknowledgeInboxEvent(
        ev,
        inboxSummaries.get(ev.threadId),
        this.state.seenThreadLatestMsgId[ev.threadId],
      );
    }

    this.state = { ...nextState, pendingByThread: this.state.pendingByThread };
    return events;
  }

  async runLoop(once: boolean): Promise<void> {
    // Subscribe before any await so no health or Board event published at startup is missed.
    const unsubscribe = once
      ? undefined
      : this.events?.bus.subscribe((event) => this.handleEvent(event));
    log(
      "INFO",
      `Starting Lead Watcher (mode=ephemeral, inbox=#${this.swarm.board.inboxChannel}, prefix=${this.swarm.board.projectChannelPrefix}, profile=${this.swarm.lead.boardProfile}, maxConcurrent=${this.swarm.lead.maxConcurrentSessions}, idleClose=${this.swarm.lead.idleCloseSeconds}s, poll=${this.swarm.lead.pollIntervalSeconds}s, dryRun=${this.dryRun})`,
    );

    if (!once) log("INFO", describeReactors("Lead Watcher", this.reactors.names));

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

    if (once) {
      try {
        await this.tick();
      } catch (err) {
        log(
          "ERROR",
          `Lead Watcher tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (!this.stopping) {
      const scheduler = new WakeScheduler({
        run: (info) => this.tick(info),
        intervalMs: () => this.currentIntervalMs(),
        timers: this.timers,
        onError: (err) =>
          log(
            "ERROR",
            `Lead Watcher tick failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
      });
      this.scheduler = scheduler;
      const stopped = new Promise<void>((resolveStop) => {
        this.stopWaiters.push(resolveStop);
        if (this.stopping) resolveStop();
      });
      scheduler.start();
      await stopped;
      await scheduler.stop();
      this.scheduler = null;
    }
    unsubscribe?.();

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

  const board = new BoardClient({
    url: swarm.board.url,
    scope: swarm.board.scope,
    boardName: swarm.board.boardName,
    binary: process.env.BOARD_CLI_BIN,
    onWarn: (message) => log("WARN", message),
  });
  let watcher: LeadWatcher | null = null;
  const sources = flags.once
    ? null
    : createDaemonEventSources({
        swarm,
        board,
        herdrTarget: machineCfg.herdrTarget,
        // Unfiltered: Lead needs #inbox, the project prefix, and the registry channel.
        tailAfter: flags.dryRun ? undefined : loadLeadWatcherState(statePath).tailCursor,
        onCursorRejected: () => watcher?.onTailCursorRejected(),
        log,
      });

  watcher = new LeadWatcher({
    swarm,
    board,
    events: sources ?? undefined,
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
  // Never leave a `board tail` child behind, even on an unexpected exit.
  process.on("exit", () => sources?.killNow());

  sources?.start();
  try {
    await watcher.runLoop(flags.once);
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
