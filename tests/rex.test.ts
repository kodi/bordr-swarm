import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { PassThrough } from "node:stream";
import { parseRexEventLine, type SwarmEvent } from "../src/bus/events.ts";
import { RexEventSource } from "../src/bus/rex-event-source.ts";
import type { TailChild } from "../src/bus/board-tail-source.ts";
import { SwarmDispatcher } from "../src/dispatcher.ts";
import { BoardClient, type ExecRunner } from "../src/lib/board.ts";
import { parseSwarmConfig, resolveMachineRuntime, type ProjectsConfig } from "../src/lib/config.ts";
import { defaultWorkerRuntimeKind } from "../src/lib/host-env.ts";
import { buildMachineRegistryEntry, mergeRegistryIntoLeadCatalog } from "../src/lib/registry.ts";
import {
  normalizeRexStatus,
  RexClient,
  RexNotFoundError,
  RexUnreachableError,
  type RexExecRunner,
} from "../src/lib/rex.ts";
import { matchesMachineLabels } from "../src/lib/routing.ts";
import { parseSwarmAgentNameFromWindowLabel, RexRuntime } from "../src/lib/runtimes/rex-runtime.ts";
import { createGitWorktreeManager, resolveWorktreePath } from "../src/lib/worktree.ts";
import { shouldWakeDispatcher } from "../src/reactors/dispatcher-wake.ts";
import {
  buildWorkerServicePath,
  MACOS_REX_BIN_DIR_REL,
  renderLaunchdPlist,
  renderSystemdWorkerUnit,
  resolveRuntimeBinaryDir,
} from "../scripts/apply-worker.ts";
import { normalizeRuntimeAnswer, parseInitFlags } from "../scripts/init.ts";
import { ManualTimers } from "./helpers/bus-fakes.ts";

const FIXTURES_DIR = resolve(import.meta.dirname, "fixtures/rex");

function readFixtureText(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

function readFixtureJson<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFixtureText(name)) as T;
}

describe("Slice 4: MachineRuntime config, routing label, and registry", () => {
  it("normalizes legacy herdrTarget and explicit runtime union, and rejects conflicts", () => {
    const legacy = parseSwarmConfig({
      machines: {
        "m-legacy": { role: "worker", os: "macos", herdrTarget: "studio" },
        "m-default": { role: "worker", os: "linux" },
        "m-rex": { role: "worker", os: "linux", runtime: { kind: "rex" } },
      },
    });

    assert.deepEqual(resolveMachineRuntime(legacy.machines["m-legacy"]!), {
      kind: "herdr",
      target: "studio",
    });
    assert.deepEqual(resolveMachineRuntime(legacy.machines["m-default"]!), {
      kind: "herdr",
      target: "local",
    });
    assert.deepEqual(resolveMachineRuntime(legacy.machines["m-rex"]!), { kind: "rex" });
    assert.ok(legacy.machines["m-rex"]!.labels.includes("runtime=rex"));
    assert.ok(legacy.machines["m-default"]!.labels.includes("runtime=herdr"));

    assert.throws(
      () =>
        parseSwarmConfig({
          machines: {
            bad: { role: "worker", runtime: { kind: "rex" }, herdrTarget: "local" },
          },
        }),
      /Cannot set both/,
    );
    assert.throws(
      () =>
        parseSwarmConfig({
          machines: {
            bad: {
              role: "worker",
              runtime: { kind: "herdr", target: "a" },
              herdrTarget: "b",
            },
          },
        }),
      /Conflicting runtime\.target/,
    );
  });

  it("matches runtime=rex and runtime=herdr routing labels", () => {
    const swarm = parseSwarmConfig({
      machines: {
        "w-herdr": { role: "worker", os: "macos", runtime: { kind: "herdr", target: "local" } },
        "w-rex": { role: "worker", os: "linux", runtime: { kind: "rex" } },
      },
    });

    assert.equal(
      matchesMachineLabels({ runtime: "rex" }, "w-rex", swarm.machines["w-rex"]!, "any").matched,
      true,
    );
    assert.equal(
      matchesMachineLabels({ runtime: "rex" }, "w-herdr", swarm.machines["w-herdr"]!, "any")
        .matched,
      false,
    );
    assert.equal(
      matchesMachineLabels({ runtime: "herdr" }, "w-rex", swarm.machines["w-rex"]!, "any").matched,
      false,
    );
  });

  it("advertises runtime in machine registry cards and Lead catalog", () => {
    const swarm = parseSwarmConfig({
      machines: {
        "w-rex": { role: "worker", os: "linux", runtime: { kind: "rex" }, maxWorkers: 2 },
      },
    });
    const entry = buildMachineRegistryEntry({
      swarm,
      projects: { projects: {} },
      machineName: "w-rex",
      availableAgentKinds: new Set(["claude"]),
      nowIso: "2026-11-27T12:00:00.000Z",
    });
    assert.equal(entry.runtime, "rex");
    const catalog = mergeRegistryIntoLeadCatalog({ entries: [entry] });
    assert.equal(catalog.machines["w-rex"]?.runtime, "rex");
  });
});

describe("Slice 5: RexClient fixtures, argv, errors, and normalizeRexStatus", () => {
  it("parses all sanitized Slice 1 fixtures and passes exact CLI args", async () => {
    const calls: Array<{ cmd: string; args: string[]; stdin?: string }> = [];
    const statusFx = readFixtureJson<Record<string, unknown>>("program-status.json");
    const procFx = readFixtureJson<Record<string, unknown>>("process.json");

    const runner: RexExecRunner = async (cmd, args, opts) => {
      calls.push({ cmd, args, stdin: opts?.stdin });
      if (args[0] === "whoami") return { stdout: readFixtureText("whoami.json"), stderr: "" };
      if (args[0] === "ls") return { stdout: readFixtureText("session-ls.json"), stderr: "" };
      if (args[0] === "new") return { stdout: readFixtureText("session-new.json"), stderr: "" };
      if (args[0] === "window" && args[1] === "new")
        return { stdout: readFixtureText("window-new.json"), stderr: "" };
      if (args[0] === "window" && args[1] === "ls")
        return { stdout: readFixtureText("window-ls.json"), stderr: "" };
      if (args[0] === "block" && args[1] === "ls")
        return { stdout: readFixtureText("block-ls.json"), stderr: "" };
      if (args[0] === "do" && args[1] === "com.superlogical.terminal.program_status")
        return { stdout: JSON.stringify(statusFx.blocked_permission), stderr: "" };
      if (args[0] === "do" && args[1] === "com.superlogical.terminal.process")
        return { stdout: JSON.stringify(procFx.alive), stderr: "" };
      if (args[0] === "capture") return { stdout: "line1\nline2\nline3\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };

    const rex = new RexClient({}, runner);
    const whoami = await rex.whoami();
    assert.equal(whoami.rex_version, "0.1.0-preview.25");

    const sessions = await rex.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.label, "demo-app");

    const created = await rex.newSession({
      label: "demo-app",
      cwd: "/repo",
      windowLabel: "task-aaaa1111 (claude)",
      command: ["env", "BOARD_PROFILE=w", "claude"],
      keepOpen: true,
    });
    assert.equal(created.session_id, "session:01a20000-0000-7000-8000-000000000001");
    assert.deepEqual(calls.at(-1)!.args, [
      "new",
      "demo-app",
      "-c",
      "/repo",
      "--window",
      "task-aaaa1111 (claude)",
      "--keep-open",
      "--json",
      "--",
      "env",
      "BOARD_PROFILE=w",
      "claude",
    ]);

    const win = await rex.newWindow({
      sessionId: created.session_id,
      label: "task-bbbb2222 (claude)",
      cwd: "/repo",
      command: ["claude"],
      focus: false,
      keepOpen: true,
    });
    assert.equal(win.window_id, "window:01a20000-0000-7000-8000-000000000012");

    const winList = await rex.listWindows(created.session_id);
    assert.equal(winList.windows.length, 2);
    const blocks = await rex.listBlocks(created.session_id);
    assert.equal(blocks.length, 2);

    const st = await rex.programStatus("block:1", created.session_id);
    assert.equal(st.records[0]!.state, "blocked");
    assert.equal(st.records[0]!.kind, "permission");

    const proc = await rex.process("block:1", created.session_id);
    assert.equal(proc.foreground?.pid, 3484);

    // Multi-line prompt uses bracketed paste over stdin + send-key enter
    await rex.promptBlock("block:1", "line A\nline B", { sessionId: created.session_id });
    const sendCall = calls.at(-2)!;
    const keyCall = calls.at(-1)!;
    assert.deepEqual(sendCall.args, ["send", "-s", created.session_id, "-b", "block:1"]);
    assert.equal(sendCall.stdin, "\x1b[200~line A\nline B\x1b[201~");
    assert.deepEqual(keyCall.args, [
      "send-key",
      "-s",
      created.session_id,
      "-b",
      "block:1",
      "enter",
    ]);
  });

  it("maps exit code 3 to RexNotFoundError and exit code 4 to RexUnreachableError", async () => {
    const notFoundRunner: RexExecRunner = async () => {
      throw Object.assign(new Error('block target "b1" not found'), { code: 3 });
    };
    const unreachableRunner: RexExecRunner = async () => {
      throw Object.assign(new Error("server unreachable"), { code: 4 });
    };

    await assert.rejects(
      () => new RexClient({}, notFoundRunner).programStatus("b1"),
      RexNotFoundError,
    );
    await assert.rejects(() => new RexClient({}, unreachableRunner).whoami(), RexUnreachableError);
  });

  it("normalizes Rex program_status records across states, stale PIDs, exited procs, and agy auth grace", () => {
    const aliveProc = {
      last_exit: null,
      child: { pid: 100, name: "claude", cwd: "/repo" },
      foreground: { pid: 100, name: "claude", cwd: "/repo" },
    };

    // Dead process -> alive: false
    assert.equal(
      normalizeRexStatus({
        records: [{ state: "idle", owner: { pid: 100 } }],
        process: { last_exit: { code: 1 }, child: null, foreground: null },
        nowMs: 10_000,
      }).alive,
      false,
    );

    // Empty records with live proc -> unknown
    assert.deepEqual(normalizeRexStatus({ records: [], process: aliveProc, nowMs: 10_000 }), {
      alive: true,
      status: "unknown",
      cwd: "/repo",
    });

    // Stale owner PID dropped -> unknown
    assert.equal(
      normalizeRexStatus({
        records: [{ state: "idle", owner: { pid: 999 } }],
        process: aliveProc,
        nowMs: 10_000,
      }).status,
      "unknown",
    );

    // Root child PID kept even when foreground is a subshell tool call
    assert.equal(
      normalizeRexStatus({
        records: [{ state: "working", owner: { pid: 100 } }],
        process: {
          last_exit: null,
          child: { pid: 100, name: "claude", cwd: "/repo" },
          foreground: { pid: 205, name: "bash", cwd: "/repo" },
        },
        nowMs: 10_000,
      }).status,
      "working",
    );

    // error -> blocked (kind=error)
    assert.deepEqual(
      normalizeRexStatus({
        records: [{ state: "error", owner: { pid: 100 } }],
        process: aliveProc,
        nowMs: 10_000,
      }),
      { alive: true, status: "blocked", blockedKind: "error", cwd: "/repo" },
    );

    // agy transient blocked/auth inside grace -> unknown; after grace -> blocked
    assert.equal(
      normalizeRexStatus({
        records: [{ state: "blocked", kind: "auth", owner: { pid: 100 } }],
        process: aliveProc,
        startedAtMs: 10_000,
        nowMs: 12_000,
        authGraceMs: 5_000,
      }).status,
      "unknown",
    );
    assert.deepEqual(
      normalizeRexStatus({
        records: [{ state: "blocked", kind: "auth", owner: { pid: 100 } }],
        process: aliveProc,
        startedAtMs: 10_000,
        nowMs: 16_000,
        authGraceMs: 5_000,
      }),
      { alive: true, status: "blocked", blockedKind: "auth", cwd: "/repo" },
    );
  });

  it("extracts deterministic agent names from swarm window labels", () => {
    assert.equal(parseSwarmAgentNameFromWindowLabel("task-aaaa1111 (claude)"), "w-aaaa1111");
    assert.equal(
      parseSwarmAgentNameFromWindowLabel("[BLOCKED] task-aaaa1111 (claude)"),
      "w-aaaa1111",
    );
    assert.equal(parseSwarmAgentNameFromWindowLabel("review-aaaa1111 r2 (codex)"), "r2-aaaa1111");
    assert.equal(parseSwarmAgentNameFromWindowLabel("my-personal-shell"), null);
  });
});

describe("Slice 6: SwarmDispatcher end-to-end flow over fake RexClient", () => {
  it("spawns in awaiting_prompt, delivers on first idle, completes and closes window, and handles blocked/closed", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "rex-disp-"));
    const repoPath = join(tmpBase, "demo-app");
    mkdirSync(repoPath);

    try {
      const swarm = parseSwarmConfig({
        board: { scope: "team", leaseDuration: "15m", leaseRenewIntervalSeconds: 300 },
        workerDefaults: {
          pollIntervalSeconds: 5,
          idleTimeoutSeconds: 30,
          startupTimeoutSeconds: 90,
          closeTabOnComplete: true,
        },
        machines: {
          "rex-box": { role: "worker", os: "linux", runtime: { kind: "rex" }, maxWorkers: 2 },
        },
      });
      const projects: ProjectsConfig = {
        projects: {
          "demo-app": {
            defaultMachine: "rex-box",
            baseBranch: "main",
            useWorktree: false,
            paths: { "rex-box": repoPath },
          },
        },
      };

      // Fake Board
      const taskState = {
        id: "msg_aaaa1111_1",
        channel: "projects/demo-app",
        state: "ready",
        assignee: undefined as string | undefined,
        replies: [] as string[],
      };
      const boardRunner: ExecRunner = async (_cmd, args) => {
        const [, group, sub] = args;
        const wire = () => ({
          message: {
            id: taskState.id,
            channel: taskState.channel,
            text: "Do something",
            labels: { runtime: "rex" },
            task: {
              state: taskState.state,
              claim: taskState.assignee ? { actor: `vercel:user:u1+${taskState.assignee}` } : null,
            },
          },
          replies: taskState.replies.length,
        });
        if (group === "tasks" && sub?.endsWith("/")) {
          const open = ["ready", "claimed", "blocked"].includes(taskState.state) ? [wire()] : [];
          return { stdout: JSON.stringify({ tasks: open, cursor: null }), stderr: "" };
        }
        if (group === "tasks" && sub === "claim") {
          taskState.state = "claimed";
          taskState.assignee = args[args.indexOf("--as") + 1];
          return { stdout: JSON.stringify(wire()), stderr: "" };
        }
        if (group === "read" && sub === taskState.id) {
          return { stdout: JSON.stringify({ ...wire(), replies: [] }), stderr: "" };
        }
        if (group === "read") {
          return { stdout: JSON.stringify({ threads: [], cursor: null }), stderr: "" };
        }
        if (group === "reply") {
          taskState.replies.push(args[3] ?? "");
          return { stdout: JSON.stringify({ ok: true }), stderr: "" };
        }
        if (group === "tasks" && sub === "fail") {
          taskState.state = "failed";
          taskState.assignee = undefined;
          return { stdout: JSON.stringify({ ok: true }), stderr: "" };
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      };

      // Fake Rex
      let currentRecord: Record<string, unknown> | null = null;
      const windows = new Map<string, { window_id: string; label: string; block_id: string }>();
      const sentPrompts: string[] = [];
      const closedWindows: string[] = [];
      const renamedLabels: string[] = [];

      const rexRunner: RexExecRunner = async (_cmd, args, opts) => {
        if (args[0] === "ls") {
          return {
            stdout: JSON.stringify({
              sessions: windows.size > 0 ? [{ session_id: "session:s1", label: "demo-app" }] : [],
            }),
            stderr: "",
          };
        }
        if (args[0] === "new") {
          const label = args[args.indexOf("--window") + 1]!;
          windows.set("window:w1", { window_id: "window:w1", label, block_id: "block:b1" });
          return {
            stdout: JSON.stringify({
              session_id: "session:s1",
              initial_windows: [{ window_id: "window:w1", block_ids: ["block:b1"] }],
            }),
            stderr: "",
          };
        }
        if (args[0] === "window" && args[1] === "ls") {
          return {
            stdout: JSON.stringify({
              session_id: "session:s1",
              label: "demo-app",
              windows: [...windows.values()].map((w) => ({
                window_id: w.window_id,
                label: w.label,
                focused_block_id: w.block_id,
                layers: [{ blocks: [{ block_id: w.block_id, label: "shell" }] }],
              })),
            }),
            stderr: "",
          };
        }
        if (args[0] === "do" && args[1] === "com.superlogical.terminal.program_status") {
          return {
            stdout: JSON.stringify({ records: currentRecord ? [currentRecord] : [] }),
            stderr: "",
          };
        }
        if (args[0] === "do" && args[1] === "com.superlogical.terminal.process") {
          return {
            stdout: JSON.stringify({
              last_exit: null,
              child: { pid: 42, name: "claude", cwd: repoPath },
              foreground: { pid: 42, name: "claude", cwd: repoPath },
            }),
            stderr: "",
          };
        }
        if (args[0] === "send") {
          sentPrompts.push(opts?.stdin ?? "");
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "window" && args[1] === "rename") {
          const wid = args[args.length - 2]!;
          const label = args[args.length - 1]!;
          const w = windows.get(wid);
          if (w) w.label = label;
          renamedLabels.push(label);
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "window" && args[1] === "close") {
          const wid = args[args.length - 1]!;
          windows.delete(wid);
          closedWindows.push(wid);
          return { stdout: "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      };

      const dispatcher = new SwarmDispatcher({
        repoRoot: tmpBase,
        swarm,
        projects,
        machineName: "rex-box",
        board: new BoardClient({ scope: "team" }, boardRunner),
        runtime: new RexRuntime(new RexClient({}, rexRunner)),
        promptTemplate: "Task {{TASK_ID}}\nLine 2",
        availableAgentKinds: new Set(["claude"]),
        dryRun: false,
      });

      // Tick 1: claims and spawns in awaiting_prompt (no prompt sent yet!)
      await dispatcher.tick();
      assert.equal(dispatcher.activeWorkers.size, 1);
      assert.equal(sentPrompts.length, 0);
      const t1 = dispatcher.activeWorkers.get(taskState.id)!;
      assert.equal(t1.phase.kind, "implementing");
      if (t1.phase.kind === "implementing") {
        assert.equal(t1.phase.impl.lifecycle.kind, "awaiting_prompt");
      }

      // Tick 2: empty records (unknown) -> stays in awaiting_prompt, no prompt sent
      await dispatcher.tick();
      assert.equal(sentPrompts.length, 0);

      // Tick 3: agent emits blocked/permission during startup -> renamed [BLOCKED] & notifies Rex
      currentRecord = { state: "blocked", kind: "permission", owner: { pid: 42 } };
      await dispatcher.tick();
      assert.ok(renamedLabels.some((l) => l.startsWith("[BLOCKED]")));
      assert.ok(taskState.replies.some((r) => r.includes("in Rex")));

      // Tick 4: agent reaches idle -> delivers queued prompt and enters running
      currentRecord = { state: "idle", owner: { pid: 42 } };
      await dispatcher.tick();
      assert.equal(sentPrompts.length, 1);
      assert.ok(sentPrompts[0]!.includes("Task msg_aaaa1111_1"));

      // Tick 5: agent marks task completed -> window closed automatically
      currentRecord = { state: "working", owner: { pid: 42 } };
      taskState.state = "completed";
      await dispatcher.tick();
      assert.equal(dispatcher.activeWorkers.size, 0);
      assert.deepEqual(closedWindows, ["window:w1"]);
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

describe("Slice 7: git worktree manager", () => {
  it("resolves default and custom worktree paths and runs exact git worktree commands", async () => {
    assert.equal(
      resolveWorktreePath({
        repoPath: "/repos/demo-app",
        projectSlug: "demo-app",
        shortId: "abc12345",
      }),
      resolve("/repos/.swarm-worktrees/demo-app/abc12345"),
    );
    assert.equal(
      resolveWorktreePath({
        repoPath: "/repos/demo-app",
        projectSlug: "demo-app",
        shortId: "abc12345",
        worktreeRoot: "/tmp/wt",
      }),
      resolve("/tmp/wt/demo-app/abc12345"),
    );

    const calls: string[][] = [];
    const manager = createGitWorktreeManager(
      async (_cmd, args) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      },
      () => {},
    );

    const { worktreePath } = await manager.create({
      repoPath: "/repos/demo-app",
      projectSlug: "demo-app",
      shortId: "abc12345",
      branch: "task/abc12345",
      baseBranch: "main",
      worktreeRoot: "/tmp/wt",
    });
    assert.deepEqual(calls[0], [
      "-C",
      "/repos/demo-app",
      "worktree",
      "add",
      "-b",
      "task/abc12345",
      worktreePath,
      "main",
    ]);

    await manager.remove({ repoPath: "/repos/demo-app", worktreePath, branch: "task/abc12345" });
    assert.deepEqual(calls[1], [
      "-C",
      "/repos/demo-app",
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
    assert.deepEqual(calls[2], ["-C", "/repos/demo-app", "branch", "-D", "task/abc12345"]);
  });
});

describe("Slice 8: init runtime flag & defaults", () => {
  it("parses --runtime and picks default based on installed binaries", () => {
    assert.equal(parseInitFlags(["--role", "worker", "--runtime", "rex"]).runtime, "rex");
    assert.equal(parseInitFlags(["--runtime=herdr"]).runtime, "herdr");
    assert.throws(() => parseInitFlags(["--runtime", "tmux"]), /Invalid --runtime/);

    assert.equal(normalizeRuntimeAnswer("", "rex"), "rex");
    assert.equal(normalizeRuntimeAnswer("1", "rex"), "herdr");
    assert.equal(normalizeRuntimeAnswer("2", "herdr"), "rex");
    assert.equal(normalizeRuntimeAnswer("invalid", "herdr"), null);

    assert.equal(defaultWorkerRuntimeKind({ herdr: false, rex: true }), "rex");
    assert.equal(defaultWorkerRuntimeKind({ herdr: true, rex: true }), "herdr");
    assert.equal(defaultWorkerRuntimeKind({ herdr: false, rex: false }), "herdr");
  });
});

describe("Slice 10: RexEventSource and Rex NDJSON event parser", () => {
  it("parses every event line in tests/fixtures/rex/events.ndjson", () => {
    const lines = readFixtureText("events.ndjson").trim().split("\n");
    const parsed = lines.map(parseRexEventLine).filter((e): e is SwarmEvent => e !== null);
    assert.deepEqual(
      parsed.map((e) => e.kind),
      ["rex.agent_status", "rex.pane_exited", "rex.tab_closed", "rex.pane_closed"],
    );
    assert.equal(parsed[0]!.kind, "rex.agent_status");
    if (parsed[0]!.kind === "rex.agent_status") {
      assert.equal(parsed[0]!.status, "idle");
      assert.equal(parsed[0]!.paneId, "block:01a20000-0000-7000-8000-000000000022");
    }
    assert.equal(parseRexEventLine("not json"), null);
    assert.equal(parseRexEventLine(""), null);
  });

  it("wakes dispatcher on tracked rex pane/tab events and ignores untracked ones", () => {
    const ctx = {
      projectChannelPrefix: "projects/",
      trackedTaskIds: new Set<string>(),
      trackedPaneIds: new Set(["block:b1"]),
      trackedTabIds: new Set(["window:w1"]),
    };
    assert.equal(
      shouldWakeDispatcher(
        { kind: "rex.agent_status", sessionId: "s1", paneId: "block:b1", status: "idle" },
        ctx,
      ),
      true,
    );
    assert.equal(
      shouldWakeDispatcher(
        { kind: "rex.agent_status", sessionId: "s1", paneId: "block:other", status: "idle" },
        ctx,
      ),
      false,
    );
    assert.equal(
      shouldWakeDispatcher({ kind: "rex.tab_closed", sessionId: "s1", tabId: "window:w1" }, ctx),
      true,
    );
  });

  it("supervises global + per-session streams and kills process groups on stop", async () => {
    const timers = new ManualTimers();
    const events: SwarmEvent[] = [];
    const killed: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    const spawned: Array<{ args: string[]; child: EventEmitter & TailChild; stdout: PassThrough }> =
      [];
    let nextPid = 500;

    const src = new RexEventSource({
      onEvent: (e) => events.push(e),
      timers,
      healthyAfterMs: 1_000,
      spawner: (_cmd, args) => {
        const em = new EventEmitter() as EventEmitter & TailChild & { pid: number };
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        Object.assign(em, { pid: nextPid++, stdout, stderr });
        spawned.push({ args, child: em, stdout });
        return em;
      },
      killGroup: (pid, sig) => {
        killed.push({ pid, sig });
        const found = spawned.find((s) => s.child.pid === pid);
        found?.child.emit("exit", 0, sig);
      },
    });

    src.start();
    assert.deepEqual(spawned[0]!.args, ["events", "--json"]);
    timers.advance(1_000);
    assert.equal(src.isHealthy, true);
    assert.ok(events.some((e) => e.kind === "source.health" && e.source === "rex" && e.healthy));

    src.setWatchedSessions(["session:s1"]);
    assert.deepEqual(spawned[1]!.args, ["events", "-s", "session:s1", "--json"]);

    const statusLine = readFixtureText("events.ndjson").trim().split("\n")[2]!;
    spawned[1]!.stdout.write(`${statusLine}\n`);
    assert.ok(events.some((e) => e.kind === "rex.agent_status" && e.status === "idle"));

    await src.stop();
    assert.equal(killed.length, 2);
    assert.ok(killed.every((k) => k.sig === "SIGTERM"));
  });
});

describe("apply:worker service PATH for Rex runtime", () => {
  it("resolves runtime binary directory from PATH or explicit path", () => {
    assert.equal(
      resolveRuntimeBinaryDir("/custom/dir/rex", { exists: () => false }),
      "/custom/dir",
    );
    const macRexDir = `/Users/alice/${MACOS_REX_BIN_DIR_REL}`;
    assert.equal(
      resolveRuntimeBinaryDir("rex", {
        pathEnv: `/usr/bin:${macRexDir}:/bin`,
        exists: (p) => p === `${macRexDir}/rex`,
      }),
      macRexDir,
    );
    assert.equal(
      resolveRuntimeBinaryDir("rex", { pathEnv: "/usr/bin:/bin", exists: () => false }),
      null,
    );
  });

  it("includes macOS Rex Server.app CLI dir and extra resolved dirs in launchd plist PATH", () => {
    const macRexDir = `/Users/alice/${MACOS_REX_BIN_DIR_REL}`;
    const plist = renderLaunchdPlist({
      label: "dev.swarm.dispatcher",
      repoRoot: "/repo",
      home: "/Users/alice",
      machine: "mac-worker",
      nodeBin: "/Users/alice/.local/share/mise/shims/node",
      vercelScope: "",
      boardName: "",
      runtimeKind: "rex",
      extraPathDirs: [macRexDir, "/opt/custom/bin"],
    });
    assert.ok(plist.includes(macRexDir));
    assert.ok(plist.includes("/opt/custom/bin"));
    // Deduplicated: macRexDir appears once in PATH
    assert.equal(plist.split(macRexDir).length - 1, 1);

    const herdrPath = buildWorkerServicePath({
      home: "/Users/alice",
      os: "macos",
      runtimeKind: "herdr",
    });
    assert.ok(!herdrPath.includes(MACOS_REX_BIN_DIR_REL));
  });

  it("includes extra runtime dir in Linux systemd unit and quotes PATH if needed", () => {
    const plainUnit = renderSystemdWorkerUnit({
      repoRoot: "/repo",
      machine: "linux-worker",
      vercelScope: "",
      boardName: "",
      runtimeKind: "rex",
      home: "/home/alice",
      extraPathDirs: ["/home/alice/.local/bin", "/opt/rex/bin"],
    });
    assert.ok(
      plainUnit.includes(
        "Environment=PATH=%h/.local/share/mise/shims:%h/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/rex/bin",
      ),
    );

    const spacedUnit = renderSystemdWorkerUnit({
      repoRoot: "/repo",
      machine: "linux-worker",
      vercelScope: "",
      boardName: "",
      runtimeKind: "rex",
      home: "/home/alice",
      extraPathDirs: ["/opt/Rex App/bin"],
    });
    assert.ok(spacedUnit.includes('Environment="PATH='));
    assert.ok(spacedUnit.includes("/opt/Rex App/bin"));
  });
});
