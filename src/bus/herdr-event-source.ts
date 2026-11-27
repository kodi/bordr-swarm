import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { LineSplitter, parseHerdrEventLine, type SwarmEvent } from "./events.ts";
import {
  backoffDelayMs,
  errorMessage,
  realTimers,
  type LogFn,
  type TimerHandle,
  type Timers,
} from "./timers.ts";

const execFileAsync = promisify(execFile);

/** The subset of `net.Socket` used here, so tests can inject an in-process fake. */
export interface HerdrSocket {
  write(data: string): unknown;
  destroy(): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
  on(event: "connect", listener: () => void): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export type HerdrSocketConnector = (socketPath: string) => HerdrSocket;

export const defaultHerdrConnector: HerdrSocketConnector = (socketPath) =>
  createConnection(socketPath);

export const DEFAULT_HERDR_SOCKET_PATH = resolve(homedir(), ".config/herdr/herdr.sock");

/** Reads the socket path from `herdr status server` (`socket: <path>`). */
export function parseHerdrStatusSocket(output: string): string | null {
  for (const line of output.split("\n")) {
    const m = /^\s*socket:\s*(\S.*)$/.exec(line);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

export async function discoverHerdrSocketPath(binary = "herdr"): Promise<string> {
  try {
    const { stdout } = await execFileAsync(binary, ["status", "server"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return parseHerdrStatusSocket(stdout) ?? DEFAULT_HERDR_SOCKET_PATH;
  } catch {
    return DEFAULT_HERDR_SOCKET_PATH;
  }
}

/** Global subscriptions opened on the main connection. */
export const HERDR_GLOBAL_SUBSCRIPTIONS = [
  { type: "tab.closed" },
  { type: "pane.exited" },
  { type: "pane.closed" },
] as const;

const HerdrResponseSchema = z
  .object({
    id: z.string(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z
      .object({ code: z.string().optional(), message: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface HerdrEventSourceOptions {
  /** The machine's `herdrTarget`; anything other than `local` disables the source. */
  target: string;
  onEvent: (event: SwarmEvent) => void;
  /** Fixed socket path (skips discovery). */
  socketPath?: string;
  discoverSocketPath?: () => Promise<string>;
  connect?: HerdrSocketConnector;
  log?: LogFn;
  timers?: Timers;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** A subscribe request with no answer for this long counts as a failure. */
  subscribeTimeoutMs?: number;
}

type ConnPurpose = { kind: "global" } | { kind: "pane"; paneId: string };

interface Conn {
  purpose: ConnPurpose;
  socket: HerdrSocket | null;
  subscribed: boolean;
  attempt: number;
  retryTimer: TimerHandle | null;
  subscribeTimer: TimerHandle | null;
  closed: boolean;
}

/**
 * Live tab, pane, and agent-status events from the local Herdr server over its private
 * newline-delimited JSON socket protocol. Herdr has no unsubscribe method (protocol 22), so each
 * watched pane gets its own connection and dropping a pane closes that connection. Any connect,
 * subscribe, or parse failure marks the source unhealthy, so callers fall back to CLI polling.
 */
export class HerdrEventSource {
  readonly enabled: boolean;
  private readonly opts: HerdrEventSourceOptions;
  private readonly timers: Timers;
  private readonly connect: HerdrSocketConnector;
  private readonly log: LogFn;
  private socketPath: string | null;
  private stopped = true;
  private healthy: boolean | null = null;
  private failureLogged = false;
  private global: Conn | null = null;
  private readonly panes = new Map<string, Conn>();
  private requestSeq = 0;

  constructor(opts: HerdrEventSourceOptions) {
    this.opts = opts;
    this.enabled = (opts.target?.trim() || "local") === "local";
    this.timers = opts.timers ?? realTimers;
    this.connect = opts.connect ?? defaultHerdrConnector;
    this.log = opts.log ?? (() => {});
    this.socketPath = opts.socketPath ?? null;
  }

  get isHealthy(): boolean {
    return this.healthy === true;
  }

  get watchedPaneIds(): string[] {
    return [...this.panes.keys()];
  }

  start(): void {
    if (!this.enabled) {
      this.log(
        "INFO",
        `Herdr events disabled for herdrTarget="${this.opts.target}" (only "local" is supported); using CLI polling.`,
      );
      return;
    }
    if (!this.stopped) return;
    this.stopped = false;
    this.global = this.newConn({ kind: "global" });
    void this.open(this.global);
    for (const conn of this.panes.values()) void this.open(conn);
  }

  stop(): void {
    this.stopped = true;
    if (this.global) this.closeConn(this.global);
    this.global = null;
    for (const conn of this.panes.values()) this.closeConn(conn);
  }

  /** Keeps one `pane.agent_status_changed` subscription per pane in `paneIds`. */
  setWatchedPanes(paneIds: Iterable<string>): void {
    const wanted = new Set([...paneIds].filter(Boolean));
    for (const [paneId, conn] of this.panes) {
      if (!wanted.has(paneId)) {
        this.closeConn(conn);
        this.panes.delete(paneId);
      }
    }
    for (const paneId of wanted) {
      if (this.panes.has(paneId)) continue;
      const conn = this.newConn({ kind: "pane", paneId });
      this.panes.set(paneId, conn);
      if (this.enabled && !this.stopped) void this.open(conn);
    }
  }

  private newConn(purpose: ConnPurpose): Conn {
    return {
      purpose,
      socket: null,
      subscribed: false,
      attempt: 0,
      retryTimer: null,
      subscribeTimer: null,
      closed: false,
    };
  }

  private closeConn(conn: Conn): void {
    conn.closed = true;
    if (conn.retryTimer !== null) this.timers.clearTimeout(conn.retryTimer);
    if (conn.subscribeTimer !== null) this.timers.clearTimeout(conn.subscribeTimer);
    conn.retryTimer = null;
    conn.subscribeTimer = null;
    const socket = conn.socket;
    conn.socket = null;
    conn.subscribed = false;
    try {
      socket?.destroy();
    } catch {
      // Already closed
    }
  }

  private setHealth(healthy: boolean, detail: string): void {
    if (healthy) this.failureLogged = false;
    if (this.healthy === healthy) return;
    this.healthy = healthy;
    this.opts.onEvent({ kind: "source.health", source: "herdr", healthy, detail });
  }

  private reportFailure(conn: Conn, detail: string): void {
    if (conn.purpose.kind !== "global") return;
    if (!this.failureLogged) {
      this.failureLogged = true;
      this.log("WARN", `Herdr event socket unavailable (${detail}); falling back to CLI polling.`);
    }
    this.setHealth(false, detail);
  }

  private async resolveSocketPath(): Promise<string> {
    if (this.opts.socketPath) return this.opts.socketPath;
    const discover = this.opts.discoverSocketPath ?? (() => discoverHerdrSocketPath());
    this.socketPath = await discover();
    return this.socketPath;
  }

  private subscriptionsFor(conn: Conn): Array<Record<string, string>> {
    return conn.purpose.kind === "global"
      ? HERDR_GLOBAL_SUBSCRIPTIONS.map((s) => ({ ...s }))
      : [{ type: "pane.agent_status_changed", pane_id: conn.purpose.paneId }];
  }

  private async open(conn: Conn): Promise<void> {
    if (this.stopped || conn.closed || conn.socket) return;
    let socketPath: string;
    try {
      // Re-discover on every (re)connect of the main connection: the server may have moved.
      socketPath =
        conn.purpose.kind === "global" || !this.socketPath
          ? await this.resolveSocketPath()
          : this.socketPath;
    } catch (err) {
      this.scheduleRetry(conn, `socket discovery failed: ${errorMessage(err)}`);
      return;
    }
    if (this.stopped || conn.closed || conn.socket) return;

    let socket: HerdrSocket;
    try {
      socket = this.connect(socketPath);
    } catch (err) {
      this.scheduleRetry(conn, `connect failed: ${errorMessage(err)}`);
      return;
    }
    conn.socket = socket;
    const splitter = new LineSplitter(1024 * 1024);
    const requestId = `bordr-${conn.purpose.kind}-${++this.requestSeq}`;
    let failed = false;

    const fail = (detail: string): void => {
      if (failed || conn.socket !== socket) return;
      failed = true;
      conn.socket = null;
      conn.subscribed = false;
      if (conn.subscribeTimer !== null) this.timers.clearTimeout(conn.subscribeTimer);
      conn.subscribeTimer = null;
      try {
        socket.destroy();
      } catch {
        // Already closed
      }
      if (!conn.closed && !this.stopped) this.scheduleRetry(conn, detail);
    };

    socket.setEncoding?.("utf8");
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: requestId,
          method: "events.subscribe",
          params: { subscriptions: this.subscriptionsFor(conn) },
        })}\n`,
      );
      conn.subscribeTimer = this.timers.setTimeout(() => {
        conn.subscribeTimer = null;
        if (!conn.subscribed) fail("no answer to events.subscribe");
      }, this.opts.subscribeTimeoutMs ?? 10_000);
    });
    socket.on("data", (chunk) => {
      if (conn.socket !== socket) return;
      for (const line of splitter.push(String(chunk))) {
        if (!line.trim()) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          fail("unparseable line from herdr socket");
          return;
        }
        const response = HerdrResponseSchema.safeParse(raw);
        if (response.success && response.data.id === requestId) {
          if (response.data.error || response.data.result?.type !== "subscription_started") {
            fail(
              `events.subscribe rejected: ${response.data.error?.message ?? JSON.stringify(response.data.result ?? {})}`,
            );
            return;
          }
          conn.subscribed = true;
          conn.attempt = 0;
          if (conn.subscribeTimer !== null) this.timers.clearTimeout(conn.subscribeTimer);
          conn.subscribeTimer = null;
          if (conn.purpose.kind === "global") this.setHealth(true, "subscribed");
          continue;
        }
        const event = parseHerdrEventLine(raw);
        if (!event) continue;
        try {
          this.opts.onEvent(event);
        } catch (err) {
          this.log("WARN", `Herdr event handler failed: ${errorMessage(err)}`);
        }
      }
    });
    socket.on("error", (err) => fail(errorMessage(err)));
    socket.on("close", () => fail("connection closed"));
  }

  private scheduleRetry(conn: Conn, detail: string): void {
    if (this.stopped || conn.closed) return;
    this.reportFailure(conn, detail);
    const delay = backoffDelayMs(
      conn.attempt,
      this.opts.backoffInitialMs ?? 1_000,
      this.opts.backoffMaxMs ?? 60_000,
    );
    conn.attempt += 1;
    if (conn.retryTimer !== null) this.timers.clearTimeout(conn.retryTimer);
    conn.retryTimer = this.timers.setTimeout(() => {
      conn.retryTimer = null;
      void this.open(conn);
    }, delay);
  }
}
