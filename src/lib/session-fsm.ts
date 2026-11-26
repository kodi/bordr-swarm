import type { ResolvedWorkerRuntime } from "./config.ts";
import type { HerdrAgentStatus } from "./herdr.ts";

export interface SessionHandle {
  boardProfile: string;
  runtime: ResolvedWorkerRuntime;
  tabId: string;
  paneId: string;
  agentName: string;
  startedAtMs: number;
}

/**
 * Discriminated union for a single Herdr agent session.
 * Each variant carries ONLY the fields valid in that state — making illegal states
 * (e.g., idle timer before prompt delivery, stale UI-block flags) unrepresentable.
 */
export type SessionLifecycle =
  | { kind: "awaiting_prompt"; promptText: string; uiBlockedNotified: boolean }
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
  agentStatus: HerdrAgentStatus | null;
  nowMs: number;
  startupGraceMs: number;
  idleTimeoutMs: number;
  canIdleTimeout: boolean;
}

export type SessionStepResult =
  | { kind: "continue"; session: ManagedSession }
  | {
      kind: "deliver_prompt";
      session: ManagedSession;
      previous: ManagedSession;
      promptText: string;
    }
  | { kind: "ui_blocked"; session: ManagedSession }
  | { kind: "ui_recovered"; session: ManagedSession }
  | { kind: "send_idle_reminder"; session: ManagedSession }
  | { kind: "idle_timed_out" }
  | { kind: "exited_unexpectedly"; tabExists: boolean };

export function assertNever(value: never): never {
  throw new Error(`Unhandled FSM state: ${JSON.stringify(value)}`);
}

export function createManagedSession(
  handle: SessionHandle,
  opts: { promptText: string; blockedOnStartup: boolean },
): ManagedSession {
  return {
    handle,
    lifecycle: opts.blockedOnStartup
      ? { kind: "awaiting_prompt", promptText: opts.promptText, uiBlockedNotified: true }
      : { kind: "running" },
  };
}

function isIdleStatus(status: HerdrAgentStatus): boolean {
  return status === "idle" || status === "done";
}

/**
 * Pure, synchronous sub-state machine for monitoring any Herdr agent session
 * (shared identically by both Implementer and Reviewer sessions).
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
