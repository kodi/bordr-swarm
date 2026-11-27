import type { AgentStatus } from "./schemas.ts";

export type { AgentStatus };

export type RuntimeKind = "herdr" | "rex";

export interface SessionRef {
  runtime: RuntimeKind;
  /** Herdr `workspace_id` or Rex `session_id`. */
  groupId: string;
  /** Herdr `tab_id` or Rex `window_id`. */
  tabId: string;
  /** Herdr `pane_id` or Rex `block_id`. */
  paneId: string;
  /** Herdr agent name or Rex agent/window identifier. */
  agentName: string;
}

export interface LiveAgent {
  paneId: string;
  tabId?: string;
  groupId?: string;
  name?: string;
  /** `"unknown"` means the process is alive with no reported status yet. */
  status: AgentStatus;
  blockedKind?: "permission" | "question" | "auth" | string;
  cwd?: string;
}

export interface RuntimeSnapshot {
  tabIds: Set<string>;
  /** Keyed by `paneId`. Absent means no live agent process (exited or closed). */
  agentsByPane: Map<string, LiveAgent>;
}

export interface SpawnSessionOptions {
  /** Project slug (Herdr workspace label or Rex session label). */
  group: string;
  /** Existing group ID when spawning a sibling tab (e.g. a Reviewer in the same workspace/session). */
  groupId?: string;
  cwd: string;
  label: string;
  env: Record<string, string>;
  agent: { name: string; kind: string; args: string[] };
  /** Native worktree creation (Herdr only; Rex manages git worktrees in the Dispatcher). */
  worktree?: { branch: string; base?: string };
  timeoutMs: number;
}

export interface SpawnSessionResult {
  ref: SessionRef;
  blockedOnStartup: boolean;
  /**
   * True when the agent is already ready for its initial prompt (Herdr `agent start` waited for
   * readiness); false when the FSM should wait in `awaiting_prompt` until the first `idle`/`done`.
   */
  promptNow: boolean;
}

export interface RestartInPaneOptions {
  ref: SessionRef;
  cwd: string;
  label: string;
  env: Record<string, string>;
  agent: { name: string; kind: string; args: string[] };
  timeoutMs: number;
}

export interface SnapshotRef extends SessionRef {
  startedAtMs?: number;
}

export interface WorkerRuntime {
  readonly kind: RuntimeKind;
  /** Human-facing UI name for notifications (e.g. "Sheprd" or "Rex"). */
  readonly uiName: string;
  health(): Promise<{ ok: boolean; detail: string }>;
  spawn(opts: SpawnSessionOptions): Promise<SpawnSessionResult>;
  restartInPane(opts: RestartInPaneOptions): Promise<SpawnSessionResult>;
  prompt(ref: SessionRef, text: string): Promise<void>;
  snapshot(refs: readonly SnapshotRef[]): Promise<RuntimeSnapshot>;
  /** Lists all live swarm-managed agents (used by orphan sweep and `status`). */
  listLiveAgents(): Promise<LiveAgent[]>;
  rename(ref: SessionRef, label: string): Promise<void>;
  close(ref: SessionRef): Promise<void>;
  removeWorktree?(ref: SessionRef): Promise<void>;
  readTail(ref: SessionRef, lines: number): Promise<string>;
}

/**
 * Sanitizes an agent identifier to match `/^[a-z][a-z0-9_-]{0,31}$/` (required by Herdr and
 * safe as a compact label token across runtimes).
 */
export function sanitizeAgentName(prefix: string, rawId = ""): string {
  const cleanPrefix = prefix.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const cleanId = rawId
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "");
  const combined = cleanId ? `${cleanPrefix || "w"}-${cleanId}` : cleanPrefix || "w-task";
  const startsWithLetter = /^[a-z]/.test(combined) ? combined : `w-${combined}`;
  return startsWithLetter.slice(0, 32);
}

export function buildSessionRef(params: {
  runtime: RuntimeKind;
  groupId: string;
  tabId: string;
  paneId: string;
  agentName: string;
}): SessionRef {
  return {
    runtime: params.runtime,
    groupId: params.groupId,
    tabId: params.tabId,
    paneId: params.paneId,
    agentName: params.agentName,
  };
}
