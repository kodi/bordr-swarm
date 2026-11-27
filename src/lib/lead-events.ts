import type { BoardMessage, BoardTask, BoardThreadSummary } from "./board.ts";

export type LeadEventKind = "inbox" | "mention" | "blocked_task";

export interface LeadWakeEvent {
  kind: LeadEventKind;
  channel: string;
  threadId: string;
  latestMessageId?: string;
  author: string;
  preview: string;
}

export interface LeadWatcherState {
  seenThreadLatestMsgId: Record<string, string>;
  seenBlockedTaskIds: string[];
  pendingByThread: Record<string, LeadWakeEvent[]>;
}

export function createEmptyLeadState(): LeadWatcherState {
  return {
    seenThreadLatestMsgId: {},
    seenBlockedTaskIds: [],
    pendingByThread: {},
  };
}

export function enqueueLeadEvents(
  existing: Record<string, LeadWakeEvent[]>,
  events: LeadWakeEvent[],
): Record<string, LeadWakeEvent[]> {
  if (events.length === 0) return existing;
  const next: Record<string, LeadWakeEvent[]> = {};
  for (const [threadId, list] of Object.entries(existing)) {
    next[threadId] = [...list];
  }
  for (const ev of events) {
    const bucket = next[ev.threadId] ?? [];
    const isDuplicate = bucket.some(
      (prev) => prev.kind === ev.kind && prev.latestMessageId === ev.latestMessageId,
    );
    if (!isDuplicate) {
      bucket.push(ev);
      next[ev.threadId] = bucket;
    }
  }
  return next;
}

export function isAuthoredByProfile(msg: BoardMessage, profile: string): boolean {
  const target = profile.trim().toLowerCase();
  if (!target) return false;
  const byProfile = msg.by?.profile?.trim().toLowerCase();
  const handle = msg.author?.handle?.trim().toLowerCase();
  const name = msg.author?.name?.trim().toLowerCase();
  return byProfile === target || handle === target || name === target;
}

export function getMessageAuthorLabel(msg: BoardMessage): string {
  return (
    msg.by?.profile?.trim() || msg.author?.handle?.trim() || msg.author?.name?.trim() || "user"
  );
}

export function mentionsProfile(text: string, profile: string): boolean {
  const escaped = profile.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  const re = new RegExp(`(^|[^a-zA-Z0-9_-])@${escaped}(?![a-zA-Z0-9_-])`, "i");
  return re.test(text);
}

/** Reaction the Lead Watcher adds to new human `#inbox` messages as the "seen" signal. */
export const LEAD_ACK_EMOJI = "eyes";
const LEAD_ACK_EMOJI_KEYS = new Set(["eyes", "👀"]);

/**
 * True only for messages written by a human: Board marks agent/profile posts with
 * `author.kind = "agent"` (and a non-null `by.profile`), so those never count.
 */
export function isHumanMessage(msg: BoardMessage, leadProfile: string): boolean {
  if (msg.deleted) return false;
  if (isAuthoredByProfile(msg, leadProfile)) return false;
  const kind = msg.author?.kind?.trim().toLowerCase();
  if (kind) return kind === "person";
  return !msg.by?.profile?.trim();
}

/** True if `profile` (actor IDs look like `vercel:user:<id>+<profile>`) already reacted with `emoji`. */
export function hasProfileReaction(msg: BoardMessage, profile: string): boolean {
  const target = profile.trim().toLowerCase();
  if (!target || !msg.reactions) return false;
  for (const [emoji, actors] of Object.entries(msg.reactions)) {
    if (!LEAD_ACK_EMOJI_KEYS.has(emoji)) continue;
    if (actors.some((actor) => actor.trim().toLowerCase().endsWith(`+${target}`))) {
      return true;
    }
  }
  return false;
}

/**
 * Picks the IDs of new human messages in a thread (root + replies, in order) that still
 * need Lead's 👀. `sinceMessageId` is the last message already handled for this thread:
 * only messages after it are new. If it is set but missing from `messages`, only the
 * newest message is considered, so old history is never reacted to retroactively.
 */
export function selectMessagesToAcknowledge(params: {
  messages: BoardMessage[];
  sinceMessageId?: string;
  leadProfile: string;
}): string[] {
  const { messages, sinceMessageId, leadProfile } = params;
  let candidates = messages;
  if (sinceMessageId) {
    const idx = messages.findIndex((m) => m.id === sinceMessageId);
    candidates = idx >= 0 ? messages.slice(idx + 1) : messages.slice(-1);
  }
  return candidates
    .filter((m) => isHumanMessage(m, leadProfile) && !hasProfileReaction(m, leadProfile))
    .map((m) => m.id);
}

function truncatePreview(text: string, maxLen = 220): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen - 1)}…`;
}

export function collectLeadEvents(params: {
  inboxChannel: string;
  inboxThreads: BoardThreadSummary[];
  projectThreadsByChannel: Record<string, BoardThreadSummary[]>;
  blockedTasks: BoardTask[];
  leadProfile: string;
  state: LeadWatcherState;
}): { events: LeadWakeEvent[]; nextState: LeadWatcherState } {
  const events: LeadWakeEvent[] = [];
  const nextSeenThreads: Record<string, string> = { ...params.state.seenThreadLatestMsgId };
  const prevBlocked = new Set(params.state.seenBlockedTaskIds);

  // 1. New or updated #inbox threads (whose latest message is not from Lead)
  for (const thread of params.inboxThreads) {
    const rootId = thread.message.id;
    const latest = thread.last ?? thread.message;
    if (latest.deleted) {
      nextSeenThreads[rootId] = latest.id;
      continue;
    }
    if (nextSeenThreads[rootId] === latest.id) {
      continue;
    }
    nextSeenThreads[rootId] = latest.id;
    if (isAuthoredByProfile(latest, params.leadProfile)) {
      continue;
    }
    events.push({
      kind: "inbox",
      channel: params.inboxChannel,
      threadId: rootId,
      latestMessageId: latest.id,
      author: getMessageAuthorLabel(latest),
      preview: truncatePreview(latest.text),
    });
  }

  // 2. @lead mentions in #projects/* channels
  for (const [channel, threads] of Object.entries(params.projectThreadsByChannel)) {
    for (const thread of threads) {
      const rootId = thread.message.id;
      const latest = thread.last ?? thread.message;
      if (latest.deleted) {
        nextSeenThreads[rootId] = latest.id;
        continue;
      }
      if (nextSeenThreads[rootId] === latest.id) {
        continue;
      }
      nextSeenThreads[rootId] = latest.id;
      if (isAuthoredByProfile(latest, params.leadProfile)) {
        continue;
      }
      if (!mentionsProfile(latest.text, params.leadProfile)) {
        continue;
      }
      events.push({
        kind: "mention",
        channel,
        threadId: rootId,
        latestMessageId: latest.id,
        author: getMessageAuthorLabel(latest),
        preview: truncatePreview(latest.text),
      });
    }
  }

  // 3. Newly blocked tasks under #projects/* (prunes resolved tasks so re-blocks wake Lead again)
  const currentBlockedIds: string[] = [];
  for (const task of params.blockedTasks) {
    currentBlockedIds.push(task.id);
    if (prevBlocked.has(task.id)) {
      continue;
    }
    events.push({
      kind: "blocked_task",
      channel: task.channel,
      threadId: task.id,
      author: task.assignee ?? "worker",
      preview: truncatePreview(task.text),
    });
  }

  return {
    events,
    nextState: {
      seenThreadLatestMsgId: nextSeenThreads,
      seenBlockedTaskIds: currentBlockedIds,
      pendingByThread: params.state.pendingByThread ?? {},
    },
  };
}

export function buildLeadWakePrompt(events: LeadWakeEvent[]): string {
  const lines: string[] = [
    "New Vercel Board event(s) arrived for this thread. This is an ephemeral Lead session scoped to this thread — follow your playbook in CLAUDE.md and projects.json, inspect the full thread with `vercel board read <id>` (and recent `#inbox` / `#projects/*` if the message references earlier work), act or escalate as appropriate, and then stop cleanly (this tab will auto-close once idle):",
    "",
  ];

  for (const ev of events) {
    if (ev.kind === "inbox") {
      lines.push(
        `- [INBOX] #${ev.channel} thread \`${ev.threadId}\` (latest by ${ev.author}): "${ev.preview}"`,
      );
    } else if (ev.kind === "mention") {
      lines.push(
        `- [MENTION] #${ev.channel} thread \`${ev.threadId}\` (by ${ev.author}): "${ev.preview}"`,
      );
    } else {
      lines.push(`- [BLOCKED TASK] #${ev.channel} task \`${ev.threadId}\`: "${ev.preview}"`);
    }
  }

  return lines.join("\n");
}
