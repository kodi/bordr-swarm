import { errorMessage, realTimers, type TimerHandle, type Timers } from "./timers.ts";

export interface WakeRunInfo {
  /** True when this run is a periodic (or first, or explicitly requested) full reconcile. */
  periodic: boolean;
  /** Why the run happened (event reasons, `interval`, `start`, ...), de-duplicated. */
  reasons: string[];
}

export interface WakeSchedulerOptions {
  run: (info: WakeRunInfo) => Promise<void>;
  /** Current periodic interval; re-read after every run and on `refreshInterval()`. */
  intervalMs: () => number;
  /** Bursts of wakes within this window coalesce into one run. */
  debounceMs?: number;
  timers?: Timers;
  onError?: (err: unknown) => void;
}

/**
 * Turns wake-ups into ticks. Guarantees:
 * - ticks never overlap;
 * - a burst of `wake()` calls within `debounceMs` becomes one tick (latency is bounded: the
 *   debounce window is not extended by later wakes);
 * - a wake during a tick causes exactly one follow-up tick;
 * - a periodic reconcile runs `intervalMs()` after the previous periodic one, however many
 *   event-driven ticks happened in between.
 */
export class WakeScheduler {
  private readonly opts: WakeSchedulerOptions;
  private readonly timers: Timers;
  private readonly debounceMs: number;
  private stopped = true;
  private running: Promise<void> | null = null;
  private pendingWake = false;
  private pendingPeriodic = false;
  private reasons = new Set<string>();
  private debounceTimer: TimerHandle | null = null;
  private intervalTimer: TimerHandle | null = null;
  private lastPeriodicAtMs = 0;

  constructor(opts: WakeSchedulerOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? realTimers;
    this.debounceMs = opts.debounceMs ?? 250;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Starts with an immediate full reconcile. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.pendingPeriodic = true;
    this.reasons.add("start");
    this.fire();
  }

  /** Requests a tick soon (debounced). */
  wake(reason: string): void {
    if (this.stopped) return;
    this.reasons.add(reason);
    if (this.running) {
      this.pendingWake = true;
      return;
    }
    if (this.debounceTimer === null) {
      this.debounceTimer = this.timers.setTimeout(() => {
        this.debounceTimer = null;
        this.fire();
      }, this.debounceMs);
    }
  }

  /** Makes the next tick a full reconcile and wakes it. */
  requestReconcile(reason: string): void {
    if (this.stopped) return;
    this.pendingPeriodic = true;
    this.wake(reason);
  }

  /** Re-arms the periodic timer after the interval changed (e.g. a source went down). */
  refreshInterval(): void {
    if (this.stopped || this.running) return;
    this.armInterval();
  }

  /** Stops scheduling and waits for an in-flight tick to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounceTimer !== null) this.timers.clearTimeout(this.debounceTimer);
    if (this.intervalTimer !== null) this.timers.clearTimeout(this.intervalTimer);
    this.debounceTimer = null;
    this.intervalTimer = null;
    await this.running;
  }

  private armInterval(): void {
    if (this.intervalTimer !== null) this.timers.clearTimeout(this.intervalTimer);
    const due = this.lastPeriodicAtMs + this.opts.intervalMs();
    const delay = Math.max(0, due - this.timers.now());
    this.intervalTimer = this.timers.setTimeout(() => {
      this.intervalTimer = null;
      this.pendingPeriodic = true;
      this.reasons.add("interval");
      this.fire();
    }, delay);
  }

  private fire(): void {
    if (this.stopped) return;
    if (this.running) {
      this.pendingWake = true;
      return;
    }
    if (this.debounceTimer !== null) this.timers.clearTimeout(this.debounceTimer);
    if (this.intervalTimer !== null) this.timers.clearTimeout(this.intervalTimer);
    this.debounceTimer = null;
    this.intervalTimer = null;

    const info: WakeRunInfo = { periodic: this.pendingPeriodic, reasons: [...this.reasons] };
    this.pendingPeriodic = false;
    this.pendingWake = false;
    this.reasons = new Set();
    if (info.periodic) this.lastPeriodicAtMs = this.timers.now();

    this.running = (async () => {
      try {
        await this.opts.run(info);
      } catch (err) {
        this.opts.onError?.(err);
        if (!this.opts.onError) console.error(`Scheduled tick failed: ${errorMessage(err)}`);
      }
    })().finally(() => {
      this.running = null;
      if (this.stopped) return;
      if (this.pendingWake || this.pendingPeriodic) {
        this.pendingWake = false;
        this.debounceTimer = this.timers.setTimeout(() => {
          this.debounceTimer = null;
          this.fire();
        }, this.debounceMs);
      }
      this.armInterval();
    });
  }
}
