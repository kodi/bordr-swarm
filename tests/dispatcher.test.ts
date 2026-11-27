import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SwarmDispatcher } from "../src/dispatcher.ts";
import {
  BOARD_PROFILE_REGEX,
  BoardClient,
  extractJsonPayload,
  MAX_BOARD_PROFILE_LENGTH,
  normalizeBoardTask,
  type BoardTask,
  type ExecRunner,
} from "../src/lib/board.ts";
import {
  buildAgentCliArgs,
  loadProjectsConfig,
  loadProjectsConfigOptional,
  loadSwarmConfig,
  parseProjectsConfig,
  parseSwarmConfig,
  resolveCurrentMachineName,
  resolveWorkerRuntime,
  validateSwarmAndProjects,
  type ProjectsConfig,
  type SwarmConfig,
} from "../src/lib/config.ts";
import { HerdrClient, sanitizeHerdrAgentName } from "../src/lib/herdr.ts";
import type { GitChangeDetector } from "../src/lib/review.ts";
import { SwarmConfigSchema } from "../src/lib/schemas.ts";
import { z } from "zod";
import {
  extractProjectSlug,
  formatTabLabel,
  renderWorkerPrompt,
  selectEligibleTasks,
} from "../src/lib/routing.ts";

function createTestSwarmConfig(): SwarmConfig {
  return {
    board: {
      scope: "test-team",
      boardName: "",
      inboxChannel: "inbox",
      projectChannelPrefix: "projects/",
      registryChannel: "swarm/registry",
      humanHandle: "@owner",
      viewerPort: 4747,
      viewerUrl: "http://main-machine:4748",
      leaseDuration: "15m",
      leaseRenewIntervalSeconds: 300,
    },
    lead: {
      machine: "main-machine",
      boardProfile: "lead",
      model: "opus",
      effort: "high",
      permissionMode: "auto",
      workspaceDir: "~/swarm-hq",
      pollIntervalSeconds: 10,
      maxConcurrentSessions: 1,
      idleCloseSeconds: 15,
      maxParkedTabs: 4,
    },
    workerDefaults: {
      defaultAgent: "claude",
      agents: {
        claude: {
          kind: "claude",
          model: "opus",
          effort: "medium",
          permissionMode: "auto",
          extraArgs: [],
        },
        agy: {
          kind: "agy",
          model: "",
          effort: "medium",
          permissionMode: "auto",
          extraArgs: [],
        },
      },
      reviewer: {
        enabled: false,
        agent: "codex",
        model: "",
        maxRounds: 2,
        skipIfNoDiff: true,
      },
      useWorktree: false,
      closeTabOnComplete: true,
      keepTabOnBlockedOrFailed: true,
      maxParkedTabs: 4,
      pollIntervalSeconds: 15,
      idleTimeoutSeconds: 30,
      claimWaitSeconds: 30,
    },
    machines: {
      "main-machine": {
        role: "main",
        os: "linux",
        hostname: "main-machine",
        allowedHosts: ["main-machine", "main-machine:4748"],
        herdrTarget: "local",
        maxWorkers: 0,
        labels: ["machine=main-machine", "os=linux"],
      },
      "worker-machine": {
        role: "worker",
        os: "macos",
        hostname: "worker-machine",
        allowedHosts: [],
        herdrTarget: "local",
        maxWorkers: 2,
        labels: ["machine=worker-machine", "os=macos"],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Shared fakes for the SwarmDispatcher mocked lifecycle suite
// ---------------------------------------------------------------------------

interface FakeBoardTask {
  id: string;
  channel: string;
  state: BoardTask["state"];
  text: string;
  labels: Record<string, string>;
  assignee?: string;
  replies: { id: string; text: string; profile: string }[];
}

/** States `vercel board tasks --state open` returns (verified on a live board, 2026-11-27). */
const FAKE_OPEN_STATES = new Set(["waiting", "ready", "claimed", "blocked"]);

function fakeAsProfile(args: string[]): string {
  const idx = args.indexOf("--as");
  return idx >= 0 ? (args[idx + 1] ?? "") : "";
}

function fakeBoardOk(body: unknown = { ok: true }): { stdout: string; stderr: string } {
  return { stdout: JSON.stringify(body), stderr: "" };
}

function fakeClaimLost(id: string): Error {
  return Object.assign(new Error(`claim_lost on ${id}`), {
    stdout: JSON.stringify({ status: "error", reason: "claim_lost" }),
    stderr: "",
  });
}

function fakeHerdrOk(result: unknown = { ok: true }): { stdout: string; stderr: string } {
  return { stdout: JSON.stringify({ result }), stderr: "" };
}

function createFakeBoard(initial: Omit<FakeBoardTask, "replies">[]) {
  const tasks = new Map<string, FakeBoardTask>();
  for (const t of initial) tasks.set(t.id, { ...t, replies: [] });
  const calls: string[][] = [];
  let replySeq = 0;

  const toWire = (t: FakeBoardTask) => ({
    message: {
      id: t.id,
      channel: t.channel,
      text: t.text,
      labels: t.labels,
      task: {
        state: t.state,
        claim: t.assignee ? { actor: `vercel:user:u1+${t.assignee}`, until: "later" } : null,
      },
    },
    replies: t.replies.length,
  });
  const runner: ExecRunner = async (_cmd, args) => {
    calls.push(args);
    const [, group, sub, id] = args;
    const profile = fakeAsProfile(args);
    if (group === "tasks" && sub?.endsWith("/")) {
      const stateIdx = args.indexOf("--state");
      const state = stateIdx >= 0 ? args[stateIdx + 1] : "open";
      const list = [...tasks.values()].filter((t) =>
        state === "all"
          ? true
          : state === "open"
            ? FAKE_OPEN_STATES.has(t.state)
            : t.state === state,
      );
      return fakeBoardOk({ tasks: list.map(toWire), cursor: null });
    }
    if (group === "tasks" && id) {
      const t = tasks.get(id);
      if (!t) throw new Error(`no task ${id}`);
      switch (sub) {
        case "claim":
          if (t.state !== "ready") throw fakeClaimLost(id);
          t.state = "claimed";
          t.assignee = profile;
          return fakeBoardOk(toWire(t));
        case "renew":
          if (t.state !== "claimed" || t.assignee !== profile) throw fakeClaimLost(id);
          return fakeBoardOk();
        case "release":
          t.state = "ready";
          t.assignee = undefined;
          return fakeBoardOk();
        case "complete":
          t.state = "completed";
          t.assignee = undefined;
          return fakeBoardOk();
        case "fail":
          t.state = "failed";
          t.assignee = undefined;
          return fakeBoardOk();
        case "block":
          t.state = "blocked";
          t.assignee = undefined;
          return fakeBoardOk();
        default:
          return fakeBoardOk();
      }
    }
    if (group === "read" && sub) {
      const t = tasks.get(sub);
      if (!t) return fakeBoardOk({ threads: [], cursor: null });
      return fakeBoardOk({
        ...toWire(t),
        replies: t.replies.map((r) => ({ id: r.id, text: r.text, by: { profile: r.profile } })),
        cursor: null,
      });
    }
    if (group === "reply" && sub && id !== undefined) {
      const t = tasks.get(sub);
      if (t) t.replies.push({ id: `r${++replySeq}`, text: id, profile });
      return fakeBoardOk();
    }
    return fakeBoardOk();
  };

  return {
    tasks,
    calls,
    runner,
    /** Simulate another actor (implementer/reviewer agent) posting on a thread. */
    postReply(taskId: string, text: string, profile: string): void {
      tasks.get(taskId)?.replies.push({ id: `r${++replySeq}`, text, profile });
    },
    callsFor(sub: string, taskId?: string): string[][] {
      return calls.filter((c) => c[1] === "tasks" && c[2] === sub && (!taskId || c[3] === taskId));
    },
  };
}

interface FakeAgent {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  agent_status: string;
  name: string;
}

function createFakeHerdr(workspaces: { workspace_id: string; label: string }[]) {
  let nextTabSeq = 1;
  const openTabs = new Map<string, { tab_id: string; workspace_id: string; label: string }>();
  const paneToTab = new Map<string, { tab_id: string; workspace_id: string }>();
  const liveAgents = new Map<string, FakeAgent>();
  const calls: string[][] = [];

  const runner: ExecRunner = async (_cmd, args) => {
    calls.push(args);
    const [group, sub] = args;
    if (group === "workspace" && sub === "list") return fakeHerdrOk({ workspaces });
    if (group === "tab" && sub === "create") {
      const wsId = args[args.indexOf("--workspace") + 1]!;
      const label = args[args.indexOf("--label") + 1]!;
      const seq = nextTabSeq++;
      const tabId = `${wsId}:t${seq}`;
      const paneId = `${wsId}:p${seq}`;
      openTabs.set(tabId, { tab_id: tabId, workspace_id: wsId, label });
      paneToTab.set(paneId, { tab_id: tabId, workspace_id: wsId });
      return fakeHerdrOk({
        tab: { tab_id: tabId, workspace_id: wsId },
        root_pane: { pane_id: paneId },
      });
    }
    if (group === "tab" && sub === "list") return fakeHerdrOk({ tabs: [...openTabs.values()] });
    if (group === "tab" && sub === "close") {
      const tabId = args[2]!;
      openTabs.delete(tabId);
      for (const [paneId, agent] of liveAgents) {
        if (agent.tab_id === tabId) liveAgents.delete(paneId);
      }
      return fakeHerdrOk();
    }
    if (group === "tab" && sub === "rename") {
      const tab = openTabs.get(args[2]!);
      if (tab) tab.label = args[3]!;
      return fakeHerdrOk();
    }
    if (group === "agent" && sub === "start") {
      const name = args[2]!;
      const paneId = args[args.indexOf("--pane") + 1]!;
      const loc = paneToTab.get(paneId) ?? { tab_id: "", workspace_id: "" };
      liveAgents.set(paneId, { pane_id: paneId, ...loc, agent_status: "working", name });
      return fakeHerdrOk();
    }
    if (group === "agent" && sub === "list")
      return fakeHerdrOk({ agents: [...liveAgents.values()] });
    return fakeHerdrOk();
  };

  return {
    openTabs,
    liveAgents,
    calls,
    runner,
    agentByName(name: string): FakeAgent | undefined {
      return [...liveAgents.values()].find((a) => a.name === name);
    },
    setAgentStatus(name: string, status: string): void {
      const agent = [...liveAgents.values()].find((a) => a.name === name);
      if (agent) agent.agent_status = status;
    },
  };
}

function createLifecycleFixture(opts?: { reviewer?: boolean; statePath?: string }): {
  tmpBase: string;
  swarm: SwarmConfig;
  projects: ProjectsConfig;
  cleanup: () => void;
} {
  const tmpBase = mkdtempSync(join(tmpdir(), "swarm-fixture-"));
  const repoA = join(tmpBase, "repo-a");
  const repoB = join(tmpBase, "repo-b");
  mkdirSync(repoA);
  mkdirSync(repoB);
  const swarm = createTestSwarmConfig();
  if (opts?.reviewer) {
    swarm.workerDefaults.reviewer = {
      enabled: true,
      agent: "claude",
      model: "",
      maxRounds: 2,
      skipIfNoDiff: false,
    };
  }
  const projects: ProjectsConfig = {
    projects: {
      "repo-a": {
        defaultMachine: "worker-machine",
        baseBranch: "main",
        useWorktree: false,
        paths: { "worker-machine": repoA },
      },
      "repo-b": {
        defaultMachine: "worker-machine",
        baseBranch: "main",
        useWorktree: false,
        paths: { "worker-machine": repoB },
      },
    },
  };
  return {
    tmpBase,
    swarm,
    projects,
    cleanup: () => rmSync(tmpBase, { recursive: true, force: true }),
  };
}

const fixtureGitDetector: GitChangeDetector = {
  captureHeadSha: () => "abc1234",
  detectChanges: () => ({
    hasChanges: true,
    currentHeadSha: "def5678",
    dirtyFiles: 0,
    detail: "1 commit ahead",
  }),
};

function makeFixtureDispatcher(
  fx: { tmpBase: string; swarm: SwarmConfig; projects: ProjectsConfig },
  board: { runner: ExecRunner },
  herdr: { runner: ExecRunner },
  opts?: { statePath?: string; swarm?: SwarmConfig },
): SwarmDispatcher {
  return new SwarmDispatcher({
    repoRoot: fx.tmpBase,
    swarm: opts?.swarm ?? fx.swarm,
    projects: fx.projects,
    machineName: "worker-machine",
    board: new BoardClient({ scope: "test-team" }, board.runner),
    herdr: new HerdrClient({ target: "local" }, herdr.runner),
    promptTemplate: "Work on {{TASK_ID}}",
    reviewerPromptTemplate: "Review {{TASK_ID}}",
    gitDetector: fixtureGitDetector,
    availableAgentKinds: new Set(["claude"]),
    dryRun: false,
    statePath: opts?.statePath,
  });
}

/** Same config, but every tick is "due" for a lease renewal. */
function withEagerLeaseRenewal(swarm: SwarmConfig): SwarmConfig {
  return { ...swarm, board: { ...swarm.board, leaseRenewIntervalSeconds: 0 } };
}

const FIXTURE_WORKSPACES = [
  { workspace_id: "w1", label: "repo-a" },
  { workspace_id: "w2", label: "repo-b" },
];

describe("config & worker agent selection", () => {
  it("defaults to claude opus medium auto when no agent label is set", () => {
    const swarm = createTestSwarmConfig();
    const rt = resolveWorkerRuntime(swarm.workerDefaults, {});
    assert.equal(rt.profileName, "claude");
    assert.equal(rt.kind, "claude");
    assert.deepEqual(rt.cliArgs, [
      "--model",
      "opus",
      "--effort",
      "medium",
      "--permission-mode",
      "auto",
    ]);
  });

  it("selects agy with default model (omitted --model) when label agent=agy is set", () => {
    const swarm = createTestSwarmConfig();
    const rt = resolveWorkerRuntime(swarm.workerDefaults, { agent: "agy" });
    assert.equal(rt.profileName, "agy");
    assert.equal(rt.kind, "agy");
    assert.equal(rt.model, "");
    assert.deepEqual(rt.cliArgs, ["--effort", "medium", "--mode", "auto"]);
  });

  it("applies per-task model and effort overrides for agy and maps permissionMode", () => {
    const swarm = createTestSwarmConfig();
    const rt = resolveWorkerRuntime(swarm.workerDefaults, {
      agent: "agy",
      model: "gemini-pro",
      effort: "high",
    });
    assert.deepEqual(rt.cliArgs, ["--model", "gemini-pro", "--effort", "high", "--mode", "auto"]);

    const bypassArgs = buildAgentCliArgs({
      kind: "agy",
      model: "",
      effort: "medium",
      permissionMode: "bypassPermissions",
      extraArgs: [],
    });
    assert.deepEqual(bypassArgs, ["--effort", "medium", "--dangerously-skip-permissions"]);
  });

  it("selects codex with reasoning effort, network-enabled workspace-write, and --approve-for-me", () => {
    const swarm = createTestSwarmConfig();
    const rt = resolveWorkerRuntime(swarm.workerDefaults, { agent: "codex" });
    assert.equal(rt.profileName, "codex");
    assert.equal(rt.kind, "codex");
    assert.equal(rt.model, "");
    assert.deepEqual(rt.cliArgs, [
      "-c",
      'model_reasoning_effort="medium"',
      "-c",
      "sandbox_workspace_write.network_access=true",
      "--approve-for-me",
    ]);

    const overrideRt = resolveWorkerRuntime(swarm.workerDefaults, {
      agent: "codex",
      model: "gpt-5.4",
      effort: "high",
    });
    assert.deepEqual(overrideRt.cliArgs, [
      "--model",
      "gpt-5.4",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      "sandbox_workspace_write.network_access=true",
      "--approve-for-me",
    ]);

    const bypassArgs = buildAgentCliArgs({
      kind: "codex",
      model: "",
      effort: "low",
      permissionMode: "bypassPermissions",
      extraArgs: [],
    });
    assert.deepEqual(bypassArgs, [
      "-c",
      'model_reasoning_effort="low"',
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("selects pi with --thinking and --approve (and supports provider/model and plan mode)", () => {
    const swarm = createTestSwarmConfig();
    const rt = resolveWorkerRuntime(swarm.workerDefaults, { agent: "pi" });
    assert.equal(rt.profileName, "pi");
    assert.equal(rt.kind, "pi");
    assert.equal(rt.model, "");
    assert.deepEqual(rt.cliArgs, ["--thinking", "medium", "--approve"]);

    const overrideRt = resolveWorkerRuntime(swarm.workerDefaults, {
      agent: "pi",
      model: "openai-codex/gpt-5.4",
      effort: "xhigh",
    });
    assert.deepEqual(overrideRt.cliArgs, [
      "--model",
      "openai-codex/gpt-5.4",
      "--thinking",
      "xhigh",
      "--approve",
    ]);

    const planArgs = buildAgentCliArgs({
      kind: "pi",
      model: "",
      effort: "medium",
      permissionMode: "plan",
      extraArgs: [],
    });
    assert.deepEqual(planArgs, [
      "--thinking",
      "medium",
      "--tools",
      "read,grep,find,ls",
      "--approve",
    ]);
  });

  it("resolves explicit or role-based machine names cleanly", () => {
    const swarm = createTestSwarmConfig();
    assert.equal(resolveCurrentMachineName(swarm, "worker-machine"), "worker-machine");
    assert.equal(resolveCurrentMachineName(swarm, undefined, "main"), "main-machine");
    assert.equal(resolveCurrentMachineName(swarm, undefined, "worker"), "worker-machine");
  });

  it("validates example configs cleanly and rejects invalid Zod inputs early", () => {
    const swarm = loadSwarmConfig(process.cwd(), "config/swarm.example.json");
    const projects = loadProjectsConfig(process.cwd(), "config/projects.example.json");
    assert.deepEqual(validateSwarmAndProjects(swarm, projects), []);

    // Reject unknown typo key (.strict())
    assert.throws(
      () =>
        parseSwarmConfig({
          ...swarm,
          extraTypoKey: true,
        }),
      /Unrecognized key/i,
    );

    // Reject invalid leaseRenewIntervalSeconds >= leaseDuration
    assert.throws(
      () =>
        parseSwarmConfig({
          ...swarm,
          board: {
            ...swarm.board,
            leaseDuration: "5m",
            leaseRenewIntervalSeconds: 300,
          },
        }),
      /must be less than leaseDuration/i,
    );

    // Reject lead.machine referencing nonexistent machine
    assert.throws(
      () =>
        parseSwarmConfig({
          ...swarm,
          lead: {
            ...swarm.lead,
            machine: "ghost-machine",
          },
        }),
      /does not exist in machines/i,
    );

    // Reject project with empty paths
    assert.throws(
      () =>
        parseProjectsConfig({
          projects: {
            "empty-repo": {
              defaultMachine: "worker-machine",
              baseBranch: "main",
              paths: {},
            },
          },
        }),
      /at least one machine checkout path/i,
    );

    // Verify JSON Schema export preserves rich agent-facing descriptions
    const jsonSchema = z.toJSONSchema(SwarmConfigSchema, { io: "input" }) as {
      description?: string;
      properties?: Record<string, { description?: string }>;
    };
    assert.ok(jsonSchema.description && jsonSchema.description.length > 20);
    assert.ok(jsonSchema.properties?.workerDefaults?.description?.includes("agent"));
  });

  it("supports minimal per-host swarm.json with defaults and optional projects.json", () => {
    // Minimal worker-only host (no board, lead, workerDefaults, os, or maxWorkers required)
    const workerOnly = parseSwarmConfig({
      machines: {
        "worker-box": { role: "worker" },
      },
    });
    assert.equal(workerOnly.lead.machine, "");
    assert.equal(workerOnly.machines["worker-box"]?.role, "worker");
    assert.equal(workerOnly.machines["worker-box"]?.maxWorkers, 2);
    assert.equal(workerOnly.workerDefaults.defaultAgent, "claude");
    assert.equal(workerOnly.board.viewerUrl, "http://127.0.0.1:4747");

    // Minimal single-machine ("both") host auto-infers lead.machine
    const singleHost = parseSwarmConfig({
      board: { humanHandle: "@dev" },
      machines: {
        "dev-laptop": { role: "both", os: "macos" },
      },
    });
    assert.equal(singleHost.lead.machine, "dev-laptop");
    assert.equal(singleHost.board.humanHandle, "@dev");
    assert.equal(singleHost.machines["dev-laptop"]?.maxWorkers, 2);
    assert.ok(singleHost.machines["dev-laptop"]?.labels.includes("machine=dev-laptop"));
    assert.ok(singleHost.machines["dev-laptop"]?.labels.includes("os=macos"));

    // Missing projects.json loads cleanly as empty registry via loadProjectsConfigOptional
    const tempDir = mkdtempSync(join(tmpdir(), "bordr-opt-projects-"));
    try {
      const emptyProjects = loadProjectsConfigOptional(tempDir);
      assert.deepEqual(emptyProjects, { projects: {} });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

const channelNotFoundRunner: ExecRunner = async () => {
  const err = new Error("Command failed") as Error & { stdout?: string; stderr?: string };
  err.stdout = JSON.stringify({ status: "error", reason: "channel_not_found" });
  throw err;
};

describe("board & herdr helpers", () => {
  it("extracts JSON even if CLI banner precedes payload", () => {
    const parsed = extractJsonPayload('Vercel CLI 66.6.0\n{"tasks":[],"cursor":"0"}');
    assert.deepEqual(parsed, { tasks: [], cursor: "0" });
  });

  it("treats channel_not_found on empty projects/ prefix as empty task list", async () => {
    const board = new BoardClient({}, channelNotFoundRunner);
    const tasks = await board.listTasks("projects/", { state: "all" });
    assert.deepEqual(tasks, []);
  });

  it("paginates listTasks with --after until a short page, ignoring a non-null cursor on it", async () => {
    const pages: Record<string, { tasks: unknown[]; cursor: string | null }> = {
      first: { tasks: [{ id: "t1" }, { id: "t2" }], cursor: "c1" },
      c1: { tasks: [{ id: "t3" }, { id: "t4" }], cursor: "c2" },
      // Short final page still carries a cursor, as observed on a live board
      c2: { tasks: [{ id: "t5" }], cursor: "c3" },
    };
    const calls: string[][] = [];
    const runner: ExecRunner = async (_cmd, args) => {
      calls.push(args);
      const afterIdx = args.indexOf("--after");
      const key = afterIdx >= 0 ? args[afterIdx + 1]! : "first";
      const page = pages[key];
      if (!page) throw new Error(`unexpected page ${key}`);
      return { stdout: JSON.stringify(page), stderr: "" };
    };
    const board = new BoardClient({}, runner);
    const tasks = await board.listTasks("projects/", { state: "open", limit: 2 });
    assert.deepEqual(
      tasks.map((t) => t.id),
      ["t1", "t2", "t3", "t4", "t5"],
    );
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c[c.indexOf("--state") + 1] === "open"));
    assert.ok(calls.every((c) => c[c.indexOf("--limit") + 1] === "2"));
    assert.equal(calls[0]!.indexOf("--after"), -1);
    assert.equal(calls[2]![calls[2]!.indexOf("--after") + 1], "c2");
  });

  it("stops listTasks on an empty page", async () => {
    let n = 0;
    const runner: ExecRunner = async () => {
      n += 1;
      const body =
        n === 1 ? { tasks: [{ id: "a" }, { id: "b" }], cursor: "c1" } : { tasks: [], cursor: "c2" };
      return { stdout: JSON.stringify(body), stderr: "" };
    };
    const tasks = await new BoardClient({}, runner).listTasks("projects/", { limit: 2 });
    assert.deepEqual(
      tasks.map((t) => t.id),
      ["a", "b"],
    );
    assert.equal(n, 2);
  });

  it("honors the listTasks page cap and warns when it is hit", async () => {
    let n = 0;
    const runner: ExecRunner = async () => {
      n += 1;
      return {
        stdout: JSON.stringify({ tasks: [{ id: `x${n}` }], cursor: `c${n}` }),
        stderr: "",
      };
    };
    const warnings: string[] = [];
    const board = new BoardClient({ onWarn: (m) => warnings.push(m) }, runner);
    const tasks = await board.listTasks("projects/", { limit: 1, maxPages: 3 });
    assert.equal(n, 3);
    assert.equal(tasks.length, 3);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /stopped after 3 page/);
  });

  it("looks up a single task via read --json and normalizes the claim actor to a profile", async () => {
    const runner: ExecRunner = async (_cmd, args) => {
      assert.deepEqual(args.slice(0, 3), ["board", "read", "msg_1"]);
      return {
        stdout: JSON.stringify({
          message: {
            id: "msg_1",
            channel: "projects/example-app",
            text: "Task",
            task: {
              state: "claimed",
              claim: { actor: "vercel:user:abc123+worker-worker-machine-msg1", until: "x" },
            },
          },
          replies: [{ id: "r1" }, { id: "r2" }],
          cursor: null,
        }),
        stderr: "",
      };
    };
    const task = await new BoardClient({}, runner).getTask("msg_1");
    assert.ok(task);
    assert.equal(task.state, "claimed");
    assert.equal(task.assignee, "worker-worker-machine-msg1");
    assert.equal(task.replyCount, 2);
  });

  it("normalizes task objects with string-array or record labels", () => {
    const t = normalizeBoardTask({
      id: 812,
      channel: "#projects/example-app",
      state: "ready",
      text: "Fix dashboard",
      labels: ["machine=worker-machine", "agent=agy"],
    });
    assert.ok(t);
    assert.equal(t.id, "812");
    assert.equal(t.channel, "projects/example-app");
    assert.equal(t.labels.machine, "worker-machine");
    assert.equal(t.labels.agent, "agy");
  });

  it("normalizes Vercel Board 66.6.0 nested { message: { ..., task: { state } } } task shape", () => {
    const t = normalizeBoardTask({
      message: {
        id: "msg_8c164000-a378-4377-80ca-a2965566d237_1",
        channel: "projects/example-app",
        text: "Smoke test task",
        labels: {
          machine: "worker-machine",
          "board.task": "ready",
        },
        task: {
          state: "ready",
          claim: null,
        },
      },
      replies: 0,
      last: null,
    });
    assert.ok(t);
    assert.equal(t.id, "msg_8c164000-a378-4377-80ca-a2965566d237_1");
    assert.equal(t.channel, "projects/example-app");
    assert.equal(t.state, "ready");
    assert.equal(t.labels.machine, "worker-machine");
  });

  it("sanitizes Herdr agent names to match [a-z][a-z0-9_-]{0,31}", () => {
    const name = sanitizeHerdrAgentName("w", "Task #812/foo.bar+extra-very-long-identifier-12345");
    assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
  });

  it("extracts project slug and renders prompt templates", () => {
    assert.equal(extractProjectSlug("projects/example-app", "projects/"), "example-app");
    assert.equal(extractProjectSlug("inbox", "projects/"), null);
    assert.equal(formatTabLabel("812", "agy", "BLOCKED"), "[BLOCKED] task-812 (agy)");
    const rendered = renderWorkerPrompt(
      "Task {{TASK_ID}} on {{PROJECT}} ({{AGENT_PROFILE}}) escalate to {{HUMAN_HANDLE}}",
      {
        taskId: "812",
        channel: "projects/example-app",
        project: "example-app",
        boardProfile: "worker-worker-machine-812",
        branch: "task/812",
        agentProfile: "agy",
        humanHandle: "@owner",
      },
    );
    assert.equal(rendered, "Task 812 on example-app (agy) escalate to @owner");
  });
});

describe("routing & plain-tab collision guard", () => {
  it("filters by machine, installed agent binaries, and busy plain-tab projects", () => {
    const swarm = createTestSwarmConfig();
    const projects: ProjectsConfig = {
      projects: {
        "repo-a": {
          defaultMachine: "worker-machine",
          baseBranch: "main",
          useWorktree: false,
          paths: { "worker-machine": "/tmp/repo-a" },
        },
        "repo-b": {
          defaultMachine: "worker-machine",
          baseBranch: "main",
          useWorktree: false,
          paths: { "worker-machine": "/tmp/repo-b" },
        },
      },
    };

    const tasks: BoardTask[] = [
      { id: "1", channel: "projects/repo-a", state: "ready", text: "A", labels: {}, raw: {} },
      {
        id: "2",
        channel: "projects/repo-b",
        state: "ready",
        text: "B",
        labels: { agent: "agy" },
        raw: {},
      },
      {
        id: "3",
        channel: "projects/repo-b",
        state: "ready",
        text: "C",
        labels: { machine: "main-machine" },
        raw: {},
      },
    ];

    const { candidates, skips } = selectEligibleTasks({
      tasks,
      swarm,
      projects,
      machineName: "worker-machine",
      busyPlainTabProjects: new Set(["repo-a"]),
      alreadyTrackedTaskIds: new Set(),
      availableAgentKinds: new Set(["claude", "agy"]),
    });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.task.id, "2");
    assert.equal(candidates[0]?.runtime.kind, "agy");
    assert.equal(skips.length, 2);
  });
});

describe("SwarmDispatcher mocked lifecycle", () => {
  it("claims claude + agy tasks concurrently, guards duplicate plain-tab repo, cleans up completed, and parks blocked", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "swarm-test-"));
    const repoA = join(tmpBase, "repo-a");
    const repoB = join(tmpBase, "repo-b");
    mkdirSync(repoA);
    mkdirSync(repoB);

    try {
      const swarm = createTestSwarmConfig();
      const projects: ProjectsConfig = {
        projects: {
          "repo-a": {
            defaultMachine: "worker-machine",
            baseBranch: "main",
            useWorktree: false,
            paths: { "worker-machine": repoA },
          },
          "repo-b": {
            defaultMachine: "worker-machine",
            baseBranch: "main",
            useWorktree: false,
            paths: { "worker-machine": repoB },
          },
        },
      };

      const boardTasks: Record<string, BoardTask> = {
        "101": {
          id: "101",
          channel: "projects/repo-a",
          state: "ready",
          text: "First task on repo-a (default claude)",
          labels: {},
          raw: {},
        },
        "102": {
          id: "102",
          channel: "projects/repo-a",
          state: "ready",
          text: "Second task on repo-a (must wait for plain-tab lock)",
          labels: {},
          raw: {},
        },
        "103": {
          id: "103",
          channel: "projects/repo-b",
          state: "ready",
          text: "Task on repo-b using agy",
          labels: { agent: "agy" },
          raw: {},
        },
      };

      const boardRunner: ExecRunner = async (_cmd, args) => {
        if (args[1] === "tasks" && args[2] === "claim") {
          const id = args[3]!;
          const task = boardTasks[id]!;
          task.state = "claimed";
          return { stdout: JSON.stringify(task), stderr: "" };
        }
        if (args[1] === "tasks" && args[2] === "projects/") {
          return { stdout: JSON.stringify({ tasks: Object.values(boardTasks) }), stderr: "" };
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      };

      let nextTabSeq = 1;
      const openTabs = new Map<string, { tab_id: string; workspace_id: string; label: string }>();
      const liveAgents = new Map<string, { pane_id: string; agent_status: string; name: string }>();
      const herdrCalls: string[][] = [];

      const herdrRunner: ExecRunner = async (_cmd, args) => {
        herdrCalls.push(args);
        const [group, sub] = args;
        if (group === "workspace" && sub === "list") {
          return {
            stdout: JSON.stringify({
              result: {
                workspaces: [
                  { workspace_id: "w1", label: "repo-a" },
                  { workspace_id: "w2", label: "repo-b" },
                ],
              },
            }),
            stderr: "",
          };
        }
        if (group === "tab" && sub === "create") {
          const wsIdx = args.indexOf("--workspace");
          const labelIdx = args.indexOf("--label");
          const wsId = args[wsIdx + 1]!;
          const label = args[labelIdx + 1]!;
          const seq = nextTabSeq++;
          const tabId = `${wsId}:t${seq}`;
          const paneId = `${wsId}:p${seq}`;
          openTabs.set(tabId, { tab_id: tabId, workspace_id: wsId, label });
          return {
            stdout: JSON.stringify({
              result: {
                tab: { tab_id: tabId, workspace_id: wsId },
                root_pane: { pane_id: paneId },
              },
            }),
            stderr: "",
          };
        }
        if (group === "tab" && sub === "list") {
          return {
            stdout: JSON.stringify({ result: { tabs: [...openTabs.values()] } }),
            stderr: "",
          };
        }
        if (group === "tab" && sub === "close") {
          openTabs.delete(args[2]!);
          return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
        }
        if (group === "tab" && sub === "rename") {
          const tab = openTabs.get(args[2]!);
          if (tab) tab.label = args[3]!;
          return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
        }
        if (group === "agent" && sub === "start") {
          const name = args[2]!;
          const paneIdx = args.indexOf("--pane");
          const paneId = args[paneIdx + 1]!;
          liveAgents.set(paneId, { pane_id: paneId, agent_status: "working", name });
          return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
        }
        if (group === "agent" && sub === "list") {
          return {
            stdout: JSON.stringify({ result: { agents: [...liveAgents.values()] } }),
            stderr: "",
          };
        }
        return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
      };

      const dispatcher = new SwarmDispatcher({
        repoRoot: tmpBase,
        swarm,
        projects,
        machineName: "worker-machine",
        board: new BoardClient({ scope: "test-team" }, boardRunner),
        herdr: new HerdrClient({ target: "local" }, herdrRunner),
        promptTemplate: "Work on {{TASK_ID}} ({{AGENT_PROFILE}}) {{HUMAN_HANDLE}}",
        availableAgentKinds: new Set(["claude", "agy"]),
        dryRun: false,
      });

      // Tick 1: claims #101 (repo-a, claude) and #103 (repo-b, agy), skips #102 (repo-a busy)
      await dispatcher.tick();
      assert.equal(dispatcher.activeWorkers.size, 2);
      assert.ok(dispatcher.activeWorkers.has("101"));
      assert.ok(dispatcher.activeWorkers.has("103"));
      assert.ok(!dispatcher.activeWorkers.has("102"));

      const startCalls = herdrCalls.filter((c) => c[0] === "agent" && c[1] === "start");
      assert.equal(startCalls.length, 2);
      assert.deepEqual(startCalls[0], [
        "agent",
        "start",
        "w-101",
        "--kind",
        "claude",
        "--pane",
        "w1:p1",
        "--timeout",
        "60000",
        "--",
        "--model",
        "opus",
        "--effort",
        "medium",
        "--permission-mode",
        "auto",
      ]);
      assert.deepEqual(startCalls[1], [
        "agent",
        "start",
        "w-103",
        "--kind",
        "agy",
        "--pane",
        "w2:p2",
        "--timeout",
        "60000",
        "--",
        "--effort",
        "medium",
        "--mode",
        "auto",
      ]);

      // Tick 2: #101 completes, #103 blocks -> #101 tab closes & #102 gets claimed; #103 parks as [BLOCKED]
      boardTasks["101"]!.state = "completed";
      boardTasks["103"]!.state = "blocked";
      await dispatcher.tick();

      assert.ok(!openTabs.has("w1:t1"), "completed tab should be closed");
      assert.ok(openTabs.has("w2:t2"), "blocked tab should stay open");
      assert.equal(openTabs.get("w2:t2")?.label, "[BLOCKED] task-103 (agy)");
      assert.ok(dispatcher.parkedTabs.has("103"));
      assert.ok(dispatcher.activeWorkers.has("102"), "queued task on repo-a should now be claimed");

      // Tick 3: user manually closes blocked tab in Sheprd -> parkedTabs prunes it
      openTabs.delete("w2:t2");
      await dispatcher.tick();
      assert.equal(dispatcher.parkedTabs.size, 0);
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("auto-closes a parked [BLOCKED] tab when unblocked and completed, and unparks when resumed as claimed", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "swarm-unblock-test-"));
    const repoA = join(tmpBase, "repo-a");
    const repoB = join(tmpBase, "repo-b");
    mkdirSync(repoA);
    mkdirSync(repoB);

    try {
      const swarm = createTestSwarmConfig();
      const projects: ProjectsConfig = {
        projects: {
          "repo-a": {
            defaultMachine: "worker-machine",
            baseBranch: "main",
            useWorktree: false,
            paths: { "worker-machine": repoA },
          },
          "repo-b": {
            defaultMachine: "worker-machine",
            baseBranch: "main",
            useWorktree: false,
            paths: { "worker-machine": repoB },
          },
        },
      };

      const boardTasks: Record<string, BoardTask> = {
        "201": {
          id: "201",
          channel: "projects/repo-a",
          state: "ready",
          text: "Task that blocks then completes directly",
          labels: {},
          raw: {},
        },
        "202": {
          id: "202",
          channel: "projects/repo-a",
          state: "ready",
          text: "Queued follow-up on repo-a",
          labels: {},
          raw: {},
        },
        "203": {
          id: "203",
          channel: "projects/repo-b",
          state: "ready",
          text: "Task that blocks, resumes claimed, then completes",
          labels: {},
          raw: {},
        },
      };

      const boardRunner: ExecRunner = async (_cmd, args) => {
        if (args[1] === "tasks" && args[2] === "claim") {
          const id = args[3]!;
          const asIdx = args.indexOf("--as");
          const task = boardTasks[id]!;
          task.state = "claimed";
          if (asIdx >= 0 && args[asIdx + 1]) task.assignee = args[asIdx + 1];
          return { stdout: JSON.stringify(task), stderr: "" };
        }
        if (args[1] === "tasks" && args[2] === "projects/") {
          return { stdout: JSON.stringify({ tasks: Object.values(boardTasks) }), stderr: "" };
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      };

      let nextTabSeq = 1;
      const openTabs = new Map<string, { tab_id: string; workspace_id: string; label: string }>();
      const liveAgents = new Map<string, { pane_id: string; agent_status: string; name: string }>();

      const herdrRunner: ExecRunner = async (_cmd, args) => {
        const [group, sub] = args;
        if (group === "workspace" && sub === "list") {
          return {
            stdout: JSON.stringify({
              result: {
                workspaces: [
                  { workspace_id: "w1", label: "repo-a" },
                  { workspace_id: "w2", label: "repo-b" },
                ],
              },
            }),
            stderr: "",
          };
        }
        if (group === "tab" && sub === "create") {
          const wsIdx = args.indexOf("--workspace");
          const labelIdx = args.indexOf("--label");
          const wsId = args[wsIdx + 1]!;
          const label = args[labelIdx + 1]!;
          const seq = nextTabSeq++;
          const tabId = `${wsId}:t${seq}`;
          const paneId = `${wsId}:p${seq}`;
          openTabs.set(tabId, { tab_id: tabId, workspace_id: wsId, label });
          return {
            stdout: JSON.stringify({
              result: {
                tab: { tab_id: tabId, workspace_id: wsId },
                root_pane: { pane_id: paneId },
              },
            }),
            stderr: "",
          };
        }
        if (group === "tab" && sub === "list") {
          return {
            stdout: JSON.stringify({ result: { tabs: [...openTabs.values()] } }),
            stderr: "",
          };
        }
        if (group === "tab" && sub === "close") {
          openTabs.delete(args[2]!);
          return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
        }
        if (group === "tab" && sub === "rename") {
          const tab = openTabs.get(args[2]!);
          if (tab) tab.label = args[3]!;
          return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
        }
        if (group === "agent" && sub === "start") {
          const name = args[2]!;
          const paneIdx = args.indexOf("--pane");
          const paneId = args[paneIdx + 1]!;
          liveAgents.set(paneId, { pane_id: paneId, agent_status: "working", name });
          return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
        }
        if (group === "agent" && sub === "list") {
          return {
            stdout: JSON.stringify({ result: { agents: [...liveAgents.values()] } }),
            stderr: "",
          };
        }
        return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
      };

      const dispatcher = new SwarmDispatcher({
        repoRoot: tmpBase,
        swarm,
        projects,
        machineName: "worker-machine",
        board: new BoardClient({ scope: "test-team" }, boardRunner),
        herdr: new HerdrClient({ target: "local" }, herdrRunner),
        promptTemplate: "Work on {{TASK_ID}}",
        availableAgentKinds: new Set(["claude"]),
        dryRun: false,
      });

      // Tick 1: claims #201 (repo-a) and #203 (repo-b); #202 waits for repo-a lock
      await dispatcher.tick();
      assert.ok(dispatcher.activeWorkers.has("201"));
      assert.ok(dispatcher.activeWorkers.has("203"));
      assert.ok(!dispatcher.activeWorkers.has("202"));

      // Tick 2: both #201 and #203 become blocked -> parked as [BLOCKED]
      boardTasks["201"]!.state = "blocked";
      boardTasks["203"]!.state = "blocked";
      await dispatcher.tick();
      assert.equal(dispatcher.activeWorkers.size, 0);
      assert.equal(dispatcher.parkedTabs.size, 2);
      assert.equal(openTabs.get("w1:t1")?.label, "[BLOCKED] task-201 (claude)");
      assert.equal(openTabs.get("w2:t2")?.label, "[BLOCKED] task-203 (claude)");
      assert.ok(!dispatcher.activeWorkers.has("202"), "repo-a still locked while #201 is parked");

      // Tick 3: human unblocks #201 and it completes directly; human unblocks #203 and it resumes claimed
      boardTasks["201"]!.state = "completed";
      boardTasks["203"]!.state = "claimed";
      await dispatcher.tick();

      assert.ok(!openTabs.has("w1:t1"), "parked #201 tab should auto-close once completed");
      assert.ok(!dispatcher.parkedTabs.has("201"), "#201 should be removed from parkedTabs");
      assert.ok(dispatcher.activeWorkers.has("202"), "#202 on repo-a should now be claimed");

      assert.ok(!dispatcher.parkedTabs.has("203"), "#203 should be unparked");
      assert.ok(dispatcher.activeWorkers.has("203"), "#203 should be restored to activeWorkers");
      assert.equal(
        openTabs.get("w2:t2")?.label,
        "task-203 (claude)",
        "[BLOCKED] prefix should be removed on resume",
      );

      // Tick 4: #203 finishes -> closes cleanly
      boardTasks["203"]!.state = "completed";
      await dispatcher.tick();
      assert.ok(!openTabs.has("w2:t2"), "resumed #203 tab should auto-close on completion");
      assert.ok(!dispatcher.activeWorkers.has("203"));
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("lists only open tasks and cleans up a tracked task that completed and left the open list", async () => {
    const fx = createLifecycleFixture();
    try {
      const board = createFakeBoard([
        { id: "301", channel: "projects/repo-a", state: "ready", text: "Do it", labels: {} },
      ]);
      const herdr = createFakeHerdr(FIXTURE_WORKSPACES);
      const dispatcher = new SwarmDispatcher({
        repoRoot: fx.tmpBase,
        swarm: fx.swarm,
        projects: fx.projects,
        machineName: "worker-machine",
        board: new BoardClient({ scope: "test-team" }, board.runner),
        herdr: new HerdrClient({ target: "local" }, herdr.runner),
        promptTemplate: "Work on {{TASK_ID}}",
        availableAgentKinds: new Set(["claude"]),
        dryRun: false,
      });

      await dispatcher.tick();
      assert.ok(dispatcher.activeWorkers.has("301"));
      const listCalls = board.calls.filter((c) => c[1] === "tasks" && c[2] === "projects/");
      assert.ok(listCalls.length > 0);
      assert.ok(listCalls.every((c) => c[c.indexOf("--state") + 1] === "open"));

      // Task completes: it drops out of the open list, so only a point lookup can see it.
      board.tasks.get("301")!.state = "completed";
      await dispatcher.tick();

      const reads = board.calls.filter((c) => c[1] === "read" && c[2] === "301");
      assert.ok(reads.length > 0, "tracked task missing from open list should be point-looked-up");
      assert.equal(dispatcher.activeWorkers.size, 0);
      assert.equal(herdr.openTabs.size, 0, "completed task tab should be closed");
    } finally {
      fx.cleanup();
    }
  });

  it("restart: a new dispatcher on the same state file adopts the task, renews, and cleans up", async () => {
    const fx = createLifecycleFixture();
    try {
      const statePath = join(fx.tmpBase, "state", "dispatcher-worker-machine.json");
      const board = createFakeBoard([
        { id: "401", channel: "projects/repo-a", state: "ready", text: "Long task", labels: {} },
      ]);
      const herdr = createFakeHerdr(FIXTURE_WORKSPACES);

      const a = makeFixtureDispatcher(fx, board, herdr, { statePath });
      await a.tick();
      assert.ok(a.activeWorkers.has("401"));
      assert.equal(board.callsFor("claim").length, 1);
      assert.ok(existsSync(statePath), "state persisted at end of tick");

      // Graceful stop must not close tabs or release the task
      a.requestStop();
      await a.runLoop(true);
      assert.equal(herdr.openTabs.size, 1);
      assert.equal(board.callsFor("release").length, 0);
      assert.equal(board.tasks.get("401")!.state, "claimed");

      const b = makeFixtureDispatcher(fx, board, herdr, {
        statePath,
        swarm: withEagerLeaseRenewal(fx.swarm),
      });
      assert.ok(b.activeWorkers.has("401"), "restored from state file at construction");

      await b.tick();
      assert.equal(board.callsFor("claim").length, 1, "B must not re-claim");
      const renews = board.callsFor("renew", "401");
      assert.equal(renews.length, 1);
      assert.equal(renews[0]![renews[0]!.indexOf("--as") + 1], "worker-worker-machine-401");
      assert.ok(b.activeWorkers.has("401"));

      board.tasks.get("401")!.state = "completed";
      await b.tick();
      assert.equal(b.activeWorkers.size, 0);
      assert.equal(herdr.openTabs.size, 0, "tab closes when the Board reports completed");

      const c = makeFixtureDispatcher(fx, board, herdr, { statePath });
      assert.equal(c.activeWorkers.size, 0, "cleanup was persisted too");
    } finally {
      fx.cleanup();
    }
  });

  it("restart: a parked [BLOCKED] task keeps holding the plain-tab repo lock", async () => {
    const fx = createLifecycleFixture();
    try {
      const statePath = join(fx.tmpBase, "dispatcher.json");
      const board = createFakeBoard([
        { id: "501", channel: "projects/repo-a", state: "ready", text: "Blocks", labels: {} },
      ]);
      const herdr = createFakeHerdr(FIXTURE_WORKSPACES);

      const a = makeFixtureDispatcher(fx, board, herdr, { statePath });
      await a.tick();
      board.tasks.get("501")!.state = "blocked";
      board.tasks.get("501")!.assignee = undefined;
      await a.tick();
      assert.ok(a.parkedTabs.has("501"));

      const b = makeFixtureDispatcher(fx, board, herdr, { statePath });
      assert.ok(b.parkedTabs.has("501"));
      board.tasks.set("502", {
        id: "502",
        channel: "projects/repo-a",
        state: "ready",
        text: "Same repo",
        labels: {},
        replies: [],
      });
      await b.tick();
      assert.ok(!b.activeWorkers.has("502"), "repo-a is still locked by the parked tab");
      assert.equal(board.callsFor("claim", "502").length, 0);
      assert.equal(herdr.openTabs.get("w1:t1")?.label, "[BLOCKED] task-501 (claude)");
    } finally {
      fx.cleanup();
    }
  });

  it("restart during reviewing: the reviewer verdict is still processed", async () => {
    const fx = createLifecycleFixture({ reviewer: true });
    try {
      const statePath = join(fx.tmpBase, "dispatcher.json");
      const board = createFakeBoard([
        { id: "601", channel: "projects/repo-a", state: "ready", text: "Reviewed", labels: {} },
      ]);
      const herdr = createFakeHerdr(FIXTURE_WORKSPACES);

      const a = makeFixtureDispatcher(fx, board, herdr, { statePath });
      await a.tick();
      board.postReply("601", "Done.\n\nSTATUS: READY_FOR_REVIEW", "worker-worker-machine-601");
      herdr.setAgentStatus("w-601", "idle");
      await a.tick();
      const phase = a.activeWorkers.get("601")?.phase;
      assert.equal(phase?.kind, "reviewing");
      assert.ok(herdr.agentByName("r1-601"), "reviewer agent started");

      // Dispatcher restarts while the reviewer works
      const b = makeFixtureDispatcher(fx, board, herdr, { statePath });
      assert.equal(b.activeWorkers.get("601")?.phase.kind, "reviewing");

      board.postReply("601", "Looks good.\n\nVERDICT: APPROVE", "reviewer-worker-machine-601");
      herdr.setAgentStatus("r1-601", "idle");
      await b.tick();

      assert.equal(board.callsFor("complete", "601").length, 1, "approval completes the task");
      assert.equal(b.activeWorkers.size, 0);
      assert.equal(herdr.openTabs.size, 0, "implementer and reviewer tabs are closed");
    } finally {
      fx.cleanup();
    }
  });

  it("restart after downtime longer than the lease: reclaims a lapsed task, orphans a taken one", async () => {
    const fx = createLifecycleFixture();
    try {
      const statePath = join(fx.tmpBase, "dispatcher.json");
      const board = createFakeBoard([
        { id: "701", channel: "projects/repo-a", state: "ready", text: "Lapses", labels: {} },
        { id: "702", channel: "projects/repo-b", state: "ready", text: "Taken", labels: {} },
      ]);
      const herdr = createFakeHerdr(FIXTURE_WORKSPACES);

      const a = makeFixtureDispatcher(fx, board, herdr, { statePath });
      await a.tick();
      assert.equal(a.activeWorkers.size, 2);
      a.requestStop();
      await a.runLoop(true);

      // Dispatcher is down past the lease: #701 lapses back to ready; #702 is taken elsewhere.
      Object.assign(board.tasks.get("701")!, { state: "ready", assignee: undefined });
      Object.assign(board.tasks.get("702")!, { state: "claimed", assignee: "worker-other-702" });

      const b = makeFixtureDispatcher(fx, board, herdr, { statePath });
      await b.tick();

      // #701: re-claimed under the same profile, still tracked, tab untouched
      const reclaims = board.callsFor("claim", "701");
      assert.equal(reclaims.length, 2, "original claim + reclaim");
      assert.equal(reclaims[1]![reclaims[1]!.indexOf("--as") + 1], "worker-worker-machine-701");
      assert.equal(board.tasks.get("701")!.state, "claimed");
      assert.ok(b.activeWorkers.has("701"));
      assert.equal(herdr.agentByName("w-701")?.agent_status, "working");

      // #702: orphaned, one reply, not tracked, state left to its new holder
      assert.ok(!b.activeWorkers.has("702"));
      assert.equal(herdr.openTabs.get("w2:t2")?.label, "[ORPHANED] task-702 (claude)");
      const replies702 = board.tasks.get("702")!.replies;
      assert.equal(replies702.length, 1);
      assert.match(replies702[0]!.text, /worker-other-702/);
      assert.equal(board.tasks.get("702")!.assignee, "worker-other-702");
      for (const sub of ["release", "fail", "complete", "block", "renew"]) {
        assert.equal(board.callsFor(sub, "702").length, 0, `no ${sub} on a lost claim`);
      }

      // Next tick: nothing more is said about #702, and #701 keeps renewing normally
      await b.tick();
      assert.equal(board.tasks.get("702")!.replies.length, 1);
      assert.ok(b.activeWorkers.has("701"));
    } finally {
      fx.cleanup();
    }
  });

  it("orphans the tab when a lapsed task is re-claimed by someone else first", async () => {
    const fx = createLifecycleFixture();
    try {
      const statePath = join(fx.tmpBase, "dispatcher.json");
      const board = createFakeBoard([
        { id: "801", channel: "projects/repo-a", state: "ready", text: "Race", labels: {} },
      ]);
      const herdr = createFakeHerdr(FIXTURE_WORKSPACES);
      const a = makeFixtureDispatcher(fx, board, herdr, { statePath });
      await a.tick();

      Object.assign(board.tasks.get("801")!, { state: "ready", assignee: undefined });
      // The open list says ready, but by the time we claim, another worker got it.
      const racingRunner: ExecRunner = async (cmd, args, opts) => {
        if (args[1] === "tasks" && args[2] === "claim" && args[3] === "801") {
          Object.assign(board.tasks.get("801")!, { state: "claimed", assignee: "worker-fast-801" });
        }
        return board.runner(cmd, args, opts);
      };

      const b = makeFixtureDispatcher(fx, { runner: racingRunner }, herdr, { statePath });
      await b.tick();
      assert.ok(!b.activeWorkers.has("801"));
      assert.equal(herdr.openTabs.get("w1:t1")?.label, "[ORPHANED] task-801 (claude)");
      assert.equal(board.tasks.get("801")!.replies.length, 1);
      assert.equal(board.tasks.get("801")!.assignee, "worker-fast-801");

      const c = makeFixtureDispatcher(fx, board, herdr, { statePath });
      assert.equal(c.activeWorkers.size, 0, "orphaning is persisted");
    } finally {
      fx.cleanup();
    }
  });

  it("orphan sweep with a corrupt state file: quarantines, adopts live agents, releases dead ones", async () => {
    const fx = createLifecycleFixture();
    try {
      const statePath = join(fx.tmpBase, "dispatcher.json");
      writeFileSync(statePath, '{"version": 1, "machine": "worker-machine", "activeWor');

      const claimedBy = (id: string) => ({
        id,
        state: "claimed" as const,
        assignee: `worker-worker-machine-${id}`,
        labels: {},
      });
      const board = createFakeBoard([
        { ...claimedBy("901"), channel: "projects/repo-a", text: "Live implementer" },
        { ...claimedBy("902"), channel: "projects/repo-a", text: "Agent died" },
        { ...claimedBy("903"), channel: "projects/repo-b", text: "Mid-review" },
        // Someone else's claim is never ours to sweep
        {
          id: "904",
          channel: "projects/repo-b",
          state: "claimed",
          assignee: "worker-other-machine-904",
          text: "Not ours",
          labels: {},
        },
      ]);
      board.postReply("901", "Earlier progress update", "worker-worker-machine-901");
      board.postReply(
        "901",
        "Old handoff\n\nSTATUS: READY_FOR_REVIEW",
        "worker-worker-machine-901",
      );

      const herdr = createFakeHerdr(FIXTURE_WORKSPACES);
      const addLiveAgent = (name: string, wsId: string, tabId: string, label: string) => {
        herdr.openTabs.set(tabId, { tab_id: tabId, workspace_id: wsId, label });
        herdr.liveAgents.set(`${tabId}:p`, {
          pane_id: `${tabId}:p`,
          tab_id: tabId,
          workspace_id: wsId,
          agent_status: "working",
          name,
        });
      };
      addLiveAgent("w-901", "w1", "w1:t90", "task-901 (claude)");
      addLiveAgent("w-903", "w2", "w2:t91", "task-903 [IN-REVIEW r1] (claude)");
      addLiveAgent("r1-903", "w2", "w2:t92", "review-903 r1 (claude)");
      addLiveAgent("w-904", "w2", "w2:t93", "task-904 (claude)");

      const b = makeFixtureDispatcher(fx, board, herdr, { statePath });
      assert.equal(b.activeWorkers.size + b.parkedTabs.size, 0, "corrupt state starts empty");
      assert.ok(!existsSync(statePath) || readFileSync(statePath, "utf8").startsWith("{\n"));
      assert.equal(
        readdirSync(fx.tmpBase).filter((f) => f.startsWith("dispatcher.json.corrupt-")).length,
        1,
        "corrupt file is quarantined",
      );

      await b.tick();

      // #901 adopted as implementing/running on the live agent, old replies marked seen
      const adopted = b.activeWorkers.get("901");
      assert.ok(adopted);
      assert.equal(adopted.phase.kind, "implementing");
      assert.equal(adopted.ctx.boardProfile, "worker-worker-machine-901");
      assert.equal(adopted.phaseSeenReplyIds.size, 2);
      assert.equal(board.callsFor("release", "901").length, 0);

      // #902 released with an explanation
      assert.equal(board.tasks.get("902")!.state, "ready");
      assert.equal(board.callsFor("release", "902").length, 1);
      assert.match(board.tasks.get("902")!.replies.at(-1)!.text, /released the task/);

      // #903 parked [BLOCKED] instead of guessing the review round
      assert.ok(b.parkedTabs.has("903"));
      assert.equal(board.tasks.get("903")!.state, "blocked");
      assert.equal(herdr.openTabs.get("w2:t91")?.label, "[BLOCKED] task-903 (claude)");

      // #904 untouched
      assert.equal(board.tasks.get("904")!.replies.length, 0);
      assert.ok(!b.activeWorkers.has("904") && !b.parkedTabs.has("904"));

      // Next tick: the adopted task's lease is renewed right away under its own profile,
      // #902 (now ready) waits for repo-a's plain-tab lock, and #901 is not re-sent to review.
      await b.tick();
      const renews = board.callsFor("renew", "901");
      assert.equal(renews.length, 1);
      assert.equal(renews[0]![renews[0]!.indexOf("--as") + 1], "worker-worker-machine-901");
      assert.equal(board.callsFor("claim", "902").length, 0, "repo-a is busy with adopted #901");
      assert.ok(!herdr.agentByName("r1-901"), "old READY_FOR_REVIEW is not replayed");

      // The adoption is durable from here on
      const c = makeFixtureDispatcher(fx, board, herdr, { statePath });
      assert.ok(c.activeWorkers.has("901"));
      assert.ok(c.parkedTabs.has("903"));
    } finally {
      fx.cleanup();
    }
  });

  it("orphan sweep does not adopt a task that reconcile just finished this tick", async () => {
    const fx = createLifecycleFixture({ reviewer: true });
    try {
      // No-diff handoff completes the task inside reconcile; the agent stays alive afterwards.
      fx.swarm.workerDefaults.reviewer.skipIfNoDiff = true;
      fx.swarm.workerDefaults.closeTabOnComplete = false;
      const board = createFakeBoard([
        { id: "951", channel: "projects/repo-a", state: "ready", text: "No-op", labels: {} },
      ]);
      const herdr = createFakeHerdr(FIXTURE_WORKSPACES);
      const d = new SwarmDispatcher({
        repoRoot: fx.tmpBase,
        swarm: fx.swarm,
        projects: fx.projects,
        machineName: "worker-machine",
        board: new BoardClient({ scope: "test-team" }, board.runner),
        herdr: new HerdrClient({ target: "local" }, herdr.runner),
        promptTemplate: "x",
        gitDetector: {
          captureHeadSha: () => "abc1234",
          detectChanges: () => ({
            hasChanges: false,
            currentHeadSha: "abc1234",
            dirtyFiles: 0,
            detail: "no changes",
          }),
        },
        availableAgentKinds: new Set(["claude"]),
        dryRun: false,
      });
      await d.tick();
      assert.ok(d.activeWorkers.has("951"));

      board.postReply(
        "951",
        "Nothing to change.\n\nSTATUS: READY_FOR_REVIEW",
        "worker-worker-machine-951",
      );
      herdr.setAgentStatus("w-951", "idle");
      await d.tick();

      // The list fetched at tick start still said claimed-by-us, but reconcile completed it.
      assert.equal(board.callsFor("complete", "951").length, 1);
      assert.ok(herdr.agentByName("w-951"), "agent is still alive");
      assert.equal(d.activeWorkers.size, 0, "completed task is not re-adopted by the sweep");
      assert.equal(board.callsFor("release", "951").length, 0);
    } finally {
      fx.cleanup();
    }
  });

  it("uses <=32-char Board-valid profiles for long machine names and logs real claim errors", async () => {
    const fx = createLifecycleFixture();
    const longMachine = "example-macbook-pro";
    const taskId = "msg_0a3e4c6e-f4ed-4d2c-bef5-beed17baf5c8_1";
    try {
      fx.swarm.machines[longMachine] = {
        ...fx.swarm.machines["worker-machine"]!,
        hostname: longMachine,
        labels: [`machine=${longMachine}`, "os=macos"],
      };
      fx.projects.projects["repo-a"]!.defaultMachine = longMachine;
      fx.projects.projects["repo-a"]!.paths[longMachine] =
        fx.projects.projects["repo-a"]!.paths["worker-machine"]!;

      const board = createFakeBoard([
        {
          id: taskId,
          channel: "projects/repo-a",
          state: "ready",
          text: "Check git log",
          labels: {},
        },
      ]);
      const herdr = createFakeHerdr(FIXTURE_WORKSPACES);

      // 1) Long machine name claims with a <=32-char profile matching Board rules
      const d = new SwarmDispatcher({
        repoRoot: fx.tmpBase,
        swarm: fx.swarm,
        projects: fx.projects,
        machineName: longMachine,
        board: new BoardClient({ scope: "test-team" }, board.runner),
        herdr: new HerdrClient({ target: "local" }, herdr.runner),
        promptTemplate: "Task {{TASK_ID}} as {{BOARD_PROFILE}}",
        availableAgentKinds: new Set(["claude"]),
        dryRun: false,
      });
      await d.tick();

      const claims = board.callsFor("claim", taskId);
      assert.equal(claims.length, 1);
      const usedProfile = claims[0]![claims[0]!.indexOf("--as") + 1]!;
      assert.ok(
        usedProfile.length <= MAX_BOARD_PROFILE_LENGTH,
        `expected <=32 chars, got ${usedProfile.length}: ${usedProfile}`,
      );
      assert.match(usedProfile, BOARD_PROFILE_REGEX);
      assert.equal(d.activeWorkers.get(taskId)?.ctx.boardProfile, usedProfile);

      // 2) Non-conflict claim failure logs ERROR with actual API detail (not "claimed by another host")
      const board2 = createFakeBoard([
        { id: taskId, channel: "projects/repo-a", state: "ready", text: "Fail 400", labels: {} },
      ]);
      const failingRunner: ExecRunner = async (cmd, args, opts) => {
        if (args[1] === "tasks" && args[2] === "claim") {
          const err = new Error("Command failed: vercel board tasks claim") as Error & {
            stdout?: string;
            stderr?: string;
          };
          err.stdout = JSON.stringify({
            status: "error",
            reason: "invalid_arguments",
            data: { error: { code: "invalid_request", message: "bad profile", status: 400 } },
          });
          err.stderr = "";
          throw err;
        }
        return board2.runner(cmd, args, opts);
      };

      const errors: string[] = [];
      const infos: string[] = [];
      const origError = console.error;
      const origLog = console.log;
      console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
      console.log = (...args: unknown[]) => infos.push(args.map(String).join(" "));
      try {
        const dErr = new SwarmDispatcher({
          repoRoot: fx.tmpBase,
          swarm: fx.swarm,
          projects: fx.projects,
          machineName: longMachine,
          board: new BoardClient({ scope: "test-team" }, failingRunner),
          herdr: new HerdrClient({ target: "local" }, herdr.runner),
          promptTemplate: "x",
          availableAgentKinds: new Set(["claude"]),
          dryRun: false,
        });
        await dErr.tick();
      } finally {
        console.error = origError;
        console.log = origLog;
      }

      assert.ok(
        errors.some(
          (line) => line.includes("Failed to claim task") && line.includes("bad profile"),
        ),
        `expected ERROR log with API message, got errors=${JSON.stringify(errors)} infos=${JSON.stringify(infos)}`,
      );
      assert.ok(!infos.some((line) => line.includes("claimed by another host")));
    } finally {
      fx.cleanup();
    }
  });
});
