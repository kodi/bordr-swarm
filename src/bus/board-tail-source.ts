import { spawn } from "node:child_process";
import type { BoardClient } from "../lib/board.ts";
import {
  boardEventCursor,
  isInvalidCursorOutput,
  LineSplitter,
  parseBoardTailLine,
  type SwarmEvent,
} from "./events.ts";
import {
  backoffDelayMs,
  errorMessage,
  realTimers,
  type LogFn,
  type TimerHandle,
  type Timers,
} from "./timers.ts";

/** The subset of `ChildProcess` the tail supervisor uses (so tests can inject a fake). */
export interface TailChild {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
}

export type TailSpawner = (cmd: string, args: string[]) => TailChild;

/** Signals a whole process group (`vercel` runs the stream in a grandchild). */
export type GroupKiller = (pid: number, signal: NodeJS.Signals) => void;

export const defaultTailSpawner: TailSpawner = (cmd, args) =>
  spawn(cmd, args, {
    // A new process group, so stop() can signal `vercel` and the stream child it starts.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

export const defaultGroupKiller: GroupKiller = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone
    }
  }
};

export interface BoardTailSourceOptions {
  board: Pick<BoardClient, "buildTailCommand">;
  /** Channel or `prefix/`; omitted, the whole board. */
  channel?: string;
  /** Resume point (a cursor from an earlier event). */
  after?: string;
  onEvent: (event: SwarmEvent) => void;
  /** Called when the CLI rejects the `--after` cursor; the stream then restarts without one. */
  onCursorRejected?: (cursor: string) => void;
  log?: LogFn;
  spawner?: TailSpawner;
  killGroup?: GroupKiller;
  timers?: Timers;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** A stream that has stayed up this long counts as healthy (an idle board prints nothing). */
  healthyAfterMs?: number;
  /**
   * Restart the stream when it printed nothing for this long (0 disables). It is unknown whether
   * `tail` can stall silently on network loss, so this is a cheap watchdog: with a cursor, the
   * restart resumes exactly where it left off.
   */
  stallTimeoutMs?: number;
  /** How long stop() waits after SIGTERM before SIGKILL. */
  stopTimeoutMs?: number;
}

type TailState =
  | { kind: "idle" }
  | { kind: "running"; child: TailChild; pid: number | undefined; startedAfter: string | undefined }
  | { kind: "backoff"; timer: TimerHandle }
  | { kind: "stopped" };

/**
 * Supervises one `vercel board tail --json` child: parses its NDJSON into `SwarmEvent`s, restarts
 * it with capped exponential backoff, resumes with `--after <last cursor>`, and reports health
 * transitions as `source.health` events. stop() kills the whole process group.
 */
export class BoardTailSource {
  private readonly opts: BoardTailSourceOptions;
  private readonly timers: Timers;
  private readonly spawner: TailSpawner;
  private readonly killGroup: GroupKiller;
  private readonly log: LogFn;
  private state: TailState = { kind: "idle" };
  private cursorValue: string | undefined;
  private attempt = 0;
  private healthy: boolean | null = null;
  private healthyTimer: TimerHandle | null = null;
  private stallTimer: TimerHandle | null = null;
  private quietRestart = false;
  private exitWaiters: Array<() => void> = [];

  constructor(opts: BoardTailSourceOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? realTimers;
    this.spawner = opts.spawner ?? defaultTailSpawner;
    this.killGroup = opts.killGroup ?? defaultGroupKiller;
    this.log = opts.log ?? (() => {});
    this.cursorValue = opts.after?.trim() || undefined;
  }

  /** Last cursor seen (or the initial `after`). */
  get cursor(): string | undefined {
    return this.cursorValue;
  }

  get isHealthy(): boolean {
    return this.healthy === true;
  }

  get isRunning(): boolean {
    return this.state.kind === "running";
  }

  start(): void {
    if (this.state.kind !== "idle") return;
    this.spawnChild();
  }

  /** Stops the stream and waits for the child process group to exit. Idempotent. */
  async stop(): Promise<void> {
    const prev = this.state;
    this.state = { kind: "stopped" };
    this.clearHealthTimers();
    if (prev.kind === "backoff") this.timers.clearTimeout(prev.timer);
    if (prev.kind !== "running") return;

    const exited = new Promise<void>((resolveExit) => this.exitWaiters.push(resolveExit));
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

  /** Synchronous last-resort kill for `process.on("exit")`. */
  killNow(): void {
    if (this.state.kind === "running" && this.state.pid !== undefined) {
      this.killGroup(this.state.pid, "SIGKILL");
    }
  }

  private setHealth(healthy: boolean, detail: string): void {
    if (this.healthy === healthy) return;
    this.healthy = healthy;
    this.opts.onEvent({ kind: "source.health", source: "board", healthy, detail });
  }

  private clearHealthTimers(): void {
    if (this.healthyTimer !== null) this.timers.clearTimeout(this.healthyTimer);
    if (this.stallTimer !== null) this.timers.clearTimeout(this.stallTimer);
    this.healthyTimer = null;
    this.stallTimer = null;
  }

  private armStallTimer(child: TailChild): void {
    const stallMs = this.opts.stallTimeoutMs ?? 10 * 60_000;
    if (stallMs <= 0) return;
    if (this.stallTimer !== null) this.timers.clearTimeout(this.stallTimer);
    this.stallTimer = this.timers.setTimeout(() => {
      this.stallTimer = null;
      if (this.state.kind !== "running" || this.state.child !== child) return;
      this.log(
        "INFO",
        `Board tail printed nothing for ${Math.round(stallMs / 1000)}s; restarting it.`,
      );
      this.quietRestart = true;
      if (this.state.pid !== undefined) this.killGroup(this.state.pid, "SIGTERM");
    }, stallMs);
  }

  private spawnChild(): void {
    const startedAfter = this.cursorValue;
    const { cmd, args } = this.opts.board.buildTailCommand({
      channel: this.opts.channel,
      after: startedAfter,
    });

    let child: TailChild;
    try {
      child = this.spawner(cmd, args);
    } catch (err) {
      this.handleExit(`could not start ${cmd}: ${errorMessage(err)}`, false);
      return;
    }

    this.state = { kind: "running", child, pid: child.pid, startedAfter };
    const splitter = new LineSplitter();
    let rejected = false;
    let stderrTail = "";

    this.healthyTimer = this.timers.setTimeout(() => {
      this.healthyTimer = null;
      if (this.state.kind === "running" && this.state.child === child) {
        this.attempt = 0;
        this.setHealth(true, "tail stream up");
      }
    }, this.opts.healthyAfterMs ?? 3_000);
    this.armStallTimer(child);

    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      if (this.state.kind !== "running" || this.state.child !== child) return;
      this.armStallTimer(child);
      for (const line of splitter.push(String(chunk))) {
        const res = parseBoardTailLine(line);
        if (res.kind === "cursor_rejected") {
          rejected = true;
          continue;
        }
        if (res.kind !== "event") continue;
        const cursor = boardEventCursor(res.event);
        if (cursor) this.cursorValue = cursor;
        this.attempt = 0;
        this.setHealth(true, "tail stream up");
        try {
          this.opts.onEvent(res.event);
        } catch (err) {
          this.log("WARN", `Board tail event handler failed: ${errorMessage(err)}`);
        }
      }
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      // The CLI prints hint lines on stderr; keep a little for diagnostics, never parse it.
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-2_000);
    });

    let exitedOnce = false;
    const onExit = (detail: string): void => {
      if (exitedOnce) return;
      exitedOnce = true;
      const rest = splitter.flush();
      if (rest && isInvalidCursorOutput(rest)) rejected = true;
      if (this.state.kind === "running" && this.state.child === child) {
        if (rejected && startedAfter) {
          this.log("WARN", `Board tail rejected cursor ${startedAfter}; restarting without one.`);
          this.cursorValue = undefined;
          this.opts.onCursorRejected?.(startedAfter);
          this.clearHealthTimers();
          this.state = { kind: "idle" };
          this.spawnChild();
        } else {
          const stderrHint = stderrTail
            .split("\n")
            .filter((l) => l.trim() && !l.includes("claude-code-hint"))
            .slice(-1)[0];
          this.handleExit(
            `${detail}${stderrHint ? ` (${stderrHint.trim().slice(0, 200)})` : ""}`,
            true,
          );
        }
      }
      for (const waiter of this.exitWaiters.splice(0)) waiter();
    };
    child.once("exit", (code, signal) =>
      onExit(`tail exited (${signal ? `signal ${signal}` : `code ${code ?? "?"}`})`),
    );
    child.once("error", (err) => onExit(`tail failed: ${errorMessage(err)}`));
  }

  private handleExit(detail: string, wasRunning: boolean): void {
    this.clearHealthTimers();
    if (this.state.kind === "stopped") return;
    if (this.quietRestart && wasRunning) {
      this.quietRestart = false;
      this.state = { kind: "idle" };
      this.spawnChild();
      return;
    }
    this.quietRestart = false;
    this.setHealth(false, detail);
    const delay = backoffDelayMs(
      this.attempt,
      this.opts.backoffInitialMs ?? 1_000,
      this.opts.backoffMaxMs ?? 60_000,
    );
    this.attempt += 1;
    this.log(
      "WARN",
      `Board event stream down: ${detail}; restarting in ${Math.round(delay / 1000)}s.`,
    );
    const timer = this.timers.setTimeout(() => {
      if (this.state.kind !== "backoff") return;
      this.state = { kind: "idle" };
      this.spawnChild();
    }, delay);
    this.state = { kind: "backoff", timer };
  }
}
