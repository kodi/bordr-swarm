import { sanitizeHerdrAgentName, type HerdrAgentStatus } from "./herdr.ts";
import type { LeadWakeEvent } from "./lead-events.ts";
import { shortTaskId } from "./routing.ts";
import { assertNever } from "./session-fsm.ts";

/**
 * Discriminated union for an ephemeral per-thread Lead session.
 * Each variant carries ONLY the fields valid in that state — making illegal states
 * (e.g., idle timers before prompt delivery, stale UI-block flags) unrepresentable.
 */
export type LeadSessionPhase =
  | { kind: "awaiting_prompt" }
  | { kind: "startup_blocked" }
  | { kind: "prompt_sent"; promptedAtMs: number }
  | { kind: "working" }
  | { kind: "idle_grace"; sinceMs: number }
  | { kind: "ui_blocked" }
  | { kind: "failed" };

export interface LeadSession {
  threadId: string;
  agentName: string;
  tabId: string;
  paneId: string;
  startedAtMs: number;
  phase: LeadSessionPhase;
}

export interface LeadSessionObservation {
  tabExists: boolean;
  agentStatus: HerdrAgentStatus | null;
  pendingEventsForThread: LeadWakeEvent[];
  nowMs: number;
  startupGraceMs: number;
  idleCloseMs: number;
}

export type LeadSessionEffect =
  | { type: "rename_tab"; tabId: string; label: string }
  | {
      type: "deliver_prompt";
      agentName: string;
      threadId: string;
      events: LeadWakeEvent[];
    }
  | { type: "clear_queued_events"; threadId: string }
  | { type: "close_tab"; tabId: string }
  | { type: "log"; level: "INFO" | "WARN"; message: string };

export type LeadSessionStepOutcome =
  | { status: "active"; next: LeadSession; effects: LeadSessionEffect[] }
  | { status: "remove"; effects: LeadSessionEffect[] };

export function formatLeadTabLabel(threadId: string, prefix?: "BLOCKED" | "FAILED"): string {
  const base = `lead-${shortTaskId(threadId)}`;
  return prefix ? `[${prefix}] ${base}` : base;
}

export function buildLeadAgentName(boardProfile: string, threadId: string): string {
  return sanitizeHerdrAgentName(boardProfile, shortTaskId(threadId));
}

export function isLeadSessionParked(session: LeadSession): boolean {
  switch (session.phase.kind) {
    case "startup_blocked":
    case "ui_blocked":
    case "failed":
      return true;
    case "awaiting_prompt":
    case "prompt_sent":
    case "working":
    case "idle_grace":
      return false;
    default:
      return assertNever(session.phase);
  }
}

function isIdleStatus(status: HerdrAgentStatus): boolean {
  return status === "idle" || status === "done";
}

function transitionTo(
  session: LeadSession,
  phase: LeadSessionPhase,
  effects: LeadSessionEffect[] = [],
): LeadSessionStepOutcome {
  return { status: "active", next: { ...session, phase }, effects };
}

function deliverQueuedPrompt(
  session: LeadSession,
  events: LeadWakeEvent[],
  nowMs: number,
  extraEffects: LeadSessionEffect[] = [],
): LeadSessionStepOutcome {
  return transitionTo(session, { kind: "prompt_sent", promptedAtMs: nowMs }, [
    ...extraEffects,
    {
      type: "deliver_prompt",
      agentName: session.agentName,
      threadId: session.threadId,
      events,
    },
  ]);
}

function handleExternalTabClose(
  session: LeadSession,
  obs: LeadSessionObservation,
): LeadSessionStepOutcome {
  const phase = session.phase;
  const awaitingInitialPrompt =
    phase.kind === "awaiting_prompt" || phase.kind === "startup_blocked";
  if (awaitingInitialPrompt && obs.pendingEventsForThread.length > 0) {
    return {
      status: "remove",
      effects: [
        { type: "clear_queued_events", threadId: session.threadId },
        {
          type: "log",
          level: "WARN",
          message: `Lead tab ${session.tabId} for thread ${session.threadId} was closed before prompt delivery; dropping ${obs.pendingEventsForThread.length} queued event(s).`,
        },
      ],
    };
  }
  return {
    status: "remove",
    effects: [
      {
        type: "log",
        level: "INFO",
        message: `Lead tab ${session.tabId} (${session.agentName}) was closed externally; pruned session.`,
      },
    ],
  };
}

function handleMissingAgentProcess(
  session: LeadSession,
  obs: LeadSessionObservation,
): LeadSessionStepOutcome {
  if (obs.nowMs - session.startedAtMs <= obs.startupGraceMs) {
    return { status: "active", next: session, effects: [] };
  }

  const phase = session.phase;
  switch (phase.kind) {
    case "working":
    case "idle_grace":
      return {
        status: "remove",
        effects: [
          { type: "close_tab", tabId: session.tabId },
          {
            type: "log",
            level: "INFO",
            message: `Lead agent "${session.agentName}" exited after completing turn; closed tab ${session.tabId}.`,
          },
        ],
      };

    case "awaiting_prompt":
    case "startup_blocked":
    case "prompt_sent":
    case "ui_blocked": {
      const effects: LeadSessionEffect[] = [
        {
          type: "rename_tab",
          tabId: session.tabId,
          label: formatLeadTabLabel(session.threadId, "FAILED"),
        },
        {
          type: "log",
          level: "WARN",
          message: `Lead agent "${session.agentName}" exited unexpectedly in tab ${session.tabId}; parked as [FAILED].`,
        },
      ];
      if (
        (phase.kind === "awaiting_prompt" || phase.kind === "startup_blocked") &&
        obs.pendingEventsForThread.length > 0
      ) {
        effects.push({ type: "clear_queued_events", threadId: session.threadId });
      }
      return transitionTo(session, { kind: "failed" }, effects);
    }

    case "failed":
      return { status: "active", next: session, effects: [] };

    default:
      return assertNever(phase);
  }
}

/**
 * Pure, deterministic FSM for a single ephemeral per-thread Lead session.
 * Given the current LeadSession and a tick observation, returns the next state
 * and declarative side effects with zero I/O or mutation.
 */
export function stepLeadSession(
  session: LeadSession,
  obs: LeadSessionObservation,
): LeadSessionStepOutcome {
  if (!obs.tabExists) {
    return handleExternalTabClose(session, obs);
  }
  if (session.phase.kind === "failed") {
    return { status: "active", next: session, effects: [] };
  }
  if (obs.agentStatus === null) {
    return handleMissingAgentProcess(session, obs);
  }

  const status = obs.agentStatus;
  const phase = session.phase;
  const normalLabel = formatLeadTabLabel(session.threadId);
  const blockedLabel = formatLeadTabLabel(session.threadId, "BLOCKED");

  switch (phase.kind) {
    case "awaiting_prompt": {
      if (status === "blocked") {
        return transitionTo(session, { kind: "startup_blocked" }, [
          { type: "rename_tab", tabId: session.tabId, label: blockedLabel },
          {
            type: "log",
            level: "WARN",
            message: `Lead agent "${session.agentName}" is blocked on startup in Sheprd (tab ${session.tabId}); parked until unblocked.`,
          },
        ]);
      }
      if (isIdleStatus(status)) {
        if (obs.pendingEventsForThread.length === 0) {
          return { status: "remove", effects: [{ type: "close_tab", tabId: session.tabId }] };
        }
        return deliverQueuedPrompt(session, obs.pendingEventsForThread, obs.nowMs);
      }
      return { status: "active", next: session, effects: [] };
    }

    case "startup_blocked": {
      if (status === "working") {
        return transitionTo(session, { kind: "awaiting_prompt" }, [
          { type: "rename_tab", tabId: session.tabId, label: normalLabel },
        ]);
      }
      if (isIdleStatus(status)) {
        const restoreLabel: LeadSessionEffect = {
          type: "rename_tab",
          tabId: session.tabId,
          label: normalLabel,
        };
        if (obs.pendingEventsForThread.length === 0) {
          return {
            status: "remove",
            effects: [restoreLabel, { type: "close_tab", tabId: session.tabId }],
          };
        }
        return deliverQueuedPrompt(session, obs.pendingEventsForThread, obs.nowMs, [restoreLabel]);
      }
      return { status: "active", next: session, effects: [] };
    }

    case "prompt_sent": {
      if (status === "working") {
        return transitionTo(session, { kind: "working" });
      }
      if (status === "blocked") {
        return transitionTo(session, { kind: "ui_blocked" }, [
          { type: "rename_tab", tabId: session.tabId, label: blockedLabel },
          {
            type: "log",
            level: "WARN",
            message: `Lead agent "${session.agentName}" is blocked in Sheprd (tab ${session.tabId}); parked so other threads can proceed.`,
          },
        ]);
      }
      if (isIdleStatus(status)) {
        if (obs.pendingEventsForThread.length > 0) {
          return deliverQueuedPrompt(session, obs.pendingEventsForThread, obs.nowMs);
        }
        if (obs.idleCloseMs === 0 && obs.nowMs > phase.promptedAtMs) {
          return {
            status: "remove",
            effects: [
              { type: "close_tab", tabId: session.tabId },
              {
                type: "log",
                level: "INFO",
                message: `Lead session "${session.agentName}" for thread ${session.threadId} finished; closed tab ${session.tabId}.`,
              },
            ],
          };
        }
        return transitionTo(session, { kind: "idle_grace", sinceMs: obs.nowMs });
      }
      return { status: "active", next: session, effects: [] };
    }

    case "working": {
      if (status === "blocked") {
        return transitionTo(session, { kind: "ui_blocked" }, [
          { type: "rename_tab", tabId: session.tabId, label: blockedLabel },
          {
            type: "log",
            level: "WARN",
            message: `Lead agent "${session.agentName}" is blocked in Sheprd (tab ${session.tabId}); parked so other threads can proceed.`,
          },
        ]);
      }
      if (isIdleStatus(status)) {
        if (obs.pendingEventsForThread.length > 0) {
          return deliverQueuedPrompt(session, obs.pendingEventsForThread, obs.nowMs);
        }
        if (obs.idleCloseMs === 0) {
          return {
            status: "remove",
            effects: [
              { type: "close_tab", tabId: session.tabId },
              {
                type: "log",
                level: "INFO",
                message: `Lead session "${session.agentName}" for thread ${session.threadId} finished; closed tab ${session.tabId}.`,
              },
            ],
          };
        }
        return transitionTo(session, { kind: "idle_grace", sinceMs: obs.nowMs });
      }
      return { status: "active", next: session, effects: [] };
    }

    case "idle_grace": {
      if (status === "working") {
        return transitionTo(session, { kind: "working" });
      }
      if (status === "blocked") {
        return transitionTo(session, { kind: "ui_blocked" }, [
          { type: "rename_tab", tabId: session.tabId, label: blockedLabel },
          {
            type: "log",
            level: "WARN",
            message: `Lead agent "${session.agentName}" is blocked in Sheprd (tab ${session.tabId}); parked so other threads can proceed.`,
          },
        ]);
      }
      if (isIdleStatus(status)) {
        if (obs.pendingEventsForThread.length > 0) {
          return deliverQueuedPrompt(session, obs.pendingEventsForThread, obs.nowMs);
        }
        if (obs.nowMs - phase.sinceMs >= obs.idleCloseMs) {
          return {
            status: "remove",
            effects: [
              { type: "close_tab", tabId: session.tabId },
              {
                type: "log",
                level: "INFO",
                message: `Lead session "${session.agentName}" for thread ${session.threadId} finished and remained idle; closed tab ${session.tabId}.`,
              },
            ],
          };
        }
      }
      return { status: "active", next: session, effects: [] };
    }

    case "ui_blocked": {
      if (status === "working") {
        return transitionTo(session, { kind: "working" }, [
          { type: "rename_tab", tabId: session.tabId, label: normalLabel },
          {
            type: "log",
            level: "INFO",
            message: `Lead agent "${session.agentName}" resumed from [BLOCKED] in tab ${session.tabId}.`,
          },
        ]);
      }
      if (isIdleStatus(status)) {
        const restoreLabel: LeadSessionEffect = {
          type: "rename_tab",
          tabId: session.tabId,
          label: normalLabel,
        };
        if (obs.pendingEventsForThread.length > 0) {
          return deliverQueuedPrompt(session, obs.pendingEventsForThread, obs.nowMs, [
            restoreLabel,
          ]);
        }
        if (obs.idleCloseMs === 0) {
          return {
            status: "remove",
            effects: [
              restoreLabel,
              { type: "close_tab", tabId: session.tabId },
              {
                type: "log",
                level: "INFO",
                message: `Lead agent "${session.agentName}" finished after unblock; closed tab ${session.tabId}.`,
              },
            ],
          };
        }
        return transitionTo(session, { kind: "idle_grace", sinceMs: obs.nowMs }, [restoreLabel]);
      }
      return { status: "active", next: session, effects: [] };
    }

    default:
      return assertNever(phase);
  }
}
