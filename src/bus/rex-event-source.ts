import {
  defaultGroupKiller,
  defaultTailSpawner,
  type GroupKiller,
  type TailChild,
  type TailSpawner,
} from "./board-tail-source.ts";
import { LineSplitter, parseRexEventLine, type SwarmEvent } from "./events.ts";
import {
  backoffDelayMs,
  errorMessage,
  realTimers,
  type LogFn,
  type TimerHandle,
  type Timers,
} from "./timers.ts";

export interface RexEventSourceOptions {
  binary?: string;
  onEvent: (event: SwarmEvent) => void;
  log?: LogFn;
  spawner?: TailSpawner;
  killGroup?: GroupKiller;
  timers?: Timers;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** A global `rex events --json` stream up this long counts as healthy (idle server prints nothing). */
  healthyAfterMs?: number;
  stopTimeoutMs?: number;
}

type StreamState =
  | { kind: "idle" }
  | { kind: "running"; child: TailChild; pid: number | undefined }
  | { kind: "backoff"; timer: TimerHandle }
  | { kind: "stopped" };

interface ManagedStream {
  key: string;
  sessionId: string | null;
  state: StreamState;
  attempt: number;
  healthyTimer: TimerHandle | null;
  exitWaiters: Array<() => void>;
}

/**
 * Live Rex event source (Slice 10), sibling of `HerdrEventSource` and `BoardTailSource`:
 * - One global `rex events --json` child tracks Rex server reachability (`source.health`).
 * - One `rex events -s <session> --json` child per watched swarm session streams
 *   `program_status_changed`, `child_exited`, `block_closed`, and `window_closed`.
 * - Every child runs in its own process group (`detached: true`) and is killed cleanly on stop.
 */
export class RexEventSource {
  private readonly binary: string;
  private readonly opts: RexEventSourceOptions;
  private readonly spawner: TailSpawner;
  private readonly killGroup: GroupKiller;
  private readonly timers: Timers;
  private readonly log: LogFn;
  private stopped = true;
  private healthy: boolean | null = null;
  private failureLogged = false;
  private globalStream: ManagedStream | null = null;
  private readonly sessionStreams = new Map<string, ManagedStream>();

  constructor(opts: RexEventSourceOptions) {
    this.binary = opts.binary ?? "rex";
    this.opts = opts;
    this.spawner = opts.spawner ?? defaultTailSpawner;
    this.killGroup = opts.killGroup ?? defaultGroupKiller;
    this.timers = opts.timers ?? realTimers;
    this.log = opts.log ?? (() => {});
  }

  get isHealthy(): boolean {
    return this.healthy === true;
  }

  get watchedSessionIds(): string[] {
    return [...this.sessionStreams.keys()];
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.globalStream = this.createStream("global", null);
    this.spawnStream(this.globalStream);
    for (const sessionId of this.sessionStreams.keys()) {
      const stream = this.createStream(`session:${sessionId}`, sessionId);
      this.sessionStreams.set(sessionId, stream);
      this.spawnStream(stream);
    }
  }

  /** Keeps one `rex events -s <sessionId> --json` stream per active swarm session. */
  setWatchedSessions(sessionIds: Iterable<string>): void {
    const wanted = new Set([...sessionIds].filter(Boolean));
    for (const [sid, stream] of this.sessionStreams) {
      if (!wanted.has(sid)) {
        this.sessionStreams.delete(sid);
        void this.stopStream(stream);
      }
    }
    for (const sid of wanted) {
      if (this.sessionStreams.has(sid)) continue;
      const stream = this.createStream(`session:${sid}`, sid);
      this.sessionStreams.set(sid, stream);
      if (!this.stopped) this.spawnStream(stream);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const stops: Array<Promise<void>> = [];
    if (this.globalStream) {
      stops.push(this.stopStream(this.globalStream));
      this.globalStream = null;
    }
    for (const stream of this.sessionStreams.values()) {
      stops.push(this.stopStream(stream));
    }
    await Promise.all(stops);
  }

  /** Synchronous last-resort kill for `process.on("exit")`. */
  killNow(): void {
    const killOne = (stream: ManagedStream | null): void => {
      if (stream?.state.kind === "running" && stream.state.pid !== undefined) {
        this.killGroup(stream.state.pid, "SIGKILL");
      }
    };
    killOne(this.globalStream);
    for (const stream of this.sessionStreams.values()) killOne(stream);
  }

  private createStream(key: string, sessionId: string | null): ManagedStream {
    return {
      key,
      sessionId,
      state: { kind: "idle" },
      attempt: 0,
      healthyTimer: null,
      exitWaiters: [],
    };
  }

  private setHealth(healthy: boolean, detail: string): void {
    if (healthy) this.failureLogged = false;
    if (this.healthy === healthy) return;
    this.healthy = healthy;
    this.opts.onEvent({ kind: "source.health", source: "rex", healthy, detail });
  }

  private clearHealthyTimer(stream: ManagedStream): void {
    if (stream.healthyTimer !== null) {
      this.timers.clearTimeout(stream.healthyTimer);
      stream.healthyTimer = null;
    }
  }

  private async stopStream(stream: ManagedStream): Promise<void> {
    const prev = stream.state;
    stream.state = { kind: "stopped" };
    this.clearHealthyTimer(stream);
    if (prev.kind === "backoff") this.timers.clearTimeout(prev.timer);
    if (prev.kind !== "running") return;

    const exited = new Promise<void>((resolveExit) => stream.exitWaiters.push(resolveExit));
    if (prev.pid !== undefined) this.killGroup(prev.pid, "SIGTERM");
    let forceTimer: TimerHandle | null = null;
    const forced = new Promise<void>((resolveForce) => {
      forceTimer = this.timers.setTimeout(() => {
        if (prev.pid !== undefined) this.killGroup(prev.pid, "SIGKILL");
        resolveForce();
      }, this.opts.stopTimeoutMs ?? 3_000);
    });
    await Promise.race([exited, forced]);
    if (forceTimer !== null) this.timers.clearTimeout(forceTimer);
  }

  private spawnStream(stream: ManagedStream): void {
    if (this.stopped || stream.state.kind === "stopped") return;
    const args = stream.sessionId
      ? ["events", "-s", stream.sessionId, "--json"]
      : ["events", "--json"];

    let child: TailChild;
    try {
      child = this.spawner(this.binary, args);
    } catch (err) {
      this.handleStreamExit(stream, `could not start ${this.binary}: ${errorMessage(err)}`);
      return;
    }

    stream.state = { kind: "running", child, pid: child.pid };
    const splitter = new LineSplitter(1024 * 1024);
    let stderrTail = "";

    if (stream.sessionId === null) {
      stream.healthyTimer = this.timers.setTimeout(() => {
        stream.healthyTimer = null;
        if (stream.state.kind === "running" && stream.state.child === child) {
          stream.attempt = 0;
          this.setHealth(true, "rex events stream up");
        }
      }, this.opts.healthyAfterMs ?? 1_500);
    }

    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      if (stream.state.kind !== "running" || stream.state.child !== child) return;
      if (stream.sessionId === null) {
        stream.attempt = 0;
        this.setHealth(true, "rex events stream up");
      }
      for (const line of splitter.push(String(chunk))) {
        const event = parseRexEventLine(line);
        if (!event) continue;
        try {
          this.opts.onEvent(event);
        } catch (err) {
          this.log("WARN", `Rex event handler failed: ${errorMessage(err)}`);
        }
      }
    });

    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-1_000);
    });

    let exitedOnce = false;
    const onExit = (detail: string): void => {
      if (exitedOnce) return;
      exitedOnce = true;
      if (stream.state.kind === "running" && stream.state.child === child) {
        const hint = stderrTail
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-1)[0];
        this.handleStreamExit(stream, `${detail}${hint ? ` (${hint.slice(0, 200)})` : ""}`);
      }
      for (const waiter of stream.exitWaiters.splice(0)) waiter();
    };

    child.once("exit", (code, signal) =>
      onExit(`rex events exited (${signal ? `signal ${signal}` : `code ${code ?? "?"}`})`),
    );
    child.once("error", (err) => onExit(`rex events failed: ${errorMessage(err)}`));
  }

  private handleStreamExit(stream: ManagedStream, detail: string): void {
    this.clearHealthyTimer(stream);
    if (this.stopped || stream.state.kind === "stopped") return;

    if (stream.sessionId === null) {
      if (!this.failureLogged) {
        this.failureLogged = true;
        this.log("WARN", `Rex event stream down (${detail}); falling back to CLI polling.`);
      }
      this.setHealth(false, detail);
    } else if (/\bnot found\b/i.test(detail)) {
      // Session was closed; no need to keep retrying until watched sessions change.
      stream.state = { kind: "stopped" };
      this.sessionStreams.delete(stream.sessionId);
      return;
    }

    const delay = backoffDelayMs(
      stream.attempt,
      this.opts.backoffInitialMs ?? 1_000,
      this.opts.backoffMaxMs ?? 60_000,
    );
    stream.attempt += 1;
    const timer = this.timers.setTimeout(() => {
      if (stream.state.kind !== "backoff") return;
      stream.state = { kind: "idle" };
      this.spawnStream(stream);
    }, delay);
    stream.state = { kind: "backoff", timer };
  }
}
