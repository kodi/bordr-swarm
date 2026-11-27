import type { SwarmEvent } from "../bus/events.ts";
import type { Reactor } from "../bus/reactor.ts";
import {
  hasProfileReaction,
  isHumanMessage,
  LEAD_ACK_EMOJI,
  leadWakeEventFromBoardEvent,
} from "../lib/lead-events.ts";

export interface LeadReactorConfig {
  inboxChannel: string;
  projectChannelPrefix: string;
  registryChannel: string;
  leadProfile: string;
}

/** Read-only view of Lead Watcher's sessions, for Herdr wake-ups. */
export interface LeadReactorContext {
  sessionPaneIds: ReadonlySet<string>;
  sessionTabIds: ReadonlySet<string>;
}

function channelOf(event: SwarmEvent): string {
  if (event.kind === "board.message") return (event.message.channel ?? "").replace(/^#/, "");
  if (event.kind === "board.task") return event.task.channel.replace(/^#/, "");
  return "";
}

/**
 * `lead-wake`: #inbox posts and replies not by Lead, @lead mentions in project channels, and
 * newly blocked project tasks queue a wake event for the thread's Lead session.
 */
export function createLeadWakeReactor(config: LeadReactorConfig): Reactor<unknown> {
  return {
    name: "lead-wake",
    matches: (event) => {
      if (event.kind === "board.message") {
        const ch = channelOf(event);
        return (
          event.op === "posted" &&
          (ch === config.inboxChannel || ch.startsWith(config.projectChannelPrefix))
        );
      }
      return event.kind === "board.task" && event.op === "blocked";
    },
    react: (event) => {
      const wake = leadWakeEventFromBoardEvent(event, config);
      return wake ? [{ type: "lead_event", event: wake }] : [];
    },
  };
}

/** `inbox-ack`: react 👀 as Lead on new human #inbox messages. */
export function createInboxAckReactor(config: LeadReactorConfig): Reactor<unknown> {
  return {
    name: "inbox-ack",
    matches: (event) =>
      event.kind === "board.message" &&
      event.op === "posted" &&
      channelOf(event) === config.inboxChannel,
    react: (event) => {
      if (event.kind !== "board.message") return [];
      const msg = event.message;
      if (!isHumanMessage(msg, config.leadProfile)) return [];
      if (hasProfileReaction(msg, config.leadProfile)) return [];
      return [
        { type: "react", messageId: msg.id, emoji: LEAD_ACK_EMOJI, threadId: msg.re || msg.id },
      ];
    },
  };
}

/** `registry-sync`: activity in `#swarm/registry` re-merges the fleet catalog. */
export function createRegistrySyncReactor(config: LeadReactorConfig): Reactor<unknown> {
  return {
    name: "registry-sync",
    matches: (event) =>
      event.kind === "board.message" && channelOf(event) === config.registryChannel,
    react: () => [{ type: "registry_sync" }],
  };
}

/** `lead-session-wake`: Herdr activity in a Lead session's pane or tab wakes Lead Watcher. */
export function createLeadSessionWakeReactor(): Reactor<LeadReactorContext> {
  return {
    name: "lead-session-wake",
    matches: (event) =>
      event.kind === "herdr.agent_status" ||
      event.kind === "herdr.pane_exited" ||
      event.kind === "herdr.pane_closed" ||
      event.kind === "herdr.tab_closed",
    react: (event, ctx) => {
      const ours =
        event.kind === "herdr.tab_closed"
          ? ctx.sessionTabIds.has(event.tabId)
          : "paneId" in event && ctx.sessionPaneIds.has(event.paneId);
      return ours ? [{ type: "wake", reason: event.kind }] : [];
    },
  };
}

/** Built-in Lead Watcher reactors, in execution order (👀 runs before Lead is prompted). */
export function createBuiltinLeadReactors(
  config: LeadReactorConfig,
): Array<Reactor<LeadReactorContext>> {
  return [
    createInboxAckReactor(config),
    createLeadWakeReactor(config),
    createRegistrySyncReactor(config),
    createLeadSessionWakeReactor(),
  ];
}
