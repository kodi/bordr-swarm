/** Injectable clock and timers so bus components can be tested without real sleeps. */
export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export type TimerHandle = unknown;

export const realTimers: Timers = {
  now: () => Date.now(),
  // Timers stay ref'd: the scheduler's interval timer is what keeps a polling-only daemon alive.
  // Every component clears its timers on stop(), so a graceful stop still lets the process exit.
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Capped exponential backoff: `initialMs * 2^attempt`, at most `maxMs`. */
export function backoffDelayMs(attempt: number, initialMs: number, maxMs: number): number {
  const safeAttempt = Math.max(0, Math.min(attempt, 30));
  return Math.min(maxMs, initialMs * 2 ** safeAttempt);
}

export type LogFn = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
