import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecRunner } from "./board.ts";

const execFileAsync = promisify(execFile);

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrWorkspace {
  workspace_id: string;
  label: string;
  active_tab_id?: string;
  agent_status?: HerdrAgentStatus;
  focused?: boolean;
  pane_count?: number;
  tab_count?: number;
}

export interface HerdrTab {
  tab_id: string;
  workspace_id: string;
  label: string;
  agent_status?: HerdrAgentStatus;
  focused?: boolean;
  pane_count?: number;
}

export interface HerdrAgent {
  agent?: string;
  agent_status: HerdrAgentStatus;
  pane_id: string;
  tab_id?: string;
  workspace_id?: string;
  cwd?: string;
  foreground_cwd?: string;
  terminal_title?: string;
  name?: string;
}

export interface SpawnedPaneResult {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface HerdrClientOptions {
  target?: string;
  binary?: string;
  timeoutMs?: number;
}

const defaultRunner: ExecRunner = async (cmd, args, opts) => {
  const res = await execFileAsync(cmd, args, {
    encoding: "utf8",
    timeout: opts?.timeoutMs ?? 60_000,
    maxBuffer: 10 * 1024 * 1024,
    env: opts?.env ?? process.env,
  });
  return { stdout: res.stdout, stderr: res.stderr };
};

export function sanitizeHerdrAgentName(prefix: string, rawId: string): string {
  const cleanPrefix = prefix.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const cleanId = rawId.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  const combined = `${cleanPrefix || "w"}-${cleanId || "task"}`;
  const startsWithLetter = /^[a-z]/.test(combined) ? combined : `w-${combined}`;
  return startsWithLetter.slice(0, 32);
}

function parseEnvelope(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  const result = parsed.result;
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return parsed;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class HerdrClient {
  readonly target: string;
  readonly binary: string;
  readonly timeoutMs: number;
  readonly runner: ExecRunner;

  constructor(options: HerdrClientOptions = {}, runner: ExecRunner = defaultRunner) {
    this.target = options.target?.trim() || "local";
    this.binary = options.binary ?? "herdr";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.runner = runner;
  }

  private buildArgs(subArgs: string[]): string[] {
    if (this.target && this.target !== "local") {
      return ["--machine", this.target, ...subArgs];
    }
    return subArgs;
  }

  private async runJson(
    subArgs: string[],
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    const { stdout } = await this.runner(this.binary, this.buildArgs(subArgs), {
      timeoutMs: timeoutMs ?? this.timeoutMs,
    });
    return parseEnvelope(stdout);
  }

  private async runRaw(subArgs: string[], timeoutMs?: number): Promise<string> {
    const { stdout } = await this.runner(this.binary, this.buildArgs(subArgs), {
      timeoutMs: timeoutMs ?? this.timeoutMs,
    });
    return stdout;
  }

  async listWorkspaces(): Promise<HerdrWorkspace[]> {
    const res = await this.runJson(["workspace", "list"]);
    return Array.isArray(res.workspaces) ? (res.workspaces as HerdrWorkspace[]) : [];
  }

  async createWorkspace(opts: {
    cwd: string;
    label: string;
    env?: Record<string, string>;
    focus?: boolean;
  }): Promise<SpawnedPaneResult> {
    const args = ["workspace", "create", "--cwd", opts.cwd, "--label", opts.label];
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      args.push("--env", `${k}=${v}`);
    }
    if (!opts.focus) {
      args.push("--no-focus");
    }
    const res = await this.runJson(args);
    const workspace = (res.workspace ?? {}) as Record<string, unknown>;
    const tab = (res.tab ?? {}) as Record<string, unknown>;
    const rootPane = (res.root_pane ?? res.pane ?? {}) as Record<string, unknown>;

    const workspaceId = String(workspace.workspace_id ?? "");
    const tabId = String(tab.tab_id ?? workspace.active_tab_id ?? "");
    const paneId = String(rootPane.pane_id ?? "");
    if (!workspaceId || !tabId || !paneId) {
      throw new Error(`herdr workspace create returned incomplete IDs: ${JSON.stringify(res)}`);
    }
    return { workspaceId, tabId, paneId };
  }

  async listTabs(workspaceId?: string): Promise<HerdrTab[]> {
    const args = ["tab", "list"];
    if (workspaceId) {
      args.push("--workspace", workspaceId);
    }
    const res = await this.runJson(args);
    return Array.isArray(res.tabs) ? (res.tabs as HerdrTab[]) : [];
  }

  async createTab(opts: {
    workspaceId: string;
    cwd: string;
    label: string;
    env?: Record<string, string>;
    focus?: boolean;
  }): Promise<SpawnedPaneResult> {
    const args = [
      "tab",
      "create",
      "--workspace",
      opts.workspaceId,
      "--cwd",
      opts.cwd,
      "--label",
      opts.label,
    ];
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      args.push("--env", `${k}=${v}`);
    }
    if (!opts.focus) {
      args.push("--no-focus");
    }
    const res = await this.runJson(args);
    const tab = (res.tab ?? {}) as Record<string, unknown>;
    const rootPane = (res.root_pane ?? res.pane ?? {}) as Record<string, unknown>;

    const tabId = String(tab.tab_id ?? "");
    const paneId = String(rootPane.pane_id ?? "");
    const workspaceId = String(tab.workspace_id ?? opts.workspaceId);
    if (!tabId || !paneId) {
      throw new Error(`herdr tab create returned incomplete IDs: ${JSON.stringify(res)}`);
    }
    return { workspaceId, tabId, paneId };
  }

  async findOrCreateProjectTab(opts: {
    workspaceLabel: string;
    cwd: string;
    tabLabel: string;
    env?: Record<string, string>;
  }): Promise<SpawnedPaneResult & { createdWorkspace: boolean }> {
    const workspaces = await this.listWorkspaces();
    const existing = workspaces.find((ws) => ws.label === opts.workspaceLabel);
    if (existing) {
      const tab = await this.createTab({
        workspaceId: existing.workspace_id,
        cwd: opts.cwd,
        label: opts.tabLabel,
        env: opts.env,
        focus: false,
      });
      return { ...tab, createdWorkspace: false };
    }

    const ws = await this.createWorkspace({
      cwd: opts.cwd,
      label: opts.workspaceLabel,
      env: opts.env,
      focus: false,
    });
    await this.renameTab(ws.tabId, opts.tabLabel);
    return { ...ws, createdWorkspace: true };
  }

  async createWorktree(opts: {
    cwd: string;
    branch: string;
    base?: string;
    label: string;
    env?: Record<string, string>;
  }): Promise<SpawnedPaneResult> {
    const args = [
      "worktree",
      "create",
      "--cwd",
      opts.cwd,
      "--branch",
      opts.branch,
      "--label",
      opts.label,
      "--no-focus",
    ];
    if (opts.base) {
      args.push("--base", opts.base);
    }
    const res = await this.runJson(args);
    const workspace = (res.workspace ?? {}) as Record<string, unknown>;
    const tab = (res.tab ?? {}) as Record<string, unknown>;
    const rootPane = (res.root_pane ?? res.pane ?? {}) as Record<string, unknown>;

    const workspaceId = String(workspace.workspace_id ?? "");
    const tabId = String(tab.tab_id ?? workspace.active_tab_id ?? "");
    const paneId = String(rootPane.pane_id ?? "");
    if (!workspaceId || !tabId || !paneId) {
      throw new Error(`herdr worktree create returned incomplete IDs: ${JSON.stringify(res)}`);
    }

    // `herdr worktree create` does not accept --env, so export env vars in the shell pane
    const envEntries = Object.entries(opts.env ?? {});
    if (envEntries.length > 0) {
      const exportCmd = `export ${envEntries
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(" ")}`;
      await this.paneRun(paneId, exportCmd);
    }

    return { workspaceId, tabId, paneId };
  }

  async removeWorktree(workspaceId: string): Promise<void> {
    await this.runJson(["worktree", "remove", "--workspace", workspaceId]);
  }

  async renameTab(tabId: string, label: string): Promise<void> {
    await this.runJson(["tab", "rename", tabId, label]);
  }

  async closeTab(tabId: string): Promise<void> {
    await this.runJson(["tab", "close", tabId]);
  }

  async paneRun(paneId: string, command: string): Promise<void> {
    await this.runJson(["pane", "run", paneId, command]);
  }

  async paneRead(
    paneId: string,
    opts?: {
      source?: "visible" | "recent" | "recent-unwrapped" | "detection";
      lines?: number;
    },
  ): Promise<string> {
    const args = [
      "pane",
      "read",
      paneId,
      "--source",
      opts?.source ?? "recent-unwrapped",
      "--lines",
      String(opts?.lines ?? 60),
      "--raw",
    ];
    return this.runRaw(args);
  }

  async listAgents(): Promise<HerdrAgent[]> {
    const res = await this.runJson(["agent", "list"]);
    return Array.isArray(res.agents) ? (res.agents as HerdrAgent[]) : [];
  }

  async getAgent(target: string): Promise<HerdrAgent | null> {
    try {
      const res = await this.runJson(["agent", "get", target]);
      const agent = (res.agent ?? res) as Record<string, unknown>;
      if (typeof agent.pane_id === "string" || typeof agent.agent_status === "string") {
        return {
          agent: typeof agent.agent === "string" ? agent.agent : undefined,
          agent_status: (typeof agent.agent_status === "string"
            ? agent.agent_status
            : "unknown") as HerdrAgentStatus,
          pane_id: String(agent.pane_id ?? ""),
          tab_id: typeof agent.tab_id === "string" ? agent.tab_id : undefined,
          workspace_id: typeof agent.workspace_id === "string" ? agent.workspace_id : undefined,
          cwd: typeof agent.cwd === "string" ? agent.cwd : undefined,
          foreground_cwd:
            typeof agent.foreground_cwd === "string" ? agent.foreground_cwd : undefined,
          terminal_title:
            typeof agent.terminal_title === "string" ? agent.terminal_title : undefined,
          name: typeof agent.name === "string" ? agent.name : undefined,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async startAgent(opts: {
    name: string;
    kind: string;
    paneId: string;
    args?: string[];
    timeoutMs?: number;
  }): Promise<{ started: boolean; blockedOnStartup: boolean; errorDetail?: string }> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const args = [
      "agent",
      "start",
      opts.name,
      "--kind",
      opts.kind,
      "--pane",
      opts.paneId,
      "--timeout",
      String(timeoutMs),
    ];
    if (opts.args && opts.args.length > 0) {
      args.push("--", ...opts.args);
    }

    try {
      await this.runJson(args, timeoutMs + 15_000);
      return { started: true, blockedOnStartup: false };
    } catch (err) {
      const msg =
        err instanceof Error
          ? `${err.message} ${(err as { stderr?: string }).stderr ?? ""}`
          : String(err);
      if (msg.includes("agent_not_ready")) {
        // Per Herdr docs: agent was launched and name registered, but hit a prompt/blocked UI on startup
        return { started: true, blockedOnStartup: true, errorDetail: msg.trim() };
      }
      throw err;
    }
  }

  async promptAgent(
    target: string,
    text: string,
    opts?: { wait?: boolean; timeoutMs?: number },
  ): Promise<void> {
    const args = ["agent", "prompt", target, text];
    if (opts?.wait) {
      args.push("--wait");
    }
    if (opts?.timeoutMs) {
      args.push("--timeout", String(opts.timeoutMs));
    }
    await this.runJson(args, (opts?.timeoutMs ?? 30_000) + 10_000);
  }
}
