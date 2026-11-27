import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Bus, SourceHealth } from "../src/bus/bus.ts";
import { parseBoardTailLine, type SwarmEvent } from "../src/bus/events.ts";
import { LeadWatcher, loadLeadWatcherState } from "../src/lead-watcher.ts";
import { BoardClient, type BoardThreadSummary, type ExecRunner } from "../src/lib/board.ts";
import { parseSwarmConfig } from "../src/lib/config.ts";
import { HerdrClient } from "../src/lib/herdr.ts";
import {
  collectLeadEvents,
  createEmptyLeadState,
  SEEN_THREAD_RETENTION_MS,
  selectThreadsNeedingRead,
  type LeadWatcherState,
} from "../src/lib/lead-events.ts";
import type { CommandRunner } from "../src/reactors/configured.ts";
import { flushMicrotasks, ManualTimers } from "./helpers/bus-fakes.ts";

const ok = (body: unknown) => ({ stdout: JSON.stringify(body), stderr: "" });

const human = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  text,
  by: { profile: null },
  author: { kind: "person", handle: "owner" },
  ...extra,
});
const agent = (id: string, text: string, profile: string, extra: Record<string, unknown> = {}) => ({
  id,
  text,
  by: { profile },
  author: { kind: "agent", handle: `owner/${profile}`, name: profile },
  ...extra,
});

function tailEvent(obj: Record<string, unknown>): SwarmEvent {
  const res = parseBoardTailLine(JSON.stringify(obj));
  assert.equal(res.kind, "event");
  return (res as { event: SwarmEvent }).event;
}

function postedEvent(cursor: string, message: Record<string, unknown>): SwarmEvent {
  return tailEvent({ cursor, type: "message.posted", payload: {}, message });
}

describe("missed-mention regression (catch-up path)", () => {
  // A worker reply mentioning @lead, immediately followed by another reply, inside one window.
  const threads: Record<string, BoardThreadSummary[]> = {
    "projects/app": [
      {
        message: agent("msg_t_1", "Task", "lead"),
        replies: 3,
        last: agent("msg_t_4", "Still working", "worker-1"),
      },
    ],
  };
  const state: LeadWatcherState = {
    ...createEmptyLeadState(),
    seenThreadLatestMsgId: { msg_t_1: "msg_t_2" },
    seenThreadReplyCount: { msg_t_1: 1 },
  };
  const fullThread = [
    agent("msg_t_1", "Task", "lead"),
    agent("msg_t_2", "Started", "worker-1"),
    agent("msg_t_3", "@lead which API version should I target?", "worker-1"),
    agent("msg_t_4", "Still working", "worker-1"),
  ];
  const base = {
    inboxChannel: "inbox",
    inboxThreads: [],
    projectThreadsByChannel: threads,
    blockedTasks: [],
    leadProfile: "lead",
    state,
  };

  it("loses the mention when only the latest message is inspected (the old behavior)", () => {
    assert.equal(collectLeadEvents(base).events.length, 0);
  });

  it("reads the thread when the reply count jumped and finds the skipped mention", () => {
    assert.deepEqual(
      selectThreadsNeedingRead({ projectThreadsByChannel: threads, leadProfile: "lead", state }),
      ["msg_t_1"],
    );
    const res = collectLeadEvents({ ...base, threadMessages: { msg_t_1: fullThread } });
    assert.deepEqual(
      res.events.map((e) => [e.kind, e.latestMessageId]),
      [["mention", "msg_t_3"]],
    );
    assert.equal(res.nextState.seenThreadLatestMsgId.msg_t_1, "msg_t_4");
    assert.equal(res.nextState.seenThreadReplyCount?.msg_t_1, 3);
    assert.ok(res.nextState.handledMessageIds?.includes("msg_t_3"));

    // Same data again: nothing new, and no read needed.
    assert.deepEqual(
      selectThreadsNeedingRead({
        projectThreadsByChannel: threads,
        leadProfile: "lead",
        state: res.nextState,
      }),
      [],
    );
    assert.equal(collectLeadEvents({ ...base, state: res.nextState }).events.length, 0);
  });

  it("does not read threads that advanced by one or whose latest message already wakes Lead", () => {
    const one = { "projects/app": [{ ...threads["projects/app"]![0]!, replies: 2 }] };
    assert.deepEqual(
      selectThreadsNeedingRead({ projectThreadsByChannel: one, leadProfile: "lead", state }),
      [],
    );
    const mentioning = {
      "projects/app": [
        { ...threads["projects/app"]![0]!, last: agent("msg_t_4", "@lead done?", "worker-1") },
      ],
    };
    assert.deepEqual(
      selectThreadsNeedingRead({ projectThreadsByChannel: mentioning, leadProfile: "lead", state }),
      [],
    );
  });

  it("prunes seen markers that have not been refreshed for the retention window", () => {
    const now = 10 * SEEN_THREAD_RETENTION_MS;
    const res = collectLeadEvents({
      ...base,
      projectThreadsByChannel: {},
      state: {
        ...createEmptyLeadState(),
        seenThreadLatestMsgId: { old: "old_2", fresh: "fresh_1", legacy: "legacy_1" },
        seenThreadReplyCount: { old: 1 },
        seenThreadLastSeenMs: { old: now - SEEN_THREAD_RETENTION_MS - 1, fresh: now - 1_000 },
      },
      nowMs: now,
    });
    assert.deepEqual(Object.keys(res.nextState.seenThreadLatestMsgId).toSorted(), [
      "fresh",
      "legacy",
    ]);
    assert.equal(
      res.nextState.seenThreadLastSeenMs?.legacy,
      now,
      "legacy entries start their clock",
    );
    assert.equal(res.nextState.seenThreadReplyCount?.old, undefined);
  });
});

// ---------------------------------------------------------------------------
// LeadWatcher on the bus
// ---------------------------------------------------------------------------

function fakeHerdr() {
  let seq = 0;
  const prompted: Array<{ name: string; prompt: string }> = [];
  const agents: Array<{ name: string; pane_id: string; tab_id: string; agent_status: string }> = [];
  const runner: ExecRunner = async (_cmd, args) => {
    const [group, sub] = args;
    if (group === "workspace" && sub === "list")
      return ok({ result: { workspaces: [{ workspace_id: "wHQ", label: "swarm-hq" }] } });
    if (group === "tab" && sub === "create") {
      seq += 1;
      return ok({
        result: {
          tab: { tab_id: `wHQ:t${seq}`, workspace_id: "wHQ" },
          root_pane: { pane_id: `wHQ:p${seq}` },
        },
      });
    }
    if (group === "agent" && sub === "get") throw new Error("not found");
    if (group === "agent" && sub === "start") {
      const paneId = args[args.indexOf("--pane") + 1]!;
      agents.push({
        name: args[2]!,
        pane_id: paneId,
        tab_id: paneId.replace(":p", ":t"),
        agent_status: "working",
      });
      return ok({ result: {} });
    }
    if (group === "agent" && sub === "prompt") {
      prompted.push({ name: args[2]!, prompt: args[3]! });
      return ok({ result: {} });
    }
    if (group === "agent" && sub === "list") return ok({ result: { agents } });
    if (group === "tab" && sub === "list")
      return ok({
        result: {
          tabs: agents.map((a) => ({ tab_id: a.tab_id, workspace_id: "wHQ", label: a.name })),
        },
      });
    return ok({ result: {} });
  };
  return { herdr: new HerdrClient({ target: "local" }, runner), prompted };
}

function fakeBoard(inboxThreads: () => BoardThreadSummary[]) {
  const calls: string[][] = [];
  const reacted: string[] = [];
  const runner: ExecRunner = async (_cmd, args) => {
    calls.push(args);
    const [, group, target] = args;
    if (group === "read" && target === "inbox") return ok({ threads: inboxThreads(), cursor: "c" });
    if (group === "read") {
      const t = inboxThreads().find((x) => x.message.id === target);
      return ok({
        message: t?.message ?? { id: target, text: "" },
        replies: t?.last ? [t.last] : [],
      });
    }
    if (group === "react") {
      reacted.push(target!);
      return ok({ ok: true });
    }
    if (group === "channels") return ok({ channels: [] });
    if (group === "tasks") return ok({ tasks: [] });
    return ok({ ok: true });
  };
  return {
    board: new BoardClient({}, runner),
    calls,
    reacted,
    readsOf: (target: string) => calls.filter((c) => c[1] === "read" && c[2] === target).length,
  };
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function setup(
  opts: {
    inbox?: () => BoardThreadSummary[];
    state?: LeadWatcherState;
    reactors?: unknown[];
    commandRunner?: CommandRunner;
  } = {},
) {
  const tmp = mkdtempSync(join(tmpdir(), "lead-bus-"));
  const statePath = join(tmp, "state.json");
  if (opts.state) writeFileSync(statePath, JSON.stringify(opts.state));
  const swarm = parseSwarmConfig({
    lead: { pollIntervalSeconds: 10, reconcileIntervalSeconds: 60, idleCloseSeconds: 15 },
    machines: { main: { role: "main", os: "linux" } },
    ...(opts.reactors ? { reactors: opts.reactors } : {}),
  });
  const board = fakeBoard(opts.inbox ?? (() => []));
  const herdr = fakeHerdr();
  const bus = new Bus();
  const health = new SourceHealth();
  health.enable("board");
  const timers = new ManualTimers();
  let clock = 1_000_000;
  const watcher = new LeadWatcher({
    swarm,
    board: board.board,
    herdr: herdr.herdr,
    statePath,
    leadWorkspaceDir: tmp,
    dryRun: false,
    now: () => clock,
    events: { bus, health, paneWatcher: null },
    timers,
    commandRunner: opts.commandRunner,
  });
  let loop: Promise<void> | null = null;
  const start = () => {
    loop = watcher.runLoop(false);
    bus.publish({ kind: "source.health", source: "board", healthy: true, detail: "test" });
  };
  cleanups.push(async () => {
    watcher.requestStop();
    await loop;
    rmSync(tmp, { recursive: true, force: true });
  });
  return {
    watcher,
    board,
    herdr,
    bus,
    timers,
    statePath,
    start,
    advanceClock: (ms: number) => {
      clock += ms;
    },
  };
}

const settle = () => flushMicrotasks(60);

describe("LeadWatcher on the bus", () => {
  it("acknowledges and wakes Lead from a live #inbox post without reading any channel", async () => {
    const t = setup();
    t.start();
    await settle();
    const readsAfterStartup = t.board.calls.length;

    t.bus.publish(
      postedEvent("c-1", { ...human("msg_aaa11111_1", "Add a status badge"), channel: "inbox" }),
    );
    t.timers.advance(250);
    await settle();

    assert.deepEqual(t.board.reacted, ["msg_aaa11111_1"]);
    assert.equal(t.herdr.prompted.length, 1);
    assert.equal(t.herdr.prompted[0]?.name, "lead-aaa11111");
    const newCalls = t.board.calls.slice(readsAfterStartup);
    assert.equal(
      newCalls.filter((c) => c[1] === "read" || c[1] === "channels").length,
      0,
      JSON.stringify(newCalls),
    );

    const persisted = loadLeadWatcherState(t.statePath);
    assert.equal(persisted.tailCursor, "c-1");
    assert.ok(persisted.handledMessageIds?.includes("msg_aaa11111_1"));
  });

  it("wakes on live @lead mentions and blocked tasks, ignores its own posts and noise", async () => {
    const t = setup();
    t.start();
    await settle();
    t.bus.publish(
      postedEvent("c-1", {
        ...agent("msg_bbb22222_3", "@lead need a decision", "worker-1"),
        channel: "projects/app",
        re: "msg_bbb22222_1",
      }),
    );
    t.bus.publish(
      postedEvent("c-2", {
        ...agent("msg_bbb22222_4", "Thanks @lead", "lead"),
        channel: "projects/app",
        re: "msg_bbb22222_1",
      }),
    );
    t.bus.publish(postedEvent("c-3", { ...human("msg_zzz_1", "hello"), channel: "random" }));
    t.bus.publish(
      tailEvent({
        cursor: "c-4",
        type: "task.blocked",
        payload: {},
        message: {
          id: "msg_ccc33333_1",
          channel: "projects/app",
          text: "Need key",
          task: { state: "blocked" },
        },
      }),
    );
    t.timers.advance(250);
    await settle();
    const prompts = t.herdr.prompted.map((p) => p.prompt).join("\n");
    assert.match(prompts, /\[MENTION\].*msg_bbb22222_1/);
    assert.doesNotMatch(prompts, /Thanks @lead/);
    // Blocked task is queued (maxConcurrentSessions=1 serializes), not lost.
    const state = loadLeadWatcherState(t.statePath);
    assert.ok(state.seenBlockedTaskIds.includes("msg_ccc33333_1"));
    assert.equal(state.pendingByThread.msg_ccc33333_1?.[0]?.kind, "blocked_task");
    assert.equal(state.tailCursor, "c-4");
    assert.deepEqual(t.board.reacted, [], "only human #inbox posts get 👀");
  });

  it("does not report a live-handled message again on the periodic catch-up, nor on replay", async () => {
    const root = human("msg_ddd44444_1", "Ship it");
    const t = setup({ inbox: () => [{ message: root, replies: 0, last: null }] });
    t.start();
    await settle();
    // Startup catch-up found the thread once.
    assert.equal(t.herdr.prompted.length, 1);

    // The same message arrives live (e.g. replayed after `--after`): handled already.
    t.bus.publish(postedEvent("c-9", { ...root, channel: "inbox" }));
    t.timers.advance(250);
    await settle();
    // Periodic catch-up (interval is the poll cadence while a session is open).
    t.timers.advance(10_000);
    await settle();
    assert.equal(t.herdr.prompted.length, 1);
    assert.deepEqual(t.board.reacted, ["msg_ddd44444_1"]);
  });

  it("resumes from the persisted cursor and falls back to a full catch-up when it is rejected", async () => {
    const t = setup({ state: { ...createEmptyLeadState(), tailCursor: "saved-cursor" } });
    assert.equal(t.watcher.tailCursor, "saved-cursor");
    t.start();
    await settle();
    const inboxReads = t.board.readsOf("inbox");
    assert.equal(inboxReads, 1, "startup tick is a full catch-up");

    t.watcher.onTailCursorRejected();
    assert.equal(t.watcher.tailCursor, undefined);
    assert.equal(loadLeadWatcherState(t.statePath).tailCursor, undefined);
    t.timers.advance(250);
    await settle();
    assert.equal(t.board.readsOf("inbox"), 2, "rejected cursor forces a catch-up reconcile");
  });

  it("uses the slow interval only when idle and healthy", async () => {
    const t = setup();
    assert.equal(t.watcher.currentIntervalMs(), 10_000, "not started: no healthy source");
    t.start();
    await settle();
    assert.equal(t.watcher.currentIntervalMs(), 60_000);
    t.bus.publish({ kind: "source.health", source: "board", healthy: false, detail: "down" });
    assert.equal(t.watcher.currentIntervalMs(), 10_000);
  });

  it("runs a configured command reactor for a live event, after triage", async () => {
    const ran: Array<{ argv: readonly string[]; stdin: string }> = [];
    const t = setup({
      reactors: [
        { name: "notify-blocked", on: "task.blocked", run: { command: ["notify", "--now"] } },
      ],
      commandRunner: async (argv, o) => {
        ran.push({ argv, stdin: o.stdin });
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    assert.ok(t.watcher.reactors.names.includes("config:notify-blocked"));
    t.start();
    await settle();
    t.bus.publish(
      tailEvent({
        cursor: "c-1",
        type: "task.blocked",
        payload: {},
        message: {
          id: "msg_eee55555_1",
          channel: "projects/app",
          text: "Need key",
          task: { state: "blocked" },
        },
      }),
    );
    t.timers.advance(250);
    await settle();
    assert.equal(ran.length, 1);
    assert.deepEqual(ran[0]?.argv, ["notify", "--now"]);
    assert.match(ran[0]?.stdin ?? "", /"msg_eee55555_1"/);
  });

  it("loads a pre-bus state file unchanged (tolerant loader)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lead-legacy-"));
    try {
      const p = join(tmp, "s.json");
      writeFileSync(
        p,
        JSON.stringify({
          seenThreadLatestMsgId: { a: "a_2" },
          seenBlockedTaskIds: ["b"],
          pendingByThread: {},
        }),
      );
      const s = loadLeadWatcherState(p);
      assert.deepEqual(s.seenThreadLatestMsgId, { a: "a_2" });
      assert.deepEqual(s.seenBlockedTaskIds, ["b"]);
      assert.equal(s.tailCursor, undefined);
      assert.deepEqual(s.handledMessageIds, []);
      writeFileSync(p, JSON.stringify({ tailCursor: 42, handledMessageIds: ["x", 3] }));
      const s2 = loadLeadWatcherState(p);
      assert.equal(s2.tailCursor, undefined);
      assert.deepEqual(s2.handledMessageIds, ["x"]);
      assert.equal(readFileSync(p, "utf8").length > 0, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
