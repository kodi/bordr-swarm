import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  BoardChannelListEnvelopeSchema,
  BoardRawLabelSchema,
  BoardReadChannelEnvelopeSchema,
  BoardReadThreadEnvelopeSchema,
  BoardTaskListEnvelopeSchema,
  BoardTaskStateSchema,
  type BoardMessage,
  type BoardTaskState,
  type BoardThreadSummary,
} from "./schemas.ts";

const execFileAsync = promisify(execFile);

export type { BoardMessage, BoardTaskState, BoardThreadSummary };

export interface BoardThreadDetail {
  message: BoardMessage;
  replies: BoardMessage[];
  cursor: string | null;
}

export interface BoardTask {
  id: string;
  channel: string;
  state: BoardTaskState;
  text: string;
  labels: Record<string, string>;
  assignee?: string;
  replyCount?: number;
  raw: Record<string, unknown>;
}

export interface BoardClientOptions {
  url?: string;
  scope?: string;
  boardName?: string;
  binary?: string;
  timeoutMs?: number;
  /** Sink for non-fatal warnings (for example, hitting the task-list page cap). */
  onWarn?: (message: string) => void;
}

/** Default page size for `vercel board tasks` (matches the CLI's own default). */
export const DEFAULT_TASK_PAGE_SIZE = 50;
/** Hard cap on pages fetched by one `listTasks` call, so a misbehaving cursor cannot loop forever. */
export const DEFAULT_TASK_MAX_PAGES = 20;

/** Maximum length enforced by Vercel Board for `--as` profile names. */
export const MAX_BOARD_PROFILE_LENGTH = 32;
/** Vercel Board profile format: starts with a letter, up to 32 letters/numbers/hyphens. */
export const BOARD_PROFILE_REGEX = /^[a-zA-Z][a-zA-Z0-9-]{0,31}$/;

function sanitizeProfileToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Builds a Vercel Board `--as` profile name guaranteed to match Board's profile rules
 * (`^[a-z][a-z0-9-]{0,31}$`).
 *
 * When `<prefix>-<name>` (or `<prefix>-<name>-<suffix>`) is already valid and within 32 chars,
 * it is returned unchanged. Otherwise, the middle `<name>` segment is shortened with a
 * deterministic 6-char SHA-256 hash of the raw `name` so distinct long or non-ASCII machine
 * names never collide.
 */
export function buildBoardProfile(prefix: string, name: string, suffix?: string): string {
  let cleanPrefix = sanitizeProfileToken(prefix);
  if (!cleanPrefix || !/^[a-z]/.test(cleanPrefix)) {
    cleanPrefix = cleanPrefix ? `p-${cleanPrefix}` : "p";
  }
  cleanPrefix = cleanPrefix.slice(0, 12).replace(/-+$/, "") || "p";

  const rawSuffix = suffix ? sanitizeProfileToken(suffix) : "";
  const cleanSuffix = rawSuffix.slice(0, 12).replace(/-+$/, "");

  const cleanName = sanitizeProfileToken(name);
  const fixedOverhead = cleanPrefix.length + 1 + (cleanSuffix ? cleanSuffix.length + 1 : 0);
  const nameBudget = Math.max(0, MAX_BOARD_PROFILE_LENGTH - fixedOverhead);

  const nameLossless = cleanName.length > 0 && cleanName === name.toLowerCase();
  let namePart: string;
  if (nameLossless && cleanName.length <= nameBudget) {
    namePart = cleanName;
  } else if (nameBudget === 0) {
    namePart = "";
  } else {
    const hash = createHash("sha256").update(name).digest("hex").slice(0, 6);
    if (nameBudget <= hash.length) {
      namePart = hash.slice(0, nameBudget);
    } else {
      const headBudget = nameBudget - hash.length - 1;
      const head = cleanName.slice(0, headBudget).replace(/-+$/, "");
      namePart = head ? `${head}-${hash}` : hash;
    }
  }

  const parts = [cleanPrefix, namePart, cleanSuffix].filter(Boolean);
  return parts.join("-").slice(0, MAX_BOARD_PROFILE_LENGTH).replace(/-+$/, "");
}

export function registryBoardProfile(machineName: string): string {
  return buildBoardProfile("registry", machineName);
}

/**
 * Board claim actors look like `<scheme>:user:<id>+<profile>` (e.g. `vercel:user:123+worker-1`
 * or `local:user:test+worker-1`); return just the profile part so it can be compared with the
 * `--as` profile names the dispatcher uses. Plain values pass through.
 */
export function claimProfileFromActor(actor: string): string {
  const plusIdx = actor.lastIndexOf("+");
  if (plusIdx >= 0 && actor.includes(":")) {
    return actor.slice(plusIdx + 1);
  }
  return actor;
}

export interface ExecRunner {
  (
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ stdout: string; stderr: string }>;
}

const defaultRunner: ExecRunner = async (cmd, args, opts) => {
  const res = await execFileAsync(cmd, args, {
    encoding: "utf8",
    timeout: opts?.timeoutMs ?? 30_000,
    maxBuffer: 10 * 1024 * 1024,
    env: opts?.env ?? process.env,
  });
  return { stdout: res.stdout, stderr: res.stderr };
};

export function extractJsonPayload(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const objIdx = trimmed.indexOf("{");
    const arrIdx = trimmed.indexOf("[");
    const startIdx = objIdx === -1 ? arrIdx : arrIdx === -1 ? objIdx : Math.min(objIdx, arrIdx);
    if (startIdx >= 0) {
      return JSON.parse(trimmed.slice(startIdx));
    }
    throw new Error(`Failed to parse JSON from output: ${trimmed.slice(0, 200)}`);
  }
}

export function normalizeLabels(rawLabels: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!rawLabels) return out;

  const arrResult = z.array(BoardRawLabelSchema).safeParse(rawLabels);
  if (arrResult.success) {
    for (const entry of arrResult.data) {
      if (typeof entry === "string") {
        const eqIdx = entry.indexOf("=");
        if (eqIdx > 0) {
          out[entry.slice(0, eqIdx).trim()] = entry.slice(eqIdx + 1).trim();
        } else if (entry.trim()) {
          out[entry.trim()] = "true";
        }
      } else {
        const k = entry.key ?? entry.name ?? "";
        const v = entry.value !== undefined ? String(entry.value) : "true";
        if (k) out[k] = v;
      }
    }
    return out;
  }

  const recordResult = z.record(z.string(), z.unknown()).safeParse(rawLabels);
  if (recordResult.success) {
    for (const [k, v] of Object.entries(recordResult.data)) {
      if (typeof v === "string") {
        out[k] = v;
      } else if (typeof v === "number" || typeof v === "boolean") {
        out[k] = String(v);
      } else if (Array.isArray(v) && typeof v[0] === "string") {
        out[k] = v[0];
      }
    }
  }

  return out;
}

function normalizeState(value: unknown): BoardTaskState {
  if (typeof value !== "string") return "unknown";
  const parsed = BoardTaskStateSchema.safeParse(value.toLowerCase());
  return parsed.success ? parsed.data : "unknown";
}

const RecordSchema = z.record(z.string(), z.unknown());

export function normalizeBoardTask(raw: unknown): BoardTask | null {
  const objRes = RecordSchema.safeParse(raw);
  if (!objRes.success) return null;
  const obj = objRes.data;

  // Vercel Board CLI 66.6.0 returns `{ message: { id, channel, text, labels, task: { state, claim, ... } }, replies, last }`
  // Other responses may pass the message object directly or wrap under `.task`.
  const msgRes = RecordSchema.safeParse(obj.message ?? obj.root);
  const msgObj = msgRes.success ? msgRes.data : obj;

  const taskMetaRes = RecordSchema.safeParse(msgObj.task ?? obj.task);
  const taskMeta = taskMetaRes.success ? taskMetaRes.data : msgObj;

  const rawId = msgObj.id ?? taskMeta.id ?? taskMeta.taskId ?? taskMeta.messageId ?? obj.id;
  if (rawId === undefined || rawId === null || String(rawId).trim() === "") {
    return null;
  }

  const rawChannel =
    msgObj.channel ??
    taskMeta.channel ??
    (typeof msgObj.channelName === "string" ? msgObj.channelName : "");
  const channel = String(rawChannel ?? "").replace(/^#/, "");

  const mergedLabels = {
    ...normalizeLabels(obj.labels),
    ...normalizeLabels(msgObj.labels),
    ...normalizeLabels(taskMeta.labels),
  };

  const state = normalizeState(
    taskMeta.state ?? taskMeta.status ?? mergedLabels["board.task"] ?? msgObj.state ?? obj.state,
  );
  const text = String(msgObj.text ?? taskMeta.text ?? msgObj.title ?? "");

  const claimRes = RecordSchema.safeParse(taskMeta.claim);
  const assigneeRaw =
    (claimRes.success
      ? (claimRes.data.profile ?? claimRes.data.holder ?? claimRes.data.by ?? claimRes.data.actor)
      : undefined) ??
    taskMeta.claimedBy ??
    taskMeta.holder ??
    taskMeta.assignee ??
    taskMeta.for ??
    taskMeta.profile;
  const assigneeObj = RecordSchema.safeParse(assigneeRaw);
  const assignee =
    typeof assigneeRaw === "string"
      ? assigneeRaw
      : assigneeObj.success
        ? String(assigneeObj.data.profile ?? assigneeObj.data.handle ?? assigneeObj.data.name ?? "")
        : undefined;

  const replyCount =
    typeof obj.replies === "number" && Number.isFinite(obj.replies)
      ? obj.replies
      : Array.isArray(obj.replies)
        ? obj.replies.length
        : undefined;

  return {
    id: String(rawId).replace(/^#/, ""),
    channel,
    state,
    text,
    labels: mergedLabels,
    assignee: assignee ? claimProfileFromActor(assignee) : undefined,
    ...(replyCount !== undefined ? { replyCount } : {}),
    raw: obj,
  };
}

export interface ParsedBoardError {
  code?: string;
  httpStatus?: number;
  message?: string;
}

export function parseBoardErrorOutput(stdout: string, stderr: string): ParsedBoardError | null {
  for (const raw of [stdout, stderr]) {
    if (!raw.trim()) continue;
    try {
      const payload = extractJsonPayload(raw);
      const rootRes = RecordSchema.safeParse(payload);
      if (!rootRes.success) continue;
      const root = rootRes.data;
      const dataRes = RecordSchema.safeParse(root.data);
      const nestedErrRes = RecordSchema.safeParse(
        (dataRes.success ? dataRes.data.error : undefined) ?? root.error,
      );
      const nestedErr = nestedErrRes.success ? nestedErrRes.data : null;

      const code =
        typeof nestedErr?.code === "string"
          ? nestedErr.code
          : typeof root.code === "string"
            ? root.code
            : typeof root.reason === "string"
              ? root.reason
              : undefined;
      const httpStatus =
        typeof nestedErr?.status === "number"
          ? nestedErr.status
          : typeof root.statusCode === "number"
            ? root.statusCode
            : undefined;
      const message =
        typeof nestedErr?.message === "string" && nestedErr.message.trim()
          ? nestedErr.message.trim()
          : typeof root.message === "string" && root.message.trim()
            ? root.message.trim()
            : undefined;

      if (code || httpStatus !== undefined || message) {
        return { code, httpStatus, message };
      }
    } catch {
      // Output is not JSON; fall back to plain text
    }
  }
  return null;
}

export class BoardCommandError extends Error {
  readonly subcommand: string;
  readonly code?: string;
  readonly httpStatus?: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(params: {
    message: string;
    subcommand: string;
    code?: string;
    httpStatus?: number;
    stdout: string;
    stderr: string;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "BoardCommandError";
    this.subcommand = params.subcommand;
    this.code = params.code;
    this.httpStatus = params.httpStatus;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
  }
}

export function isClaimConflictError(err: unknown): boolean {
  if (err instanceof BoardCommandError) {
    if (err.httpStatus === 409) return true;
    if (
      err.code &&
      /^(already_claimed|task_already_claimed|conflict|not_ready|claim_conflict)$/i.test(err.code)
    ) {
      return true;
    }
  }
  const combined =
    `${describeExecError(err)}\n${err instanceof Error ? err.message : String(err)}`.toLowerCase();
  return (
    combined.includes("already claimed") ||
    combined.includes("already_claimed") ||
    combined.includes("not ready") ||
    combined.includes("not_ready") ||
    combined.includes("claim conflict")
  );
}

const SUBCOMMANDS_WITH_ACTION = new Set(["tasks", "channels"]);
const KNOWN_SUBACTIONS = new Set([
  "claim",
  "renew",
  "complete",
  "fail",
  "block",
  "release",
  "create",
]);

function formatSubcommandLabel(binary: string, subcommandArgs: string[]): string {
  const isVercelCli = basename(binary) === "vercel";
  const head = subcommandArgs[0] ?? "";
  const second = subcommandArgs[1] ?? "";
  const sub =
    SUBCOMMANDS_WITH_ACTION.has(head) && KNOWN_SUBACTIONS.has(second) ? `${head} ${second}` : head;
  return isVercelCli ? `vercel board ${sub}`.trim() : `${basename(binary)} ${sub}`.trim();
}

function extractExecStreams(err: unknown): { stdout: string; stderr: string } {
  const stdout =
    typeof err === "object" && err !== null && "stdout" in err
      ? String((err as { stdout?: unknown }).stdout ?? "")
      : "";
  const stderr =
    typeof err === "object" && err !== null && "stderr" in err
      ? String((err as { stderr?: unknown }).stderr ?? "")
      : "";
  return { stdout, stderr };
}

function describeExecError(err: unknown): string {
  const { stdout, stderr } = extractExecStreams(err);
  return `${stdout}\n${stderr}`;
}

function isChannelNotFoundError(err: unknown): boolean {
  if (err instanceof BoardCommandError && err.code === "channel_not_found") {
    return true;
  }
  return describeExecError(err).includes("channel_not_found");
}

export class BoardClient {
  readonly url: string;
  readonly scope: string;
  readonly boardName: string;
  readonly binary: string;
  readonly timeoutMs: number;
  readonly runner: ExecRunner;
  readonly onWarn: (message: string) => void;

  constructor(options: BoardClientOptions = {}, runner: ExecRunner = defaultRunner) {
    this.onWarn = options.onWarn ?? ((message) => console.warn(message));
    this.url = options.url?.trim() ?? "";
    this.scope = options.scope?.trim() ?? "";
    this.boardName = options.boardName?.trim() ?? "";
    this.binary = options.binary?.trim() || "vercel";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.runner = runner;
  }

  private buildArgs(
    subcommandArgs: string[],
    opts?: { asProfile?: string; json?: boolean },
  ): string[] {
    const isVercelCli = basename(this.binary) === "vercel";
    const args = isVercelCli ? ["board", ...subcommandArgs] : [...subcommandArgs];
    if (opts?.json !== false) {
      args.push("--json");
    }
    if (opts?.asProfile) {
      args.push("--as", opts.asProfile);
    }
    if (this.url) {
      args.push("--url", this.url);
    } else {
      if (this.boardName) {
        args.push("--name", this.boardName);
      }
      if (this.scope) {
        args.push("--scope", this.scope);
      }
    }
    return args;
  }

  /**
   * Command line for `vercel board tail --json` (or `vb tail --json` for the standalone CLI) with
   * the same `--url` / `--name` / `--scope` handling as every other call. `channel` may be a
   * channel or a `prefix/`; omitted, the tail covers the whole board.
   */
  buildTailCommand(opts: { channel?: string; after?: string } = {}): {
    cmd: string;
    args: string[];
  } {
    const sub = ["tail"];
    const channel = opts.channel?.replace(/^#/, "").trim();
    if (channel) sub.push(channel);
    if (opts.after) sub.push("--after", opts.after);
    return { cmd: this.binary, args: this.buildArgs(sub, { json: true }) };
  }

  private async runJson(
    subcommandArgs: string[],
    opts?: { asProfile?: string; timeoutMs?: number },
  ): Promise<unknown> {
    const args = this.buildArgs(subcommandArgs, { asProfile: opts?.asProfile, json: true });
    let stdout: string;
    try {
      const res = await this.runner(this.binary, args, {
        timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
      });
      stdout = res.stdout;
    } catch (err) {
      if (err instanceof BoardCommandError) throw err;
      const { stdout: errStdout, stderr: errStderr } = extractExecStreams(err);
      const parsed = parseBoardErrorOutput(errStdout, errStderr);
      const cmdLabel = formatSubcommandLabel(this.binary, subcommandArgs);
      const tagParts = [
        parsed?.httpStatus !== undefined ? String(parsed.httpStatus) : "",
        parsed?.code ?? "",
      ].filter(Boolean);
      const tag = tagParts.length > 0 ? ` (${tagParts.join(" ")})` : "";
      const rawOutput = [errStderr.trim(), errStdout.trim()].filter(Boolean).join(" | ");
      const fallback = err instanceof Error ? err.message : String(err);
      const detail = parsed?.message ?? (rawOutput ? rawOutput.slice(0, 600) : fallback);
      throw new BoardCommandError({
        message: `${cmdLabel} failed${tag}: ${detail}`,
        subcommand: cmdLabel,
        code: parsed?.code,
        httpStatus: parsed?.httpStatus,
        stdout: errStdout,
        stderr: errStderr,
        cause: err,
      });
    }
    return extractJsonPayload(stdout);
  }

  async whoami(): Promise<Record<string, unknown>> {
    const data = await this.runJson(["whoami"]);
    const parsed = RecordSchema.safeParse(data);
    return parsed.success ? parsed.data : {};
  }

  /**
   * Lists tasks, following the cursor with `--after` until a page comes back shorter than the
   * page size (or empty). A non-null cursor alone is not trusted as "more pages": the Board has
   * been observed returning one on a short final page. `limit` is the page size.
   */
  async listTasks(
    channelPrefix?: string,
    opts?: {
      state?: string;
      labels?: string[];
      limit?: number;
      maxPages?: number;
      asProfile?: string;
    },
  ): Promise<BoardTask[]> {
    const pageSize = opts?.limit && opts.limit > 0 ? opts.limit : DEFAULT_TASK_PAGE_SIZE;
    const maxPages = opts?.maxPages && opts.maxPages > 0 ? opts.maxPages : DEFAULT_TASK_MAX_PAGES;
    const tasks: BoardTask[] = [];
    const seen = new Set<string>();
    let after: string | undefined;

    for (let page = 1; ; page += 1) {
      const { items, rawCount, cursor } = await this.listTasksPage(channelPrefix, {
        ...opts,
        limit: pageSize,
        after,
      });
      for (const task of items) {
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        tasks.push(task);
      }

      if (rawCount === 0 || rawCount < pageSize || !cursor || cursor === after) {
        return tasks;
      }
      if (page >= maxPages) {
        this.onWarn(
          `vercel board tasks ${channelPrefix ?? ""} --state ${opts?.state ?? "open"}: stopped after ${maxPages} page(s) of ${pageSize} (${tasks.length} task(s)); results may be incomplete.`,
        );
        return tasks;
      }
      after = cursor;
    }
  }

  private async listTasksPage(
    channelPrefix: string | undefined,
    opts: { state?: string; labels?: string[]; limit: number; after?: string; asProfile?: string },
  ): Promise<{ items: BoardTask[]; rawCount: number; cursor: string | null }> {
    const args = ["tasks"];
    if (channelPrefix) {
      args.push(channelPrefix);
    }
    if (opts.state) {
      args.push("--state", opts.state);
    }
    args.push("--limit", String(opts.limit));
    if (opts.after) {
      args.push("--after", opts.after);
    }
    for (const label of opts.labels ?? []) {
      args.push("--label", label);
    }

    let data: unknown;
    try {
      data = await this.runJson(args, { asProfile: opts.asProfile });
    } catch (err) {
      if (isChannelNotFoundError(err)) {
        return { items: [], rawCount: 0, cursor: null };
      }
      throw err;
    }

    const envelope = BoardTaskListEnvelopeSchema.safeParse(data);
    if (!envelope.success) {
      throw new Error(
        `Unexpected JSON from vercel board tasks:\n${z.prettifyError(envelope.error)}`,
      );
    }

    const list = Array.isArray(envelope.data) ? envelope.data : envelope.data.tasks;
    const rawCursor = Array.isArray(envelope.data) ? undefined : envelope.data.cursor;
    const items: BoardTask[] = [];
    for (const item of list) {
      const normalized = normalizeBoardTask(item);
      if (normalized) items.push(normalized);
    }
    return {
      items,
      rawCount: list.length,
      cursor: rawCursor === undefined || rawCursor === null ? null : String(rawCursor),
    };
  }

  /**
   * Point lookup of one task via `vercel board read <id> --json`, whose `message.task` carries the
   * task state and claim (state is `unknown` when the message is not a task).
   */
  async getTask(taskId: string): Promise<BoardTask | null> {
    const cleanId = taskId.replace(/^#/, "");
    const data = await this.runJson(["read", cleanId]);
    return normalizeBoardTask(data);
  }

  async claimTaskById(
    taskId: string,
    opts: { asProfile: string; lease: string },
  ): Promise<BoardTask> {
    const args = ["tasks", "claim", taskId, "--lease", opts.lease];
    const data = await this.runJson(args, { asProfile: opts.asProfile });
    const task = normalizeBoardTask(data);
    if (!task) {
      throw new Error(`Claimed task ${taskId} returned unexpected JSON: ${JSON.stringify(data)}`);
    }
    return task;
  }

  async renewTask(taskId: string, opts: { asProfile: string; lease: string }): Promise<void> {
    const args = ["tasks", "renew", taskId, "--lease", opts.lease];
    await this.runJson(args, { asProfile: opts.asProfile });
  }

  async completeTask(taskId: string, result: string, opts: { asProfile: string }): Promise<void> {
    const args = ["tasks", "complete", taskId, result];
    await this.runJson(args, { asProfile: opts.asProfile });
  }

  async failTask(taskId: string, reason: string, opts: { asProfile: string }): Promise<void> {
    const args = ["tasks", "fail", taskId, reason];
    await this.runJson(args, { asProfile: opts.asProfile });
  }

  async blockTask(
    taskId: string,
    reason: string,
    opts: { asProfile: string; kind?: "needs_input" | "awaiting_approval" },
  ): Promise<void> {
    const args = ["tasks", "block", taskId, reason];
    if (opts.kind) {
      args.push("--kind", opts.kind);
    }
    await this.runJson(args, { asProfile: opts.asProfile });
  }

  async releaseTask(taskId: string, opts: { asProfile: string }): Promise<void> {
    const args = ["tasks", "release", taskId];
    await this.runJson(args, { asProfile: opts.asProfile });
  }

  async reply(taskId: string, text: string, opts: { asProfile: string }): Promise<void> {
    const args = ["reply", taskId, text];
    await this.runJson(args, { asProfile: opts.asProfile });
  }

  async postMessage(
    channel: string,
    text: string,
    opts: { asProfile: string; labels?: string[] },
  ): Promise<string> {
    const clean = channel.replace(/^#/, "");
    const args = ["post", clean, text];
    for (const label of opts.labels ?? []) {
      args.push("--label", label);
    }
    const data = await this.runJson(args, { asProfile: opts.asProfile });
    const rec = RecordSchema.safeParse(data);
    const msg = rec.success ? RecordSchema.safeParse(rec.data.message ?? rec.data) : null;
    const id = msg?.success ? msg.data.id : undefined;
    return typeof id === "string" ? id : "";
  }

  async react(messageId: string, emoji: string, opts: { asProfile: string }): Promise<void> {
    const args = ["react", messageId.replace(/^#/, ""), emoji];
    await this.runJson(args, { asProfile: opts.asProfile });
  }

  async editMessage(messageId: string, text: string, opts: { asProfile: string }): Promise<void> {
    const args = ["edit", messageId, text];
    await this.runJson(args, { asProfile: opts.asProfile });
  }

  async ensureChannel(channel: string, opts?: { asProfile?: string }): Promise<void> {
    const clean = channel.replace(/^#/, "");
    await this.runJson(["channels", "create", clean], { asProfile: opts?.asProfile });
  }

  async listChannels(prefix?: string): Promise<string[]> {
    const args = ["channels"];
    if (prefix) {
      args.push(prefix.replace(/^#/, ""));
    }
    const data = await this.runJson(args);
    const parsed = BoardChannelListEnvelopeSchema.parse(data);
    return parsed.channels.map((ch) => ch.path);
  }

  async readChannel(
    channel: string,
    opts?: { limit?: number; after?: string },
  ): Promise<{ threads: BoardThreadSummary[]; cursor: string | null }> {
    const clean = channel.replace(/^#/, "");
    const args = ["read", clean];
    if (opts?.limit) {
      args.push("--limit", String(opts.limit));
    }
    if (opts?.after) {
      args.push("--after", opts.after);
    }

    let data: unknown;
    try {
      data = await this.runJson(args);
    } catch (err) {
      if (isChannelNotFoundError(err)) {
        return { threads: [], cursor: null };
      }
      throw err;
    }

    const parsed = BoardReadChannelEnvelopeSchema.parse(data);
    return {
      threads: parsed.threads,
      cursor: parsed.cursor ?? null,
    };
  }

  async readThread(messageId: string): Promise<BoardThreadDetail> {
    const cleanId = messageId.replace(/^#/, "");
    const data = await this.runJson(["read", cleanId]);
    const parsed = BoardReadThreadEnvelopeSchema.parse(data);
    return {
      message: parsed.message,
      replies: parsed.replies,
      cursor: parsed.cursor ?? null,
    };
  }
}
