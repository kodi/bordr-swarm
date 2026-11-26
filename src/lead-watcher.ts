import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardClient, type BoardThreadSummary } from "./lib/board.ts";
import {
  buildAgentCliArgs,
  loadSwarmConfig,
  resolveCurrentMachineName,
  type SwarmConfig,
} from "./lib/config.ts";
import { HerdrClient, sanitizeHerdrAgentName } from "./lib/herdr.ts";
import {
  buildLeadWakePrompt,
  collectLeadEvents,
  createEmptyLeadState,
  type LeadWakeEvent,
  type LeadWatcherState,
} from "./lib/lead-events.ts";

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
  readonly leadAgentName: string;
  readonly dryRun: boolean;

  private state: LeadWatcherState;
  private pendingEvents: LeadWakeEvent[] = [];
  private stopping = false;
  private startupWarnedBlocked = false;

  constructor(params: {
    swarm: SwarmConfig;
    board: BoardClient;
    herdr: HerdrClient;
    statePath: string;
    leadWorkspaceDir: string;
    dryRun: boolean;
  }) {
    this.swarm = params.swarm;
    this.board = params.board;
    this.herdr = params.herdr;
    this.statePath = params.statePath;
    this.leadWorkspaceDir = params.leadWorkspaceDir;
    this.leadAgentName = sanitizeHerdrAgentName(params.swarm.lead.boardProfile, "");
    this.dryRun = params.dryRun;
    this.state = loadState(params.statePath);
  }

  requestStop(): void {
    this.stopping = true;
  }

  private async ensureLeadAgent(): Promise<"ready" | "busy" | "blocked"> {
    const existing = await this.herdr.getAgent(this.leadAgentName);
    if (existing) {
      if (existing.agent_status === "idle" || existing.agent_status === "done") {
        this.startupWarnedBlocked = false;
        return "ready";
      }
      if (existing.agent_status === "blocked") {
        if (!this.startupWarnedBlocked) {
          log(
            "WARN",
            `Lead agent "${this.leadAgentName}" is currently blocked in Sheprd (pane ${existing.pane_id}); queuing ${this.pendingEvents.length} event(s) until unblocked.`,
          );
          this.startupWarnedBlocked = true;
        }
        return "blocked";
      }
      return "busy";
    }

    // Lead is not running in Herdr yet -> auto-start it in ~/swarm-hq
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
      tabLabel: this.leadAgentName,
      env,
    });

    const startRes = await this.herdr.startAgent({
      name: this.leadAgentName,
      kind: "claude",
      paneId: pane.paneId,
      args: leadArgs,
      timeoutMs: 60_000,
    });

    if (startRes.blockedOnStartup) {
      log(
        "WARN",
        `Auto-started Lead agent "${this.leadAgentName}" in ${pane.tabId}, waiting on startup prompt in Sheprd.`,
      );
      this.startupWarnedBlocked = true;
      return "blocked";
    }

    log("INFO", `Auto-started Lead agent "${this.leadAgentName}" in ${pane.tabId}.`);
    return "ready";
  }

  async tick(): Promise<void> {
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
      this.pendingEvents.push(...events);
      this.state = nextState;
      if (!this.dryRun) {
        saveState(this.statePath, this.state);
      }
    } else if (
      nextState.seenBlockedTaskIds.length !== this.state.seenBlockedTaskIds.length ||
      Object.keys(nextState.seenThreadLatestMsgId).length !==
        Object.keys(this.state.seenThreadLatestMsgId).length
    ) {
      this.state = nextState;
      if (!this.dryRun) {
        saveState(this.statePath, this.state);
      }
    }

    if (this.pendingEvents.length === 0) {
      return;
    }

    if (this.dryRun) {
      log(
        "INFO",
        `[dry-run] Would wake Lead with prompt:\n${buildLeadWakePrompt(this.pendingEvents)}`,
      );
      this.pendingEvents = [];
      return;
    }

    const readiness = await this.ensureLeadAgent();
    if (readiness !== "ready") {
      return;
    }

    const batch = this.pendingEvents;
    const prompt = buildLeadWakePrompt(batch);
    await this.herdr.promptAgent(this.leadAgentName, prompt);
    this.pendingEvents = [];
    log("INFO", `Woke Lead agent "${this.leadAgentName}" with ${batch.length} event(s).`);
  }

  async runLoop(once: boolean): Promise<void> {
    log(
      "INFO",
      `Starting Lead Watcher (inbox=#${this.swarm.board.inboxChannel}, prefix=${this.swarm.board.projectChannelPrefix}, lead=${this.leadAgentName}, poll=${this.swarm.lead.pollIntervalSeconds}s, dryRun=${this.dryRun})`,
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
