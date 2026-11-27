import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { AgentStatus } from "./runtime.ts";
import {
  RexBlockListSchema,
  RexNewSessionSchema,
  RexProcessSchema,
  RexProgramStatusSchema,
  RexSessionListSchema,
  RexWhoamiSchema,
  RexWindowListSchema,
  RexWindowNewSchema,
  type RexBlockSummary,
  type RexNewSession,
  type RexProcess,
  type RexProgramStatus,
  type RexProgramStatusRecord,
  type RexSession,
  type RexWhoami,
  type RexWindowList,
  type RexWindowNew,
} from "./schemas.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_REX_AUTH_GRACE_MS = 5_000;

export type RexExecRunner = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; stdin?: string },
) => Promise<{ stdout: string; stderr: string }>;

export class RexNotFoundError extends Error {
  readonly code = 3;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RexNotFoundError";
  }
}

export class RexUnreachableError extends Error {
  readonly code = 4;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RexUnreachableError";
  }
}

function runWithStdin(
  cmd: string,
  args: string[],
  stdinText: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(new Error(`${cmd} ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        const detail = stderr.trim() || stdout.trim() || `exited with ${signal ?? code ?? "?"}`;
        const err = Object.assign(new Error(`${cmd} ${args.join(" ")} failed: ${detail}`), {
          code,
          stdout,
          stderr,
        });
        rejectPromise(err);
      }
    });

    child.stdin.end(stdinText, "utf8");
  });
}

export const defaultRexRunner: RexExecRunner = async (cmd, args, opts) => {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const env = opts?.env ?? process.env;
  if (opts?.stdin !== undefined) {
    return runWithStdin(cmd, args, opts.stdin, timeoutMs, env);
  }
  const res = await execFileAsync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env,
  });
  return { stdout: res.stdout, stderr: res.stderr };
};

export function classifyRexError(err: unknown): Error {
  if (err instanceof RexNotFoundError || err instanceof RexUnreachableError) {
    return err;
  }
  const e = err as { code?: unknown; status?: unknown; stderr?: unknown; message?: unknown };
  const numericCode =
    typeof e?.code === "number" ? e.code : typeof e?.status === "number" ? e.status : null;
  const stderr = typeof e?.stderr === "string" ? e.stderr : "";
  const message =
    err instanceof Error ? `${err.message}${stderr ? ` ${stderr}` : ""}`.trim() : String(err);

  if (numericCode === 3 || /\bnot found\b/i.test(message)) {
    return new RexNotFoundError(message, { cause: err });
  }
  if (
    numericCode === 4 ||
    /\b(?:server unreachable|connection refused|failed to connect|no server)\b/i.test(message)
  ) {
    return new RexUnreachableError(message, { cause: err });
  }
  return err instanceof Error ? err : new Error(message);
}

export interface NormalizedRexStatus {
  alive: boolean;
  status: AgentStatus;
  blockedKind?: string;
  cwd?: string;
}

function recordTimestampMs(rec: RexProgramStatusRecord): number {
  if (!rec.updated_at) return 0;
  const parsed = Date.parse(rec.updated_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function selectPrimaryRecord(
  records: readonly RexProgramStatusRecord[],
): RexProgramStatusRecord | null {
  if (records.length === 0) return null;
  const root = records.find((r) => r.id === "" || r.id === undefined);
  if (root) return root;
  let newest = records[0]!;
  let newestMs = recordTimestampMs(newest);
  for (let i = 1; i < records.length; i += 1) {
    const candidate = records[i]!;
    const ms = recordTimestampMs(candidate);
    if (ms >= newestMs) {
      newest = candidate;
      newestMs = ms;
    }
  }
  return newest;
}

/**
 * Pure normalizer mapping Rex `program_status` records + `process` snapshot into the
 * runtime-neutral `AgentStatus` consumed by `session-fsm` and `task-fsm`.
 */
export function normalizeRexStatus(params: {
  records: readonly RexProgramStatusRecord[];
  process: RexProcess | null;
  startedAtMs?: number;
  nowMs: number;
  authGraceMs?: number;
}): NormalizedRexStatus {
  const { records, process: proc, startedAtMs, nowMs } = params;
  const authGraceMs = params.authGraceMs ?? DEFAULT_REX_AUTH_GRACE_MS;

  const fg = proc?.foreground ?? null;
  const child = proc?.child ?? null;
  const cwd = fg?.cwd ?? child?.cwd;

  if (proc !== null) {
    const hasProcess = fg !== null || child !== null;
    if (!hasProcess) {
      return { alive: false, status: "unknown", cwd };
    }
  }

  // Drop stale records whose owner PID matches neither the foreground nor root child process.
  const livePids = new Set<number>();
  if (fg?.pid !== undefined) livePids.add(fg.pid);
  if (child?.pid !== undefined) livePids.add(child.pid);

  const freshRecords =
    livePids.size > 0
      ? records.filter((rec) => !rec.owner || livePids.has(rec.owner.pid))
      : records;

  const primary = selectPrimaryRecord(freshRecords);
  if (!primary) {
    return { alive: true, status: "unknown", cwd };
  }

  switch (primary.state) {
    case "done":
      return { alive: true, status: "done", cwd };
    case "idle":
      return { alive: true, status: "idle", cwd };
    case "working":
      return { alive: true, status: "working", cwd };
    case "error":
      return { alive: true, status: "blocked", blockedKind: "error", cwd };
    case "blocked": {
      const kind = primary.kind;
      if (kind === "auth" && startedAtMs !== undefined && nowMs - startedAtMs < authGraceMs) {
        return { alive: true, status: "unknown", cwd };
      }
      return { alive: true, status: "blocked", ...(kind ? { blockedKind: kind } : {}), cwd };
    }
    default:
      return { alive: true, status: "unknown", cwd };
  }
}

export interface RexClientOptions {
  binary?: string;
  timeoutMs?: number;
}

/**
 * Typed wrapper around the Rex CLI (`rex 0.1.0-preview.25`, API rev 24).
 * Every JSON payload is validated with Zod schemas from `src/lib/schemas.ts`.
 */
export class RexClient {
  readonly binary: string;
  readonly timeoutMs: number;
  readonly runner: RexExecRunner;

  constructor(options: RexClientOptions = {}, runner: RexExecRunner = defaultRexRunner) {
    this.binary = options.binary ?? "rex";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.runner = runner;
  }

  private async runRaw(
    args: string[],
    opts?: { timeoutMs?: number; stdin?: string },
  ): Promise<string> {
    try {
      const { stdout } = await this.runner(this.binary, args, {
        timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
        stdin: opts?.stdin,
      });
      return stdout;
    } catch (err) {
      throw classifyRexError(err);
    }
  }

  private async runJson(args: string[], timeoutMs?: number): Promise<unknown> {
    const stdout = await this.runRaw(args, { timeoutMs });
    const trimmed = stdout.trim();
    if (!trimmed) return {};
    return JSON.parse(trimmed) as unknown;
  }

  async version(): Promise<string> {
    const raw = await this.runRaw(["version"]);
    return raw.trim();
  }

  async whoami(): Promise<RexWhoami> {
    return RexWhoamiSchema.parse(await this.runJson(["whoami", "--json"]));
  }

  async listSessions(): Promise<RexSession[]> {
    const res = RexSessionListSchema.parse(await this.runJson(["ls", "--json"]));
    return res.sessions;
  }

  async newSession(opts: {
    label: string;
    cwd: string;
    windowLabel: string;
    command: string[];
    keepOpen?: boolean;
  }): Promise<RexNewSession> {
    const args = ["new", opts.label, "-c", opts.cwd, "--window", opts.windowLabel];
    if (opts.keepOpen) args.push("--keep-open");
    args.push("--json");
    if (opts.command.length > 0) {
      args.push("--", ...opts.command);
    }
    return RexNewSessionSchema.parse(await this.runJson(args));
  }

  async newWindow(opts: {
    sessionId: string;
    label: string;
    cwd: string;
    command: string[];
    focus?: boolean;
    keepOpen?: boolean;
  }): Promise<RexWindowNew> {
    const args = [
      "window",
      "new",
      opts.label,
      "-s",
      opts.sessionId,
      "-c",
      opts.cwd,
      opts.focus ? "--focus=true" : "--focus=false",
    ];
    if (opts.keepOpen) args.push("--keep-open");
    args.push("--json");
    if (opts.command.length > 0) {
      args.push("--", ...opts.command);
    }
    return RexWindowNewSchema.parse(await this.runJson(args));
  }

  async listWindows(sessionId: string): Promise<RexWindowList> {
    return RexWindowListSchema.parse(
      await this.runJson(["window", "ls", "-s", sessionId, "--json"]),
    );
  }

  async listBlocks(sessionId: string): Promise<RexBlockSummary[]> {
    const res = RexBlockListSchema.parse(
      await this.runJson(["block", "ls", "-s", sessionId, "--json"]),
    );
    return res.blocks;
  }

  async programStatus(blockId: string, sessionId?: string): Promise<RexProgramStatus> {
    const args = ["do", "com.superlogical.terminal.program_status"];
    if (sessionId) args.push("-s", sessionId);
    args.push("-b", blockId);
    return RexProgramStatusSchema.parse(await this.runJson(args));
  }

  async process(blockId: string, sessionId?: string): Promise<RexProcess> {
    const args = ["do", "com.superlogical.terminal.process"];
    if (sessionId) args.push("-s", sessionId);
    args.push("-b", blockId);
    return RexProcessSchema.parse(await this.runJson(args));
  }

  /**
   * Sends input text via stdin (`rex send` reads stdin when `[TEXT]` is omitted), avoiding argv
   * length limits and flag parsing. Multi-line text is bracketed-pasted by default so agent TUIs
   * receive it as one message instead of submitting on each newline.
   */
  async send(
    blockId: string,
    text: string,
    opts?: { sessionId?: string; bracketedPaste?: boolean },
  ): Promise<void> {
    const args = ["send"];
    if (opts?.sessionId) args.push("-s", opts.sessionId);
    args.push("-b", blockId);
    const usePaste = opts?.bracketedPaste ?? text.includes("\n");
    const payload = usePaste ? `\x1b[200~${text}\x1b[201~` : text;
    await this.runRaw(args, { stdin: payload });
  }

  async sendKey(blockId: string, key: string, opts?: { sessionId?: string }): Promise<void> {
    const args = ["send-key"];
    if (opts?.sessionId) args.push("-s", opts.sessionId);
    args.push("-b", blockId, key);
    await this.runRaw(args);
  }

  async promptBlock(blockId: string, text: string, opts?: { sessionId?: string }): Promise<void> {
    await this.send(blockId, text, {
      sessionId: opts?.sessionId,
      bracketedPaste: text.includes("\n"),
    });
    await this.sendKey(blockId, "enter", { sessionId: opts?.sessionId });
  }

  async capture(blockId: string, opts?: { sessionId?: string }): Promise<string> {
    const args = ["capture"];
    if (opts?.sessionId) args.push("-s", opts.sessionId);
    args.push("-b", blockId, "--format", "text", "--unwrap", "--trim");
    return this.runRaw(args);
  }

  async renameWindow(
    windowId: string,
    label: string,
    opts?: { sessionId?: string },
  ): Promise<void> {
    const args = ["window", "rename"];
    if (opts?.sessionId) args.push("-s", opts.sessionId);
    args.push(windowId, label);
    await this.runRaw(args);
  }

  async closeWindow(windowId: string, opts?: { sessionId?: string }): Promise<void> {
    const args = ["window", "close"];
    if (opts?.sessionId) args.push("-s", opts.sessionId);
    args.push(windowId);
    await this.runRaw(args);
  }
}
