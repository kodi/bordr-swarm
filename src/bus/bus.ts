import type { EventSourceName, SwarmEvent } from "./events.ts";
import { errorMessage, type LogFn } from "./timers.ts";

export type BusHandler = (event: SwarmEvent) => void;

/**
 * Synchronous fan-out of `SwarmEvent`s. A throwing subscriber is logged and never stops the
 * others. Subscribers should only record or schedule work; the actual I/O happens in ticks.
 */
export class Bus {
  private readonly handlers = new Set<BusHandler>();
  private readonly log: LogFn;

  constructor(log: LogFn = () => {}) {
    this.log = log;
  }

  subscribe(handler: BusHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  publish(event: SwarmEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        this.log("WARN", `Bus subscriber failed on ${event.kind}: ${errorMessage(err)}`);
      }
    }
  }
}

/**
 * Tracks which live sources are enabled and healthy. With no enabled source the daemon is in
 * polling mode, exactly as before the bus existed.
 */
export class SourceHealth {
  private readonly state = new Map<EventSourceName, boolean>();

  enable(source: EventSourceName): void {
    if (!this.state.has(source)) this.state.set(source, false);
  }

  /** Applies a `source.health` event; returns true when it changed the overall picture. */
  apply(event: SwarmEvent): boolean {
    if (event.kind !== "source.health" || !this.state.has(event.source)) return false;
    const before = this.allHealthy;
    this.state.set(event.source, event.healthy);
    return before !== this.allHealthy;
  }

  isHealthy(source: EventSourceName): boolean {
    return this.state.get(source) === true;
  }

  get enabledSources(): EventSourceName[] {
    return [...this.state.keys()];
  }

  /** True only when at least one source is enabled and every enabled source is healthy. */
  get allHealthy(): boolean {
    if (this.state.size === 0) return false;
    for (const healthy of this.state.values()) if (!healthy) return false;
    return true;
  }
}

/**
 * Interval between periodic full reconciles. Healthy live events allow the slow safety-net
 * `reconcileMs`; degraded (or no) sources mean polling at `pollMs`. While time-based work is in
 * flight (idle reminders, idle-close, startup grace) the poll cadence is kept so those
 * transitions are not delayed.
 */
export function selectReconcileIntervalMs(params: {
  sourcesHealthy: boolean;
  timeSensitiveWork: boolean;
  pollMs: number;
  reconcileMs: number;
}): number {
  if (!params.sourcesHealthy) return params.pollMs;
  if (params.timeSensitiveWork) return Math.min(params.pollMs, params.reconcileMs);
  return params.reconcileMs;
}
