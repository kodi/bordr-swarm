import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SwarmDispatcher } from "../src/dispatcher.ts";
import {
  BoardClient,
  extractJsonPayload,
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
});
