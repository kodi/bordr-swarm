import { threadRootId, type SwarmEvent } from "../bus/events.ts";
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
  /** Thread reply count when its seen marker was set (detects skipped messages on catch-up). */
  seenThreadReplyCount?: Record<string, number>;
  /** When each seen thread last appeared in a channel read or live event (for pruning). */
  seenThreadLastSeenMs?: Record<string, number>;
  /** Recently handled message IDs, oldest first; de-duplicates the live and catch-up paths. */
  handledMessageIds?: string[];
  /** `vercel board tail` cursor to resume with `--after`. */
  tailCursor?: string;
}

/** Seen-thread markers not refreshed for this long are dropped. */
export const SEEN_THREAD_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** How many handled message IDs are kept for de-duplication. */
export const HANDLED_MESSAGE_ID_LIMIT = 1000;

export function createEmptyLeadState(): LeadWatcherState {
  return {
    seenThreadLatestMsgId: {},
    seenBlockedTaskIds: [],
    pendingByThread: {},
    seenThreadReplyCount: {},
    seenThreadLastSeenMs: {},
    handledMessageIds: [],
  };
}

/** Appends IDs to the handled list (no duplicates), keeping only the newest `limit`. */
export function rememberHandledIds(
  existing: readonly string[] | undefined,
  ids: readonly string[],
  limit = HANDLED_MESSAGE_ID_LIMIT,
): string[] {
  const fresh = ids.filter(Boolean);
  if (fresh.length === 0) return [...(existing ?? [])];
  const drop = new Set(fresh);
  const merged = [...(existing ?? []).filter((id) => !drop.has(id)), ...fresh];
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
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

/**
 * Project threads whose reply count advanced by more than one since the seen marker and whose
 * latest message alone does not wake Lead. Their full thread must be read so a mention followed
 * by another reply within one poll window is not lost.
 */
export function selectThreadsNeedingRead(params: {
  projectThreadsByChannel: Record<string, BoardThreadSummary[]>;
  leadProfile: string;
  state: LeadWatcherState;
}): string[] {
  const out: string[] = [];
  const seen = params.state.seenThreadLatestMsgId;
  const counts = params.state.seenThreadReplyCount ?? {};
  for (const threads of Object.values(params.projectThreadsByChannel)) {
    for (const thread of threads) {
      const rootId = thread.message.id;
      const latest = thread.last ?? thread.message;
      const prevCount = counts[rootId];
      if (seen[rootId] === undefined || seen[rootId] === latest.id) continue;
      if (prevCount === undefined || thread.replies - prevCount <= 1) continue;
      const latestWakes =
        !latest.deleted &&
        !isAuthoredByProfile(latest, params.leadProfile) &&
        mentionsProfile(latest.text, params.leadProfile);
      if (!latestWakes) out.push(rootId);
    }
  }
  return out;
}

/** Messages of a thread (root first) newer than the seen marker. */
function messagesAfterMarker(
  messages: readonly BoardMessage[],
  markerId: string | undefined,
  prevReplyCount: number | undefined,
): BoardMessage[] {
  if (markerId) {
    const idx = messages.findIndex((m) => m.id === markerId);
    if (idx >= 0) return messages.slice(idx + 1);
  }
  if (prevReplyCount !== undefined) return messages.slice(prevReplyCount + 1);
  return messages.slice(-1);
}

export function collectLeadEvents(params: {
  inboxChannel: string;
  inboxThreads: BoardThreadSummary[];
  projectThreadsByChannel: Record<string, BoardThreadSummary[]>;
  blockedTasks: BoardTask[];
  leadProfile: string;
  state: LeadWatcherState;
  /** Full threads (root first) for the IDs from `selectThreadsNeedingRead`. */
  threadMessages?: Record<string, BoardMessage[]>;
  /** Clock for pruning stale seen markers; omitted, nothing is pruned. */
  nowMs?: number;
}): { events: LeadWakeEvent[]; nextState: LeadWatcherState } {
  const events: LeadWakeEvent[] = [];
  const nextSeenThreads: Record<string, string> = { ...params.state.seenThreadLatestMsgId };
  const nextCounts: Record<string, number> = { ...params.state.seenThreadReplyCount };
  const nextLastSeen: Record<string, number> = { ...params.state.seenThreadLastSeenMs };
  const handled = new Set(params.state.handledMessageIds ?? []);
  const newlyHandled: string[] = [];
  const prevBlocked = new Set(params.state.seenBlockedTaskIds);
  const nowMs = params.nowMs;

  const touch = (thread: BoardThreadSummary, latest: BoardMessage): void => {
    const rootId = thread.message.id;
    nextSeenThreads[rootId] = latest.id;
    nextCounts[rootId] = thread.replies;
    if (nowMs !== undefined) nextLastSeen[rootId] = nowMs;
  };

  // 1. New or updated #inbox threads (whose latest message is not from Lead)
  for (const thread of params.inboxThreads) {
    const rootId = thread.message.id;
    const latest = thread.last ?? thread.message;
    const unchanged = nextSeenThreads[rootId] === latest.id;
    touch(thread, latest);
    if (unchanged || latest.deleted || handled.has(latest.id)) continue;
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
    newlyHandled.push(latest.id);
  }

  // 2. @lead mentions in #projects/* channels
  for (const [channel, threads] of Object.entries(params.projectThreadsByChannel)) {
    for (const thread of threads) {
      const rootId = thread.message.id;
      const latest = thread.last ?? thread.message;
      const marker = nextSeenThreads[rootId];
      const prevCount = nextCounts[rootId];
      const unchanged = marker === latest.id;
      touch(thread, latest);
      if (unchanged) continue;

      const detail = params.threadMessages?.[rootId];
      const candidates = detail ? messagesAfterMarker(detail, marker, prevCount) : [latest];
      for (const msg of candidates) {
        if (msg.deleted || handled.has(msg.id)) continue;
        if (isAuthoredByProfile(msg, params.leadProfile)) continue;
        if (!mentionsProfile(msg.text, params.leadProfile)) continue;
        events.push({
          kind: "mention",
          channel,
          threadId: rootId,
          latestMessageId: msg.id,
          author: getMessageAuthorLabel(msg),
          preview: truncatePreview(msg.text),
        });
        newlyHandled.push(msg.id);
      }
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

  // 4. Prune seen markers for threads that have not shown up for a long time
  if (nowMs !== undefined) {
    for (const rootId of Object.keys(nextSeenThreads)) {
      const lastSeen = nextLastSeen[rootId];
      if (lastSeen === undefined) {
        nextLastSeen[rootId] = nowMs;
      } else if (nowMs - lastSeen > SEEN_THREAD_RETENTION_MS) {
        delete nextSeenThreads[rootId];
        delete nextCounts[rootId];
        delete nextLastSeen[rootId];
      }
    }
  }

  return {
    events,
    nextState: {
      ...params.state,
      seenThreadLatestMsgId: nextSeenThreads,
      seenThreadReplyCount: nextCounts,
      seenThreadLastSeenMs: nextLastSeen,
      handledMessageIds: rememberHandledIds(params.state.handledMessageIds, newlyHandled),
      seenBlockedTaskIds: currentBlockedIds,
      pendingByThread: params.state.pendingByThread ?? {},
    },
  };
}

// ---------------------------------------------------------------------------
// Live path: one Board event at a time
// ---------------------------------------------------------------------------

export interface LeadLiveContext {
  inboxChannel: string;
  projectChannelPrefix: string;
  registryChannel: string;
  leadProfile: string;
  nowMs: number;
}

function cleanChannel(channel: string | undefined): string {
  return (channel ?? "").replace(/^#/, "");
}

/** True when this Board message was already handled (live replay or the catch-up path). */
export function isMessageAlreadyHandled(message: BoardMessage, state: LeadWatcherState): boolean {
  if ((state.handledMessageIds ?? []).includes(message.id)) return true;
  return state.seenThreadLatestMsgId[threadRootId(message)] === message.id;
}

/**
 * Pure: the Lead wake event (if any) for one live Board event. Inbox posts and replies not by
 * Lead, @lead mentions in project channels, and newly blocked tasks under the project prefix.
 */
export function leadWakeEventFromBoardEvent(
  event: SwarmEvent,
  ctx: Pick<LeadLiveContext, "inboxChannel" | "projectChannelPrefix" | "leadProfile">,
): LeadWakeEvent | null {
  if (event.kind === "board.message") {
    if (event.op !== "posted") return null;
    const msg = event.message;
    const channel = cleanChannel(msg.channel);
    if (msg.deleted || isAuthoredByProfile(msg, ctx.leadProfile)) return null;
    if (channel === ctx.inboxChannel) {
      return {
        kind: "inbox",
        channel,
        threadId: threadRootId(msg),
        latestMessageId: msg.id,
        author: getMessageAuthorLabel(msg),
        preview: truncatePreview(msg.text),
      };
    }
    if (
      channel.startsWith(ctx.projectChannelPrefix) &&
      mentionsProfile(msg.text, ctx.leadProfile)
    ) {
      return {
        kind: "mention",
        channel,
        threadId: threadRootId(msg),
        latestMessageId: msg.id,
        author: getMessageAuthorLabel(msg),
        preview: truncatePreview(msg.text),
      };
    }
    return null;
  }
  if (event.kind === "board.task" && event.op === "blocked") {
    const task = event.task;
    if (!cleanChannel(task.channel).startsWith(ctx.projectChannelPrefix)) return null;
    return {
      kind: "blocked_task",
      channel: cleanChannel(task.channel),
      threadId: task.id,
      author: task.assignee ?? "worker",
      preview: truncatePreview(task.text),
    };
  }
  return null;
}

/** Tail cursor carried by a Board event, if any. */
function boardCursor(event: SwarmEvent): string | undefined {
  return event.kind === "board.message" ||
    event.kind === "board.task" ||
    event.kind === "board.reaction" ||
    event.kind === "board.other"
    ? event.cursor
    : undefined;
}

/**
 * State update for a live event that the catch-up path (or an earlier delivery) already covered:
 * only the tail cursor moves. Seen markers and reply counts stay as the newer catch-up left them.
 */
export function advanceTailCursor(state: LeadWatcherState, event: SwarmEvent): LeadWatcherState {
  const cursor = boardCursor(event);
  return cursor ? { ...state, tailCursor: cursor } : state;
}

/** Skew allowance between the Board's clock and ours when comparing event times. */
export const CATCH_UP_COVER_MARGIN_MS = 30_000;

/**
 * True when a live Board event happened before a catch-up read that started at
 * `catchUpStartedMs` (with a safety margin for clock skew), so that read already reflected it.
 * Events without a timestamp are never considered covered.
 */
export function isCoveredByCatchUp(event: SwarmEvent, catchUpStartedMs: number | null): boolean {
  if (catchUpStartedMs === null) return false;
  if (event.kind !== "board.message" && event.kind !== "board.task") return false;
  const at = event.createdAt ? Date.parse(event.createdAt) : Number.NaN;
  return Number.isFinite(at) && at < catchUpStartedMs - CATCH_UP_COVER_MARGIN_MS;
}

/**
 * Pure state update after a live Board event was handled: advances the seen marker of inbox and
 * project threads (so the catch-up path does not report the same message again), remembers the
 * message ID, keeps `seenBlockedTaskIds` in step with task transitions, and stores the cursor.
 */
export function applyLiveBoardEventToState(
  state: LeadWatcherState,
  event: SwarmEvent,
  ctx: Pick<LeadLiveContext, "inboxChannel" | "projectChannelPrefix" | "nowMs">,
  handledMessageIds: readonly string[] = [],
): LeadWatcherState {
  let next: LeadWatcherState = state;
  if (event.kind === "board.message" && event.op === "posted") {
    const msg = event.message;
    const channel = cleanChannel(msg.channel);
    if (channel === ctx.inboxChannel || channel.startsWith(ctx.projectChannelPrefix)) {
      const rootId = threadRootId(msg);
      const prevCount = state.seenThreadReplyCount?.[rootId];
      // A root starts at 0 replies; a live reply advances a known count by one. An unknown count
      // stays unknown (the next channel read records the real one).
      const { [rootId]: _stale, ...otherCounts } = next.seenThreadReplyCount ?? {};
      const nextCount = msg.re ? (prevCount === undefined ? undefined : prevCount + 1) : 0;
      next = {
        ...next,
        seenThreadLatestMsgId: { ...next.seenThreadLatestMsgId, [rootId]: msg.id },
        seenThreadLastSeenMs: { ...next.seenThreadLastSeenMs, [rootId]: ctx.nowMs },
        seenThreadReplyCount:
          nextCount === undefined ? otherCounts : { ...otherCounts, [rootId]: nextCount },
      };
    }
  }
  if (
    event.kind === "board.task" &&
    cleanChannel(event.task.channel).startsWith(ctx.projectChannelPrefix)
  ) {
    const id = event.task.id;
    const has = next.seenBlockedTaskIds.includes(id);
    if (event.op === "blocked" && !has) {
      next = { ...next, seenBlockedTaskIds: [...next.seenBlockedTaskIds, id] };
    } else if (event.op !== "blocked" && event.op !== "other" && has) {
      next = { ...next, seenBlockedTaskIds: next.seenBlockedTaskIds.filter((t) => t !== id) };
    }
  }
  if (handledMessageIds.length > 0) {
    next = {
      ...next,
      handledMessageIds: rememberHandledIds(next.handledMessageIds, handledMessageIds),
    };
  }
  const cursor =
    event.kind === "board.message" ||
    event.kind === "board.task" ||
    event.kind === "board.reaction" ||
    event.kind === "board.other"
      ? event.cursor
      : undefined;
  return cursor ? { ...next, tailCursor: cursor } : next;
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
