import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BoardTaskState =
  | "waiting"
  | "ready"
  | "claimed"
  | "blocked"
  | "completed"
  | "failed"
  | "canceled"
  | "unknown";

export interface BoardTask {
  id: string;
  channel: string;
  state: BoardTaskState;
  text: string;
  labels: Record<string, string>;
  assignee?: string;
  raw: Record<string, unknown>;
}

export interface BoardClientOptions {
  scope?: string;
  boardName?: string;
  binary?: string;
  timeoutMs?: number;
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
    // Strip any non-JSON header lines (e.g. CLI banners) before the first { or [
    const objIdx = trimmed.indexOf("{");
    const arrIdx = trimmed.indexOf("[");
    const startIdx =
      objIdx === -1 ? arrIdx : arrIdx === -1 ? objIdx : Math.min(objIdx, arrIdx);
    if (startIdx >= 0) {
      return JSON.parse(trimmed.slice(startIdx));
    }
    throw new Error(`Failed to parse JSON from output: ${trimmed.slice(0, 200)}`);
  }
}

export function normalizeLabels(rawLabels: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!rawLabels) return out;

  if (Array.isArray(rawLabels)) {
    for (const entry of rawLabels) {
      if (typeof entry === "string") {
        const eqIdx = entry.indexOf("=");
        if (eqIdx > 0) {
          out[entry.slice(0, eqIdx).trim()] = entry.slice(eqIdx + 1).trim();
        } else if (entry.trim()) {
          out[entry.trim()] = "true";
        }
      } else if (typeof entry === "object" && entry !== null) {
        const rec = entry as Record<string, unknown>;
        const k = typeof rec.key === "string" ? rec.key : typeof rec.name === "string" ? rec.name : "";
        const v = typeof rec.value === "string" ? rec.value : "true";
        if (k) out[k] = v;
      }
    }
    return out;
  }

  if (typeof rawLabels === "object") {
    for (const [k, v] of Object.entries(rawLabels as Record<string, unknown>)) {
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

const VALID_STATES = new Set<BoardTaskState>([
  "waiting",
  "ready",
  "claimed",
  "blocked",
  "completed",
  "failed",
  "canceled",
]);

function normalizeState(value: unknown): BoardTaskState {
  if (typeof value === "string") {
    const lower = value.toLowerCase() as BoardTaskState;
    if (VALID_STATES.has(lower)) return lower;
  }
  return "unknown";
}

export function normalizeBoardTask(raw: unknown): BoardTask | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  // Some responses wrap the task object under `.task` or `.message`
  const taskObj =
    typeof obj.task === "object" && obj.task !== null && !Array.isArray(obj.task)
      ? (obj.task as Record<string, unknown>)
      : obj;
  const rootObj =
    typeof taskObj.root === "object" && taskObj.root !== null && !Array.isArray(taskObj.root)
      ? (taskObj.root as Record<string, unknown>)
      : typeof taskObj.message === "object" &&
          taskObj.message !== null &&
          !Array.isArray(taskObj.message)
        ? (taskObj.message as Record<string, unknown>)
        : undefined;

  const rawId =
    taskObj.id ?? taskObj.taskId ?? taskObj.messageId ?? rootObj?.id ?? obj.id;
  if (rawId === undefined || rawId === null || String(rawId).trim() === "") {
    return null;
  }

  const rawChannel =
    taskObj.channel ??
    rootObj?.channel ??
    (typeof taskObj.channelName === "string" ? taskObj.channelName : "");
  const channel = String(rawChannel ?? "").replace(/^#/, "");

  const state = normalizeState(taskObj.state ?? taskObj.status ?? obj.state ?? obj.status);
  const text = String(taskObj.text ?? rootObj?.text ?? taskObj.title ?? "");

  const mergedLabels = {
    ...normalizeLabels(rootObj?.labels),
    ...normalizeLabels(taskObj.labels),
  };

  const assigneeRaw =
    taskObj.claimedBy ?? taskObj.holder ?? taskObj.assignee ?? taskObj.for ?? taskObj.profile;
  const assignee =
    typeof assigneeRaw === "string"
      ? assigneeRaw
      : typeof assigneeRaw === "object" && assigneeRaw !== null
        ? String(
            (assigneeRaw as Record<string, unknown>).profile ??
              (assigneeRaw as Record<string, unknown>).handle ??
              (assigneeRaw as Record<string, unknown>).name ??
              "",
          )
        : undefined;

  return {
    id: String(rawId).replace(/^#/, ""),
    channel,
    state,
    text,
    labels: mergedLabels,
    assignee: assignee || undefined,
    raw: obj,
  };
}

export class BoardClient {
  readonly scope: string;
  readonly boardName: string;
  readonly binary: string;
  readonly timeoutMs: number;
  readonly runner: ExecRunner;

  constructor(options: BoardClientOptions = {}, runner: ExecRunner = defaultRunner) {
    this.scope = options.scope?.trim() ?? "";
    this.boardName = options.boardName?.trim() ?? "";
    this.binary = options.binary ?? "vercel";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.runner = runner;
  }

  private buildArgs(
    subcommandArgs: string[],
    opts?: { asProfile?: string; json?: boolean },
  ): string[] {
    const args = ["board", ...subcommandArgs];
    if (opts?.json !== false) {
      args.push("--json");
    }
    if (opts?.asProfile) {
      args.push("--as", opts.asProfile);
    }
    if (this.boardName) {
      args.push("--name", this.boardName);
    }
    if (this.scope) {
      args.push("--scope", this.scope);
    }
    return args;
  }

  private async runJson(
    subcommandArgs: string[],
    opts?: { asProfile?: string; timeoutMs?: number },
  ): Promise<unknown> {
    const args = this.buildArgs(subcommandArgs, { asProfile: opts?.asProfile, json: true });
    const { stdout } = await this.runner(this.binary, args, {
      timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
    });
    return extractJsonPayload(stdout);
  }

  async whoami(): Promise<Record<string, unknown>> {
    const data = await this.runJson(["whoami"]);
    return (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  }

  async listTasks(
    channelPrefix?: string,
    opts?: { state?: string; labels?: string[]; limit?: number; asProfile?: string },
  ): Promise<BoardTask[]> {
    const args = ["tasks"];
    if (channelPrefix) {
      args.push(channelPrefix);
    }
    if (opts?.state) {
      args.push("--state", opts.state);
    }
    if (opts?.limit) {
      args.push("--limit", String(opts.limit));
    }
    for (const label of opts?.labels ?? []) {
      args.push("--label", label);
    }

    let data: unknown;
    try {
      data = await this.runJson(args, { asProfile: opts?.asProfile });
    } catch (err) {
      const stdout =
        typeof err === "object" && err !== null && "stdout" in err
          ? String((err as { stdout?: unknown }).stdout ?? "")
          : "";
      const stderr =
        typeof err === "object" && err !== null && "stderr" in err
          ? String((err as { stderr?: unknown }).stderr ?? "")
          : "";
      const combined = `${stdout}\n${stderr}`;
      if (combined.includes("channel_not_found")) {
        return [];
      }
      throw new Error(
        `vercel board tasks failed: ${combined.trim() || (err instanceof Error ? err.message : String(err))}`,
      );
    }
    const list = Array.isArray(data)
      ? data
      : typeof data === "object" && data !== null && Array.isArray((data as Record<string, unknown>).tasks)
        ? ((data as Record<string, unknown>).tasks as unknown[])
        : [];

    const tasks: BoardTask[] = [];
    for (const item of list) {
      const normalized = normalizeBoardTask(item);
      if (normalized) tasks.push(normalized);
    }
    return tasks;
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

  async renewTask(
    taskId: string,
    opts: { asProfile: string; lease: string },
  ): Promise<void> {
    const args = ["tasks", "renew", taskId, "--lease", opts.lease];
    await this.runJson(args, { asProfile: opts.asProfile });
  }

  async completeTask(
    taskId: string,
    result: string,
    opts: { asProfile: string },
  ): Promise<void> {
    const args = ["tasks", "complete", taskId, result];
    await this.runJson(args, { asProfile: opts.asProfile });
  }

  async failTask(
    taskId: string,
    reason: string,
    opts: { asProfile: string },
  ): Promise<void> {
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
}
