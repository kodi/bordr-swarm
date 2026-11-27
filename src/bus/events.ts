import { z } from "zod";
import { normalizeBoardTask, normalizeLabels, type BoardTask } from "../lib/board.ts";
import {
  BoardMessageSchema,
  HerdrAgentStatusSchema,
  type BoardMessage,
  type HerdrAgentStatus,
} from "../lib/schemas.ts";

/**
 * Task event operations seen from `vercel board tail --json` (CLI 66.6.0). `other` tolerates any
 * future type; `renewed` is expected but was not observed in a live sample.
 */
export const BOARD_TASK_OPS = [
  "created",
  "ready",
  "claimed",
  "completed",
  "blocked",
  "unblocked",
  "failed",
  "canceled",
  "released",
  "expired",
  "renewed",
] as const;
export type BoardTaskOp = (typeof BOARD_TASK_OPS)[number] | "other";

export type BoardMessageOp = "posted" | "edited" | "deleted";

export type EventSourceName = "board" | "herdr";

/**
 * Everything the daemons react to. Events are hints: consumers wake a level-triggered reconcile
 * instead of treating an event as the only source of truth.
 */
export type SwarmEvent =
  | {
      kind: "board.message";
      op: BoardMessageOp;
      message: BoardMessage;
      cursor: string;
      /** When the Board recorded the event (ISO), if the envelope carried it. */
      createdAt?: string;
    }
  | {
      kind: "board.task";
      op: BoardTaskOp;
      /** Raw Board type, e.g. `task.blocked` (useful when `op` is `other`). */
      type: string;
      task: BoardTask;
      /** The thread root message snapshot, when the event carried one. */
      message: BoardMessage | null;
      cursor: string;
      createdAt?: string;
    }
  | {
      kind: "board.reaction";
      op: "added" | "removed";
      messageId: string;
      channel: string;
      emoji: string;
      cursor: string;
    }
  | { kind: "board.other"; type: string; cursor: string }
  | { kind: "herdr.agent_status"; paneId: string; status: HerdrAgentStatus; agent: string | null }
  | { kind: "herdr.pane_exited"; paneId: string }
  | { kind: "herdr.pane_closed"; paneId: string }
  | { kind: "herdr.tab_closed"; tabId: string }
  | { kind: "timer.reconcile" }
  | { kind: "fs.changed"; path: string }
  | { kind: "source.health"; source: EventSourceName; healthy: boolean; detail: string };

export type SwarmEventKind = SwarmEvent["kind"];

/** Cursor carried by Board events (used to resume `tail --after`). */
export function boardEventCursor(event: SwarmEvent): string | null {
  switch (event.kind) {
    case "board.message":
    case "board.task":
    case "board.reaction":
    case "board.other":
      return event.cursor;
    default:
      return null;
  }
}

/** Thread root ID for a Board message (the message itself when it is a root). */
export function threadRootId(message: BoardMessage): string {
  return message.re?.trim() || message.id;
}

/** Labels on a Board message, normalized to a flat string map. */
export function messageLabels(message: BoardMessage): Record<string, string> {
  return normalizeLabels(message.labels);
}

// ---------------------------------------------------------------------------
// Board tail envelope
// ---------------------------------------------------------------------------

/** One line of `vercel board tail --json`: `{ cursor, type, createdAt, payload, message, actor }`. */
export const BoardTailEnvelopeSchema = z
  .object({
    cursor: z.union([z.string(), z.number()]).transform(String),
    type: z.string().min(1),
    createdAt: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).nullable().optional(),
    message: z.record(z.string(), z.unknown()).nullable().optional(),
    actor: z.unknown().optional(),
  })
  .passthrough();

export type BoardTailLineResult =
  | { kind: "event"; event: SwarmEvent }
  | { kind: "skip"; reason: string }
  /** The CLI rejected `--after` (it prints a pretty JSON error with `"reason": "invalid_cursor"`). */
  | { kind: "cursor_rejected" };

const INVALID_CURSOR_RE = /"(?:reason|code)"\s*:\s*"invalid_cursor"/;

/** True when CLI output (one line or a whole buffer) reports a rejected tail cursor. */
export function isInvalidCursorOutput(text: string): boolean {
  return INVALID_CURSOR_RE.test(text);
}

const BOARD_TASK_OP_SET = new Set<string>(BOARD_TASK_OPS);

function parseMessage(
  raw: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
): BoardMessage | null {
  const fromMessage = raw ? BoardMessageSchema.safeParse(raw) : null;
  if (fromMessage?.success) return fromMessage.data;
  // Fall back to the payload (it carries id/channel/text/re/by for message events).
  const fromPayload = payload ? BoardMessageSchema.safeParse(payload) : null;
  return fromPayload?.success ? fromPayload.data : null;
}

/**
 * Pure parser for one NDJSON line from `vercel board tail --json`. Never throws: blank lines,
 * non-JSON noise, and unknown event types are skipped (or mapped to `board.other`).
 */
export function parseBoardTailLine(line: string): BoardTailLineResult {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "skip", reason: "blank" };
  if (isInvalidCursorOutput(trimmed)) return { kind: "cursor_rejected" };
  if (!trimmed.startsWith("{")) return { kind: "skip", reason: "not JSON" };

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { kind: "skip", reason: "not JSON" };
  }
  const env = BoardTailEnvelopeSchema.safeParse(raw);
  if (!env.success) return { kind: "skip", reason: "not a tail event" };
  const { cursor, type, payload } = env.data;
  const at = env.data.createdAt ? { createdAt: env.data.createdAt } : {};
  const rawMessage = env.data.message ?? null;
  const [family, op = ""] = type.split(".", 2);

  if (family === "message") {
    if (op !== "posted" && op !== "edited" && op !== "deleted") {
      return { kind: "event", event: { kind: "board.other", type, cursor } };
    }
    const message = parseMessage(rawMessage, payload);
    if (!message) return { kind: "skip", reason: `${type} without a message` };
    return { kind: "event", event: { kind: "board.message", op, message, cursor, ...at } };
  }

  if (family === "task") {
    const task = normalizeBoardTask(rawMessage ? { message: rawMessage } : (payload ?? {}));
    if (!task) return { kind: "skip", reason: `${type} without a task id` };
    const taskOp: BoardTaskOp = BOARD_TASK_OP_SET.has(op) ? (op as BoardTaskOp) : "other";
    return {
      kind: "event",
      event: {
        kind: "board.task",
        op: taskOp,
        type,
        task,
        message: parseMessage(rawMessage, null),
        cursor,
        ...at,
      },
    };
  }

  if (family === "reaction" && (op === "added" || op === "removed")) {
    const messageId =
      typeof payload?.id === "string"
        ? payload.id
        : typeof rawMessage?.id === "string"
          ? rawMessage.id
          : "";
    if (!messageId) return { kind: "skip", reason: `${type} without a message id` };
    return {
      kind: "event",
      event: {
        kind: "board.reaction",
        op,
        messageId,
        channel: typeof rawMessage?.channel === "string" ? rawMessage.channel : "",
        emoji: typeof payload?.emoji === "string" ? payload.emoji : "",
        cursor,
      },
    };
  }

  return { kind: "event", event: { kind: "board.other", type, cursor } };
}

/**
 * Splits a byte stream into complete lines. Partial trailing data is kept until the next chunk;
 * a runaway line longer than `maxLineBytes` is dropped so a stuck stream cannot grow memory.
 */
export class LineSplitter {
  private buffer = "";
  private readonly maxLineBytes: number;

  constructor(maxLineBytes = 8 * 1024 * 1024) {
    this.maxLineBytes = maxLineBytes;
  }

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      lines.push(this.buffer.slice(0, idx).replace(/\r$/, ""));
      this.buffer = this.buffer.slice(idx + 1);
      idx = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > this.maxLineBytes) {
      this.buffer = "";
    }
    return lines;
  }

  /** Returns any unterminated trailing data and clears it. */
  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }
}

// ---------------------------------------------------------------------------
// Herdr socket events
// ---------------------------------------------------------------------------

const HerdrEventLineSchema = z
  .object({
    event: z.string().min(1),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

/**
 * Pure parser for one Herdr event line (`{ event, data }`). Herdr 0.9.5 names events with
 * underscores (`tab_closed`, `pane_exited`); dotted names are accepted too. Returns null for
 * anything else, including request responses.
 */
export function parseHerdrEventLine(raw: unknown): SwarmEvent | null {
  const parsed = HerdrEventLineSchema.safeParse(raw);
  if (!parsed.success) return null;
  const name = parsed.data.event.replace(/\./g, "_");
  const data = parsed.data.data;
  const str = (key: string): string => (typeof data[key] === "string" ? data[key] : "");

  switch (name) {
    case "tab_closed": {
      const tabId = str("tab_id");
      return tabId ? { kind: "herdr.tab_closed", tabId } : null;
    }
    case "pane_exited": {
      const paneId = str("pane_id");
      return paneId ? { kind: "herdr.pane_exited", paneId } : null;
    }
    case "pane_closed": {
      const paneId = str("pane_id");
      return paneId ? { kind: "herdr.pane_closed", paneId } : null;
    }
    case "pane_agent_status_changed": {
      const paneId = str("pane_id");
      if (!paneId) return null;
      const status = HerdrAgentStatusSchema.catch("unknown").parse(data.agent_status);
      return {
        kind: "herdr.agent_status",
        paneId,
        status,
        agent: typeof data.agent === "string" ? data.agent : null,
      };
    }
    default:
      return null;
  }
}
