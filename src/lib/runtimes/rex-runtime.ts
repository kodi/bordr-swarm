import {
  DEFAULT_REX_AUTH_GRACE_MS,
  normalizeRexStatus,
  RexNotFoundError,
  type RexClient,
} from "../rex.ts";
import {
  sanitizeAgentName,
  type LiveAgent,
  type RestartInPaneOptions,
  type RuntimeSnapshot,
  type SessionRef,
  type SnapshotRef,
  type SpawnSessionOptions,
  type SpawnSessionResult,
  type WorkerRuntime,
} from "../runtime.ts";
import type { RexWindow } from "../schemas.ts";

const SWARM_TASK_LABEL_RE = /^(?:\[(?:BLOCKED|FAILED|ORPHANED)\]\s+)?task-([a-zA-Z0-9_-]+)/;
const SWARM_REVIEW_LABEL_RE =
  /^(?:\[(?:BLOCKED|FAILED|ORPHANED)\]\s+)?review-([a-zA-Z0-9_-]+)\s+r(\d+)/;

/**
 * Extracts the deterministic swarm agent name (`w-<shortId>` or `r<N>-<shortId>`) from a
 * `formatTabLabel` / `formatReviewTabLabel` window label, or returns null for non-swarm windows.
 */
export function parseSwarmAgentNameFromWindowLabel(label: string): string | null {
  const rev = SWARM_REVIEW_LABEL_RE.exec(label.trim());
  if (rev?.[1] && rev[2]) {
    return sanitizeAgentName(`r${rev[2]}`, rev[1]);
  }
  const task = SWARM_TASK_LABEL_RE.exec(label.trim());
  if (task?.[1]) {
    return sanitizeAgentName("w", task[1]);
  }
  return null;
}

export function isSwarmWindowLabel(label: string): boolean {
  return parseSwarmAgentNameFromWindowLabel(label) !== null;
}

function buildEnvCommand(
  env: Record<string, string>,
  agent: { kind: string; args: string[] },
): string[] {
  const entries = Object.entries(env);
  if (entries.length === 0) {
    return [agent.kind, ...agent.args];
  }
  return ["env", ...entries.map(([k, v]) => `${k}=${v}`), agent.kind, ...agent.args];
}

function primaryBlockId(win: RexWindow): string | null {
  if (win.focused_block_id) return win.focused_block_id;
  for (const layer of win.layers) {
    const first = layer.blocks[0];
    if (first?.block_id) return first.block_id;
  }
  return null;
}

export interface RexRuntimeOptions {
  authGraceMs?: number;
  now?: () => number;
}

/**
 * `WorkerRuntime` implementation backed by `RexClient` (Rex `0.1.0-preview.25`).
 * Maps project slug -> Rex session, task -> Rex window, agent -> root block.
 */
export class RexRuntime implements WorkerRuntime {
  readonly kind = "rex" as const;
  readonly uiName = "Rex";
  readonly client: RexClient;
  private readonly authGraceMs: number;
  private readonly now: () => number;

  constructor(client: RexClient, opts: RexRuntimeOptions = {}) {
    this.client = client;
    this.authGraceMs = opts.authGraceMs ?? DEFAULT_REX_AUTH_GRACE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const info = await this.client.whoami();
      return {
        ok: true,
        detail: `rex ${info.rex_version ?? "unknown"} (${info.session_count ?? 0} session(s))`,
      };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async spawn(opts: SpawnSessionOptions): Promise<SpawnSessionResult> {
    if (opts.worktree) {
      throw new Error(
        "RexRuntime does not manage worktrees directly; the Dispatcher creates git worktrees before calling spawn().",
      );
    }

    const command = buildEnvCommand(opts.env, opts.agent);
    let sessionId = opts.groupId;

    if (!sessionId) {
      const sessions = await this.client.listSessions();
      const existing = sessions.find((s) => s.label === opts.group);
      sessionId = existing?.session_id;
    }

    if (sessionId) {
      try {
        const win = await this.client.newWindow({
          sessionId,
          label: opts.label,
          cwd: opts.cwd,
          command,
          focus: false,
          keepOpen: true,
        });
        const blockId = win.block_ids[0];
        if (!blockId) {
          throw new Error(`rex window new returned no block_id: ${JSON.stringify(win)}`);
        }
        return {
          ref: {
            runtime: "rex",
            groupId: sessionId,
            tabId: win.window_id,
            paneId: blockId,
            agentName: opts.agent.name,
          },
          blockedOnStartup: false,
          promptNow: false,
        };
      } catch (err) {
        // If a remembered session was closed externally, fall through and create a fresh session.
        if (!(err instanceof RexNotFoundError)) {
          throw err;
        }
      }
    }

    const created = await this.client.newSession({
      label: opts.group,
      cwd: opts.cwd,
      windowLabel: opts.label,
      command,
      keepOpen: true,
    });
    const firstWin = created.initial_windows[0];
    const blockId = firstWin?.block_ids[0];
    if (!firstWin?.window_id || !blockId) {
      throw new Error(`rex new returned incomplete window/block IDs: ${JSON.stringify(created)}`);
    }

    return {
      ref: {
        runtime: "rex",
        groupId: created.session_id,
        tabId: firstWin.window_id,
        paneId: blockId,
        agentName: opts.agent.name,
      },
      blockedOnStartup: false,
      promptNow: false,
    };
  }

  /**
   * Rex blocks launched with a direct command have no fallback shell after exit, so restarting a
   * dead implementer for a fix round spawns a new window in the same session and closes the old one.
   */
  async restartInPane(opts: RestartInPaneOptions): Promise<SpawnSessionResult> {
    const spawned = await this.spawn({
      group: opts.ref.groupId,
      groupId: opts.ref.groupId,
      cwd: opts.cwd,
      label: opts.label,
      env: opts.env,
      agent: opts.agent,
      timeoutMs: opts.timeoutMs,
    });
    await this.client.closeWindow(opts.ref.tabId, { sessionId: opts.ref.groupId }).catch(() => {});
    return spawned;
  }

  async prompt(ref: SessionRef, text: string): Promise<void> {
    await this.client.promptBlock(ref.paneId, text, { sessionId: ref.groupId || undefined });
  }

  async snapshot(refs: readonly SnapshotRef[]): Promise<RuntimeSnapshot> {
    const tabIds = new Set<string>();
    const agentsByPane = new Map<string, LiveAgent>();
    if (refs.length === 0) return { tabIds, agentsByPane };

    const sessionIds = [...new Set(refs.map((r) => r.groupId).filter(Boolean))];
    const windowLists = await Promise.all(
      sessionIds.map(async (sid) => {
        try {
          return await this.client.listWindows(sid);
        } catch (err) {
          if (err instanceof RexNotFoundError) return null;
          return null;
        }
      }),
    );

    for (const list of windowLists) {
      if (!list) continue;
      for (const win of list.windows) {
        tabIds.add(win.window_id);
      }
    }

    const nowMs = this.now();
    await Promise.all(
      refs.map(async (ref) => {
        if (!tabIds.has(ref.tabId)) return;
        try {
          const [statusRes, procRes] = await Promise.all([
            this.client.programStatus(ref.paneId, ref.groupId || undefined),
            this.client.process(ref.paneId, ref.groupId || undefined).catch((err) => {
              if (err instanceof RexNotFoundError) throw err;
              return null;
            }),
          ]);
          const normalized = normalizeRexStatus({
            records: statusRes.records,
            process: procRes,
            startedAtMs: ref.startedAtMs,
            nowMs,
            authGraceMs: this.authGraceMs,
          });
          if (!normalized.alive) return;
          agentsByPane.set(ref.paneId, {
            paneId: ref.paneId,
            tabId: ref.tabId,
            groupId: ref.groupId,
            name: ref.agentName,
            status: normalized.status,
            ...(normalized.blockedKind ? { blockedKind: normalized.blockedKind } : {}),
            ...(normalized.cwd ? { cwd: normalized.cwd } : {}),
          });
        } catch (err) {
          if (err instanceof RexNotFoundError) return;
          // Transient CLI error: omit from agentsByPane only on not-found; otherwise report unknown so
          // a brief hiccup does not look like a crash.
          agentsByPane.set(ref.paneId, {
            paneId: ref.paneId,
            tabId: ref.tabId,
            groupId: ref.groupId,
            name: ref.agentName,
            status: "unknown",
          });
        }
      }),
    );

    return { tabIds, agentsByPane };
  }

  async listLiveAgents(): Promise<LiveAgent[]> {
    const sessions = await this.client.listSessions();
    const nowMs = this.now();
    const out: LiveAgent[] = [];

    for (const session of sessions) {
      const winList = await this.client.listWindows(session.session_id).catch(() => null);
      if (!winList) continue;

      const swarmWindows = winList.windows
        .map((win) => ({
          win,
          agentName: parseSwarmAgentNameFromWindowLabel(win.label),
          blockId: primaryBlockId(win),
        }))
        .filter(
          (entry): entry is { win: RexWindow; agentName: string; blockId: string } =>
            entry.agentName !== null && entry.blockId !== null,
        );

      const results = await Promise.all(
        swarmWindows.map(async ({ win, agentName, blockId }) => {
          try {
            const [statusRes, procRes] = await Promise.all([
              this.client.programStatus(blockId, session.session_id),
              this.client.process(blockId, session.session_id).catch(() => null),
            ]);
            const normalized = normalizeRexStatus({
              records: statusRes.records,
              process: procRes,
              nowMs,
              authGraceMs: this.authGraceMs,
            });
            if (!normalized.alive) return null;
            return {
              paneId: blockId,
              tabId: win.window_id,
              groupId: session.session_id,
              name: agentName,
              status: normalized.status,
              ...(normalized.blockedKind ? { blockedKind: normalized.blockedKind } : {}),
              ...(normalized.cwd ? { cwd: normalized.cwd } : {}),
            } satisfies LiveAgent;
          } catch {
            return null;
          }
        }),
      );

      for (const item of results) {
        if (item) out.push(item);
      }
    }

    return out;
  }

  async rename(ref: SessionRef, label: string): Promise<void> {
    await this.client.renameWindow(ref.tabId, label, { sessionId: ref.groupId || undefined });
  }

  async close(ref: SessionRef): Promise<void> {
    await this.client.closeWindow(ref.tabId, { sessionId: ref.groupId || undefined });
  }

  async readTail(ref: SessionRef, lines: number): Promise<string> {
    const raw = await this.client.capture(ref.paneId, { sessionId: ref.groupId || undefined });
    if (!raw) return "";
    const allLines = raw.replaceAll("\r\n", "\n").split("\n");
    return allLines.slice(-Math.max(1, lines)).join("\n");
  }
}
