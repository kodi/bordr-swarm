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
}

export function createEmptyLeadState(): LeadWatcherState {
  return {
    seenThreadLatestMsgId: {},
    seenBlockedTaskIds: [],
  };
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
    },
  };
}

export function buildLeadWakePrompt(events: LeadWakeEvent[]): string {
  const lines: string[] = [
    "New Vercel Board event(s) arrived. Follow your playbook in CLAUDE.md and projects.json, inspect each thread with `vercel board read <id>`, act or escalate as appropriate, and then stop cleanly (the Lead Watcher daemon will wake you on the next event):",
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
