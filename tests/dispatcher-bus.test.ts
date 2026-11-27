import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Bus, SourceHealth } from "../src/bus/bus.ts";
import type { PaneWatcher } from "../src/bus/daemon-events.ts";
import { parseBoardTailLine, type SwarmEvent } from "../src/bus/events.ts";
import { SwarmDispatcher } from "../src/dispatcher.ts";
import { BoardClient, type ExecRunner } from "../src/lib/board.ts";
import { parseSwarmConfig, type ProjectsConfig } from "../src/lib/config.ts";
import { HerdrClient } from "../src/lib/herdr.ts";
import { shouldWakeDispatcher } from "../src/reactors/dispatcher-wake.ts";
import { flushMicrotasks, ManualTimers } from "./helpers/bus-fakes.ts";

const ok = (body: unknown = { ok: true }) => ({ stdout: JSON.stringify(body), stderr: "" });

interface Task {
  id: string;
  channel: string;
  state: string;
  assignee?: string;
}

function fakeBoard() {
  const tasks = new Map<string, Task>();
  const claims: string[] = [];
  const wire = (t: Task) => ({
    message: {
      id: t.id,
      channel: t.channel,
      text: `task ${t.id}`,
      labels: {},
      task: { state: t.state, claim: t.assignee ? { actor: `vercel:user:u+${t.assignee}` } : null },
    },
    replies: 0,
  });
  const runner: ExecRunner = async (_cmd, args) => {
    const [, group, sub, id] = args;
    if (group === "tasks" && sub?.endsWith("/")) {
      const open = [...tasks.values()].filter((t) =>
        ["ready", "claimed", "blocked"].includes(t.state),
      );
      return ok({ tasks: open.map(wire), cursor: null });
    }
    if (group === "tasks" && sub === "claim" && id) {
      const t = tasks.get(id)!;
      t.state = "claimed";
      t.assignee = args[args.indexOf("--as") + 1];
      claims.push(id);
      return ok(wire(t));
    }
    if (group === "read" && sub && tasks.has(sub))
      return ok({ ...wire(tasks.get(sub)!), replies: [] });
    if (group === "read") return ok({ threads: [], cursor: null });
    return ok({ message: { id: "m1" } });
  };
  return { tasks, claims, runner };
}

function fakeHerdr() {
  let seq = 0;
  const agents: Array<{ pane_id: string; tab_id: string; name: string; agent_status: string }> = [];
  const tabs: Array<{ tab_id: string; workspace_id: string; label: string }> = [];
  const runner: ExecRunner = async (_cmd, args) => {
    const [group, sub] = args;
    if (group === "workspace" && sub === "list")
      return ok({ result: { workspaces: [{ workspace_id: "w1", label: "repo-a" }] } });
    if (group === "tab" && sub === "create") {
      seq += 1;
      tabs.push({ tab_id: `w1:t${seq}`, workspace_id: "w1", label: "x" });
      return ok({
        result: {
          tab: { tab_id: `w1:t${seq}`, workspace_id: "w1" },
          root_pane: { pane_id: `w1:p${seq}` },
        },
      });
    }
    if (group === "agent" && sub === "start") {
      const paneId = args[args.indexOf("--pane") + 1]!;
      agents.push({
        pane_id: paneId,
        tab_id: paneId.replace(":p", ":t"),
        name: args[2]!,
        agent_status: "working",
      });
      return ok({ result: {} });
    }
    if (group === "agent" && sub === "list") return ok({ result: { agents } });
    if (group === "tab" && sub === "list") return ok({ result: { tabs } });
    return ok({ result: {} });
  };
  return { runner, agents };
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function setup(opts: { healthy: boolean }) {
  const tmp = mkdtempSync(join(tmpdir(), "dispatcher-bus-"));
  mkdirSync(join(tmp, "repo-a"));
  const swarm = parseSwarmConfig({
    board: { scope: "team" },
    workerDefaults: { pollIntervalSeconds: 15, reconcileIntervalSeconds: 60 },
    machines: { "worker-machine": { role: "worker", os: "linux", maxWorkers: 2 } },
  });
  const projects: ProjectsConfig = {
    projects: {
      "repo-a": {
        defaultMachine: "worker-machine",
        baseBranch: "main",
        useWorktree: false,
        paths: { "worker-machine": join(tmp, "repo-a") },
      },
    },
  };
  const board = fakeBoard();
  const herdr = fakeHerdr();
  const bus = new Bus();
  const health = new SourceHealth();
  health.enable("board");
  health.enable("herdr");
  const watched: string[][] = [];
  const paneWatcher: PaneWatcher = { setWatchedPanes: (ids) => watched.push([...ids]) };
  const timers = new ManualTimers();
  const dispatcher = new SwarmDispatcher({
    repoRoot: tmp,
    swarm,
    projects,
    machineName: "worker-machine",
    board: new BoardClient({ scope: "team" }, board.runner),
    herdr: new HerdrClient({ target: "local" }, herdr.runner),
    promptTemplate: "Work on {{TASK_ID}}",
    availableAgentKinds: new Set(["claude"]),
    dryRun: false,
    events: { bus, health, paneWatcher },
    timers,
  });
  // runLoop subscribes to the bus synchronously, before its first await.
  const loop = dispatcher.runLoop(false);
  if (opts.healthy) {
    for (const source of ["board", "herdr"] as const) {
      bus.publish({ kind: "source.health", source, healthy: true, detail: "test" });
    }
  }
  cleanups.push(async () => {
    dispatcher.requestStop();
    await loop;
    rmSync(tmp, { recursive: true, force: true });
  });
  return { dispatcher, board, herdr, bus, timers, watched };
}

/** Lets an in-flight tick (many awaited fake CLI calls) finish. */
async function settle(): Promise<void> {
  await flushMicrotasks(50);
}

function readyEvent(id: string): SwarmEvent {
  const res = parseBoardTailLine(
    JSON.stringify({
      cursor: `c-${id}`,
      type: "task.created",
      payload: { id },
      message: { id, channel: "projects/repo-a", text: "t", labels: {}, task: { state: "ready" } },
    }),
  );
  assert.equal(res.kind, "event");
  return (res as { event: SwarmEvent }).event;
}

describe("SwarmDispatcher on the bus", () => {
  it("claims a task as soon as a task event arrives, without waiting for the interval", async () => {
    const { board, bus, timers } = setup({ healthy: true });
    await settle();
    assert.deepEqual(board.claims, []);

    board.tasks.set("msg_t1_1", { id: "msg_t1_1", channel: "projects/repo-a", state: "ready" });
    timers.advance(10_000);
    await settle();
    assert.deepEqual(board.claims, [], "no periodic tick yet (healthy interval is 60s)");

    bus.publish(readyEvent("msg_t1_1"));
    timers.advance(250);
    await settle();
    assert.deepEqual(board.claims, ["msg_t1_1"]);
  });

  it("subscribes to the panes of tracked sessions after each tick", async () => {
    const { board, bus, timers, watched } = setup({ healthy: true });
    await settle();
    board.tasks.set("msg_t2_1", { id: "msg_t2_1", channel: "projects/repo-a", state: "ready" });
    bus.publish(readyEvent("msg_t2_1"));
    timers.advance(250);
    await settle();
    assert.deepEqual(watched.at(-1), ["w1:p1"]);
  });

  it("wakes on a status change of a tracked pane but ignores untracked panes", async () => {
    const { dispatcher, board, bus, timers } = setup({ healthy: true });
    await settle();
    board.tasks.set("msg_t3_1", { id: "msg_t3_1", channel: "projects/repo-a", state: "ready" });
    bus.publish(readyEvent("msg_t3_1"));
    timers.advance(250);
    await settle();
    assert.equal(dispatcher.activeWorkers.size, 1);

    const before = timers.pendingDelays();
    bus.publish({ kind: "herdr.agent_status", paneId: "w9:p9", status: "idle", agent: null });
    assert.deepEqual(timers.pendingDelays(), before, "untracked pane: no wake scheduled");
    bus.publish({ kind: "herdr.agent_status", paneId: "w1:p1", status: "idle", agent: null });
    assert.ok(timers.pendingDelays().includes(250), "tracked pane: debounced wake scheduled");
  });

  it("with sources unhealthy, behaves like the old poll loop (pollIntervalSeconds)", async () => {
    const { dispatcher, board, timers } = setup({ healthy: false });
    await settle();
    assert.equal(dispatcher.currentIntervalMs(), 15_000);
    board.tasks.set("msg_t4_1", { id: "msg_t4_1", channel: "projects/repo-a", state: "ready" });
    timers.advance(14_999);
    await settle();
    assert.deepEqual(board.claims, []);
    timers.advance(1);
    await settle();
    assert.deepEqual(board.claims, ["msg_t4_1"]);
  });

  it("drops back to polling when a source goes down and recovers when it returns", async () => {
    const { dispatcher, bus } = setup({ healthy: true });
    await settle();
    assert.equal(dispatcher.currentIntervalMs(), 60_000);
    bus.publish({ kind: "source.health", source: "board", healthy: false, detail: "exit" });
    assert.equal(dispatcher.currentIntervalMs(), 15_000);
    bus.publish({ kind: "source.health", source: "board", healthy: true, detail: "up" });
    assert.equal(dispatcher.currentIntervalMs(), 60_000);
  });
});

describe("shouldWakeDispatcher", () => {
  const ctx = {
    projectChannelPrefix: "projects/",
    trackedTaskIds: new Set(["msg_tracked_1"]),
    trackedPaneIds: new Set(["w1:p1"]),
    trackedTabIds: new Set(["w1:t1"]),
    projectsConfigPath: "/cfg/projects.json",
  };
  const taskEvent = (id: string, op: string, channel = "projects/a"): SwarmEvent => ({
    kind: "board.task",
    op: op as never,
    type: `task.${op}`,
    task: { id, channel, state: "ready", text: "", labels: {}, raw: {} },
    message: null,
    cursor: "c",
  });

  it("wakes for claimable work in scope and for anything on tracked tasks", () => {
    assert.equal(shouldWakeDispatcher(taskEvent("msg_x_1", "ready"), ctx), true);
    assert.equal(shouldWakeDispatcher(taskEvent("msg_x_1", "expired"), ctx), true);
    assert.equal(shouldWakeDispatcher(taskEvent("msg_x_1", "claimed"), ctx), false);
    assert.equal(shouldWakeDispatcher(taskEvent("msg_x_1", "ready", "inbox"), ctx), false);
    assert.equal(shouldWakeDispatcher(taskEvent("msg_tracked_1", "completed"), ctx), true);
  });

  it("wakes for replies in tracked threads, tracked panes/tabs, and projects.json changes", () => {
    const reply = (re: string): SwarmEvent => ({
      kind: "board.message",
      op: "posted",
      message: { id: `${re}-r`, text: "STATUS: READY_FOR_REVIEW", re },
      cursor: "c",
    });
    assert.equal(shouldWakeDispatcher(reply("msg_tracked_1"), ctx), true);
    assert.equal(shouldWakeDispatcher(reply("msg_other_1"), ctx), false);
    assert.equal(shouldWakeDispatcher({ kind: "herdr.pane_exited", paneId: "w1:p1" }, ctx), true);
    assert.equal(shouldWakeDispatcher({ kind: "herdr.tab_closed", tabId: "w1:t2" }, ctx), false);
    assert.equal(
      shouldWakeDispatcher({ kind: "fs.changed", path: "/cfg/projects.json" }, ctx),
      true,
    );
    assert.equal(shouldWakeDispatcher({ kind: "fs.changed", path: "/cfg/swarm.json" }, ctx), false);
    assert.equal(shouldWakeDispatcher({ kind: "timer.reconcile" }, ctx), false);
  });
});
