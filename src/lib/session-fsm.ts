import type { ResolvedWorkerRuntime } from "./config.ts";
import type { AgentStatus } from "./runtime.ts";

export const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;

export interface SessionHandle {
  boardProfile: string;
  runtime: ResolvedWorkerRuntime;
  tabId: string;
  paneId: string;
  agentName: string;
  startedAtMs: number;
}

/**
 * Discriminated union for a single worker agent session (Herdr or Rex).
 * Each variant carries ONLY the fields valid in that state — making illegal states
 * (e.g., idle timer before prompt delivery, stale UI-block flags) unrepresentable.
 */
export type SessionLifecycle =
  | { kind: "awaiting_prompt"; promptText: string; sinceMs: number; uiBlockedNotified: boolean }
  | { kind: "running" }
  | { kind: "ui_blocked" }
  | { kind: "idle_grace"; sinceMs: number }
  | { kind: "idle_reminded"; remindedAtMs: number };

export interface ManagedSession {
  handle: SessionHandle;
  lifecycle: SessionLifecycle;
}

export interface SessionObservation {
  tabExists: boolean;
  /** `null` = no live agent process; `"unknown"` = process alive, no status reported yet. */
  agentStatus: AgentStatus | null;
  nowMs: number;
  startupGraceMs: number;
  /** How long `awaiting_prompt` may wait without reaching idle before emitting `ui_blocked` (`startup_timeout`). */
  startupTimeoutMs?: number;
  idleTimeoutMs: number;
  canIdleTimeout: boolean;
}

export type UiBlockedReason = "blocked" | "startup_timeout";

export type SessionStepResult =
  | { kind: "continue"; session: ManagedSession }
  | {
      kind: "deliver_prompt";
      session: ManagedSession;
      previous: ManagedSession;
      promptText: string;
    }
  | { kind: "ui_blocked"; session: ManagedSession; reason: UiBlockedReason }
  | { kind: "ui_recovered"; session: ManagedSession }
  | { kind: "send_idle_reminder"; session: ManagedSession }
  | { kind: "idle_timed_out" }
  | { kind: "exited_unexpectedly"; tabExists: boolean };

export function assertNever(value: never): never {
  throw new Error(`Unhandled FSM state: ${JSON.stringify(value)}`);
}

export function createManagedSession(
  handle: SessionHandle,
  opts: { promptText: string; blockedOnStartup: boolean; promptNow?: boolean },
): ManagedSession {
  const needsAwaitingPrompt = opts.blockedOnStartup || opts.promptNow === false;
  return {
    handle,
    lifecycle: needsAwaitingPrompt
      ? {
          kind: "awaiting_prompt",
          promptText: opts.promptText,
          sinceMs: handle.startedAtMs,
          uiBlockedNotified: opts.blockedOnStartup,
        }
      : { kind: "running" },
  };
}

function isIdleStatus(status: AgentStatus): boolean {
  return status === "idle" || status === "done";
}

/**
 * Pure, synchronous sub-state machine for monitoring any agent session
 * (shared identically by both Implementer and Reviewer sessions across Herdr and Rex).
 */
export function stepSession(session: ManagedSession, obs: SessionObservation): SessionStepResult {
  const pastStartupGrace = obs.nowMs - session.handle.startedAtMs > obs.startupGraceMs;
  if (!obs.tabExists || (obs.agentStatus === null && pastStartupGrace)) {
    return { kind: "exited_unexpectedly", tabExists: obs.tabExists };
  }

  // Still inside startup grace window while agent process initializes
  if (obs.agentStatus === null) {
    return { kind: "continue", session };
  }

  const status = obs.agentStatus;
  const lc = session.lifecycle;
  const startupTimeoutMs = obs.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  switch (lc.kind) {
    case "awaiting_prompt": {
      if (isIdleStatus(status)) {
        return {
          kind: "deliver_prompt",
          session: { handle: session.handle, lifecycle: { kind: "running" } },
          previous: session,
          promptText: lc.promptText,
        };
      }
      if (status === "blocked" && !lc.uiBlockedNotified) {
        return {
          kind: "ui_blocked",
          reason: "blocked",
          session: {
            handle: session.handle,
            lifecycle: { ...lc, uiBlockedNotified: true },
          },
        };
      }
      if (
        !lc.uiBlockedNotified &&
        startupTimeoutMs > 0 &&
        obs.nowMs - lc.sinceMs >= startupTimeoutMs
      ) {
        return {
          kind: "ui_blocked",
          reason: "startup_timeout",
          session: {
            handle: session.handle,
            lifecycle: { ...lc, uiBlockedNotified: true },
          },
        };
      }
      return { kind: "continue", session };
    }

    case "running": {
      if (status === "blocked") {
        return {
          kind: "ui_blocked",
          reason: "blocked",
          session: { handle: session.handle, lifecycle: { kind: "ui_blocked" } },
        };
      }
      if (isIdleStatus(status) && obs.canIdleTimeout) {
        return {
          kind: "continue",
          session: {
            handle: session.handle,
            lifecycle: { kind: "idle_grace", sinceMs: obs.nowMs },
          },
        };
      }
      return { kind: "continue", session };
    }

    case "ui_blocked": {
      if (status === "working") {
        return {
          kind: "ui_recovered",
          session: { handle: session.handle, lifecycle: { kind: "running" } },
        };
      }
      if (isIdleStatus(status) && obs.canIdleTimeout) {
        return {
          kind: "ui_recovered",
          session: {
            handle: session.handle,
            lifecycle: { kind: "idle_grace", sinceMs: obs.nowMs },
          },
        };
      }
      return { kind: "continue", session };
    }

    case "idle_grace": {
      if (status === "working") {
        return {
          kind: "continue",
          session: { handle: session.handle, lifecycle: { kind: "running" } },
        };
      }
      if (status === "blocked") {
        return {
          kind: "ui_blocked",
          reason: "blocked",
          session: { handle: session.handle, lifecycle: { kind: "ui_blocked" } },
        };
      }
      if (
        isIdleStatus(status) &&
        obs.canIdleTimeout &&
        obs.nowMs - lc.sinceMs >= obs.idleTimeoutMs
      ) {
        return {
          kind: "send_idle_reminder",
          session: {
            handle: session.handle,
            lifecycle: { kind: "idle_reminded", remindedAtMs: obs.nowMs },
          },
        };
      }
      return { kind: "continue", session };
    }

    case "idle_reminded": {
      if (status === "working") {
        return {
          kind: "continue",
          session: { handle: session.handle, lifecycle: { kind: "running" } },
        };
      }
      if (status === "blocked") {
        return {
          kind: "ui_blocked",
          reason: "blocked",
          session: { handle: session.handle, lifecycle: { kind: "ui_blocked" } },
        };
      }
      if (
        isIdleStatus(status) &&
        obs.canIdleTimeout &&
        obs.nowMs - lc.remindedAtMs >= obs.idleTimeoutMs
      ) {
        return { kind: "idle_timed_out" };
      }
      return { kind: "continue", session };
    }

    default:
      return assertNever(lc);
  }
}
