import type { HerdrAgent, HerdrClient, HerdrTab } from "../herdr.ts";
import type {
  LiveAgent,
  RestartInPaneOptions,
  RuntimeSnapshot,
  SessionRef,
  SnapshotRef,
  SpawnSessionOptions,
  SpawnSessionResult,
  WorkerRuntime,
} from "../runtime.ts";

function toLiveAgent(agent: HerdrAgent): LiveAgent {
  return {
    paneId: agent.pane_id,
    tabId: agent.tab_id,
    groupId: agent.workspace_id,
    name: agent.name,
    status: agent.agent_status,
    cwd: agent.cwd ?? agent.foreground_cwd,
  };
}

/**
 * `WorkerRuntime` implementation backed by `HerdrClient`.
 * Preserves the exact Herdr CLI call sequence and arguments used before the runtime seam.
 */
export class HerdrRuntime implements WorkerRuntime {
  readonly kind = "herdr" as const;
  readonly uiName = "Sheprd";
  readonly client: HerdrClient;

  constructor(client: HerdrClient) {
    this.client = client;
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const workspaces = await this.client.listWorkspaces();
      return { ok: true, detail: `herdr reachable (${workspaces.length} workspace(s))` };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async spawn(opts: SpawnSessionOptions): Promise<SpawnSessionResult> {
    const spawnedPane = opts.worktree
      ? await this.client.createWorktree({
          cwd: opts.cwd,
          branch: opts.worktree.branch,
          base: opts.worktree.base,
          label: opts.label,
          env: opts.env,
        })
      : opts.groupId
        ? await this.client.createTab({
            workspaceId: opts.groupId,
            cwd: opts.cwd,
            label: opts.label,
            env: opts.env,
            focus: false,
          })
        : await this.client.findOrCreateProjectTab({
            workspaceLabel: opts.group,
            cwd: opts.cwd,
            tabLabel: opts.label,
            env: opts.env,
          });

    const startRes = await this.client.startAgent({
      name: opts.agent.name,
      kind: opts.agent.kind,
      paneId: spawnedPane.paneId,
      args: opts.agent.args,
      timeoutMs: opts.timeoutMs,
    });

    return {
      ref: {
        runtime: "herdr",
        groupId: spawnedPane.workspaceId,
        tabId: spawnedPane.tabId,
        paneId: spawnedPane.paneId,
        agentName: opts.agent.name,
      },
      blockedOnStartup: startRes.blockedOnStartup,
      promptNow: !startRes.blockedOnStartup,
    };
  }

  async restartInPane(opts: RestartInPaneOptions): Promise<SpawnSessionResult> {
    const startRes = await this.client.startAgent({
      name: opts.agent.name,
      kind: opts.agent.kind,
      paneId: opts.ref.paneId,
      args: opts.agent.args,
      timeoutMs: opts.timeoutMs,
    });

    return {
      ref: opts.ref,
      blockedOnStartup: startRes.blockedOnStartup,
      promptNow: !startRes.blockedOnStartup,
    };
  }

  async prompt(ref: SessionRef, text: string): Promise<void> {
    await this.client.promptAgent(ref.agentName, text);
  }

  async snapshot(_refs: readonly SnapshotRef[]): Promise<RuntimeSnapshot> {
    const [tabs, agents] = await Promise.all([
      this.client.listTabs().catch(() => [] as HerdrTab[]),
      this.client.listAgents().catch(() => [] as HerdrAgent[]),
    ]);

    const tabIds = new Set<string>();
    for (const tab of tabs) tabIds.add(tab.tab_id);

    const agentsByPane = new Map<string, LiveAgent>();
    for (const agent of agents) {
      agentsByPane.set(agent.pane_id, toLiveAgent(agent));
    }

    return { tabIds, agentsByPane };
  }

  async listLiveAgents(): Promise<LiveAgent[]> {
    const agents = await this.client.listAgents();
    return agents.map(toLiveAgent);
  }

  async rename(ref: SessionRef, label: string): Promise<void> {
    await this.client.renameTab(ref.tabId, label);
  }

  async close(ref: SessionRef): Promise<void> {
    await this.client.closeTab(ref.tabId);
  }

  async removeWorktree(ref: SessionRef): Promise<void> {
    await this.client.removeWorktree(ref.groupId);
  }

  async readTail(ref: SessionRef, lines: number): Promise<string> {
    return this.client.paneRead(ref.paneId, { lines });
  }
}
