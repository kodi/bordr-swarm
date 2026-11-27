import type { BoardClient } from "../lib/board.ts";
import { resolveEventsConfig, type MachineRuntime, type SwarmConfig } from "../lib/config.ts";
import { BoardTailSource } from "./board-tail-source.ts";
import { Bus, SourceHealth } from "./bus.ts";
import { FsWatchSource } from "./fs-watch-source.ts";
import { HerdrEventSource } from "./herdr-event-source.ts";
import { RexEventSource } from "./rex-event-source.ts";
import type { LogFn } from "./timers.ts";

/** Anything that can be told which Herdr panes to watch for agent-status changes. */
export interface PaneWatcher {
  setWatchedPanes(paneIds: Iterable<string>): void;
}

/** Anything that can be told which Rex sessions to watch for block/window events. */
export interface SessionWatcher {
  setWatchedSessions(sessionIds: Iterable<string>): void;
}

/** What a daemon needs to run on the bus: the bus, source health, and runtime watchers. */
export interface DaemonEventWiring {
  bus: Bus;
  health: SourceHealth;
  paneWatcher: PaneWatcher | null;
  sessionWatcher?: SessionWatcher | null;
}

export interface DaemonEventSources extends DaemonEventWiring {
  tail: BoardTailSource | null;
  herdr: HerdrEventSource | null;
  rex: RexEventSource | null;
  fsWatch: FsWatchSource | null;
  start(): void;
  /** Stops every source and waits for child process groups to exit. */
  stop(): Promise<void>;
  /** Synchronous last-resort cleanup for `process.on("exit")`. */
  killNow(): void;
}

/**
 * Builds the live sources a daemon uses, honouring `swarm.events`. A disabled or non-local
 * source is simply not enabled in `health`, so the daemon polls exactly as before.
 */
export function createDaemonEventSources(params: {
  swarm: SwarmConfig;
  board: BoardClient;
  herdrTarget: string;
  /** Worker terminal runtime (omitted by Lead Watcher, which always uses Herdr). */
  machineRuntime?: MachineRuntime;
  /** Board channel or `prefix/` to tail; omitted, the whole board. */
  tailChannel?: string;
  tailAfter?: string;
  onCursorRejected?: (cursor: string) => void;
  watchFiles?: string[];
  log: LogFn;
}): DaemonEventSources {
  const events = resolveEventsConfig(params.swarm);
  const bus = new Bus(params.log);
  const health = new SourceHealth();
  const publish = (event: Parameters<Bus["publish"]>[0]) => bus.publish(event);
  const runtime: MachineRuntime = params.machineRuntime ?? {
    kind: "herdr",
    target: params.herdrTarget.trim() || "local",
  };

  const tail = events.boardTail
    ? new BoardTailSource({
        board: params.board,
        channel: params.tailChannel,
        after: params.tailAfter,
        onEvent: publish,
        onCursorRejected: params.onCursorRejected,
        log: params.log,
      })
    : null;
  if (tail) health.enable("board");

  const herdrSource =
    runtime.kind === "herdr" && events.herdr && (runtime.target.trim() || "local") === "local"
      ? new HerdrEventSource({ target: runtime.target, onEvent: publish, log: params.log })
      : null;
  if (herdrSource) health.enable("herdr");

  const rexSource =
    runtime.kind === "rex" && events.rex
      ? new RexEventSource({ binary: runtime.binary, onEvent: publish, log: params.log })
      : null;
  if (rexSource) health.enable("rex");

  const watchFiles = (params.watchFiles ?? []).filter(Boolean);
  const fsWatch =
    watchFiles.length > 0
      ? new FsWatchSource({ files: watchFiles, onEvent: publish, log: params.log })
      : null;

  return {
    bus,
    health,
    paneWatcher: herdrSource,
    sessionWatcher: rexSource,
    tail,
    herdr: herdrSource,
    rex: rexSource,
    fsWatch,
    start() {
      tail?.start();
      herdrSource?.start();
      rexSource?.start();
      fsWatch?.start();
      const enabled = health.enabledSources;
      params.log(
        "INFO",
        enabled.length > 0
          ? `Live event sources: ${enabled.join(", ")} (polling stays on as the fallback).`
          : "Live event sources disabled; polling only.",
      );
    },
    async stop() {
      fsWatch?.stop();
      herdrSource?.stop();
      await Promise.all([tail?.stop(), rexSource?.stop()]);
    },
    killNow() {
      tail?.killNow();
      rexSource?.killNow();
    },
  };
}

/** One log line describing live-event health and the interval now in use. */
export function describeHealth(health: SourceHealth, intervalMs: number): string {
  const parts = health.enabledSources.map((s) => `${s}=${health.isHealthy(s) ? "live" : "down"}`);
  const mode = health.allHealthy ? "event-driven" : "degraded (polling)";
  return `Live events ${mode} [${parts.join(", ")}]; periodic reconcile every ${Math.round(intervalMs / 1000)}s.`;
}
