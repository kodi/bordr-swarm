import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { BoardTailSource } from "../src/bus/board-tail-source.ts";
import {
  LineSplitter,
  parseBoardTailLine,
  parseHerdrEventLine,
  threadRootId,
  type SwarmEvent,
} from "../src/bus/events.ts";
import { BoardClient } from "../src/lib/board.ts";
import { createFakeTailProcesses, flushMicrotasks, ManualTimers } from "./helpers/bus-fakes.ts";

const FIXTURE = resolve(import.meta.dirname, "fixtures/board-tail-sample.ndjson");
const sampleLines = readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean);

function sample(type: string): string {
  const line = sampleLines.find((l) => (JSON.parse(l) as { type: string }).type === type);
  assert.ok(line, `fixture has a ${type} event`);
  return line;
}

function parsedEvent(line: string): SwarmEvent {
  const res = parseBoardTailLine(line);
  assert.equal(res.kind, "event");
  return (res as { kind: "event"; event: SwarmEvent }).event;
}

describe("Board tail line parser", () => {
  it("parses every sanitized live sample without throwing", () => {
    for (const line of sampleLines) {
      const res = parseBoardTailLine(line);
      assert.equal(res.kind, "event", line.slice(0, 80));
    }
  });

  it("maps message.posted to board.message with the reply's root", () => {
    const ev = parsedEvent(sample("message.posted"));
    assert.equal(ev.kind, "board.message");
    if (ev.kind !== "board.message") return;
    assert.equal(ev.op, "posted");
    assert.equal(ev.message.channel, "projects/example-app");
    assert.match(ev.message.id, /_2$/);
    assert.equal(threadRootId(ev.message), ev.message.re);
    assert.equal(ev.message.by?.profile, "worker-worker-machine-f86bbe3b");
    assert.ok(ev.cursor.startsWith("x1."));
  });

  it("maps message.edited and keeps the message snapshot", () => {
    const ev = parsedEvent(sample("message.edited"));
    assert.equal(ev.kind, "board.message");
    if (ev.kind === "board.message") {
      assert.equal(ev.op, "edited");
      assert.equal(ev.message.channel, "swarm/registry");
    }
  });

  it("maps every observed task type to a typed op with the normalized task", () => {
    const expected: Record<string, string> = {
      "task.created": "ready",
      "task.claimed": "claimed",
      "task.ready": "ready",
      "task.completed": "completed",
      "task.failed": "failed",
      "task.blocked": "blocked",
      "task.expired": "ready",
      "task.released": "ready",
      "task.canceled": "canceled",
    };
    for (const [type, state] of Object.entries(expected)) {
      const ev = parsedEvent(sample(type));
      assert.equal(ev.kind, "board.task", type);
      if (ev.kind !== "board.task") continue;
      assert.equal(ev.op, type.slice("task.".length));
      assert.equal(ev.type, type);
      assert.equal(ev.task.state, state, type);
      assert.match(ev.task.id, /^msg_.*_1$/);
    }
    const claimed = parsedEvent(sample("task.claimed"));
    assert.equal(
      claimed.kind === "board.task" ? claimed.task.assignee : "",
      "worker-worker-machine-00577191",
    );
  });

  it("maps reaction.added to board.reaction", () => {
    const ev = parsedEvent(sample("reaction.added"));
    assert.equal(ev.kind, "board.reaction");
    if (ev.kind === "board.reaction") {
      assert.equal(ev.emoji, "eyes");
      assert.equal(ev.channel, "inbox");
      assert.ok(ev.messageId);
    }
  });

  it("tolerates unknown types, blank lines, noise, and envelopes without a cursor", () => {
    const unknownTask = parseBoardTailLine(
      JSON.stringify({
        cursor: "c9",
        type: "task.teleported",
        payload: { id: "msg_x_1" },
        message: { id: "msg_x_1", channel: "projects/a", text: "t", task: { state: "ready" } },
      }),
    );
    assert.equal(unknownTask.kind, "event");
    if (unknownTask.kind === "event" && unknownTask.event.kind === "board.task") {
      assert.equal(unknownTask.event.op, "other");
    } else {
      assert.fail("expected board.task");
    }

    const unknownFamily = parseBoardTailLine(
      JSON.stringify({ cursor: "c1", type: "channel.created" }),
    );
    assert.deepEqual(unknownFamily, {
      kind: "event",
      event: { kind: "board.other", type: "channel.created", cursor: "c1" },
    });

    assert.equal(parseBoardTailLine("").kind, "skip");
    assert.equal(parseBoardTailLine('<claude-code-hint v="1" />').kind, "skip");
    assert.equal(parseBoardTailLine("{not json").kind, "skip");
    assert.equal(parseBoardTailLine(JSON.stringify({ type: "message.posted" })).kind, "skip");
  });

  it("recognizes the CLI's rejected-cursor error", () => {
    assert.deepEqual(parseBoardTailLine('  "reason": "invalid_cursor",'), {
      kind: "cursor_rejected",
    });
  });

  it("splits partial chunks into whole lines", () => {
    const splitter = new LineSplitter();
    assert.deepEqual(splitter.push('{"a":'), []);
    assert.deepEqual(splitter.push('1}\n{"b":2}\r\n{"c"'), ['{"a":1}', '{"b":2}']);
    assert.deepEqual(splitter.push(":3}\n\n"), ['{"c":3}', ""]);
    assert.equal(splitter.flush(), "");
  });
});

describe("Herdr event line parser", () => {
  it("parses the event lines observed on herdr 0.9.5", () => {
    assert.deepEqual(
      parseHerdrEventLine({
        data: { tab_id: "w7:t4", type: "tab_closed", workspace_id: "w7" },
        event: "tab_closed",
      }),
      { kind: "herdr.tab_closed", tabId: "w7:t4" },
    );
    assert.deepEqual(
      parseHerdrEventLine({
        data: { pane_id: "w7:p6", type: "pane_exited" },
        event: "pane_exited",
      }),
      { kind: "herdr.pane_exited", paneId: "w7:p6" },
    );
    assert.deepEqual(
      parseHerdrEventLine({
        event: "pane.agent_status_changed",
        data: { pane_id: "w1:p2", workspace_id: "w1", agent_status: "idle", agent: "claude" },
      }),
      { kind: "herdr.agent_status", paneId: "w1:p2", status: "idle", agent: "claude" },
    );
  });

  it("ignores responses, unknown events, and malformed data", () => {
    assert.equal(parseHerdrEventLine({ id: "x", result: { type: "subscription_started" } }), null);
    assert.equal(parseHerdrEventLine({ event: "workspace_created", data: {} }), null);
    assert.equal(parseHerdrEventLine({ event: "tab_closed", data: {} }), null);
    assert.equal(parseHerdrEventLine("nope"), null);
    const weird = parseHerdrEventLine({
      event: "pane_agent_status_changed",
      data: { pane_id: "p", agent_status: "dancing" },
    });
    assert.deepEqual(weird, {
      kind: "herdr.agent_status",
      paneId: "p",
      status: "unknown",
      agent: null,
    });
  });
});

describe("BoardTailSource supervisor", () => {
  const board = new BoardClient({ scope: "team", boardName: "swarm" });

  function setup(opts: { after?: string; stallTimeoutMs?: number } = {}) {
    const timers = new ManualTimers();
    const procs = createFakeTailProcesses();
    const events: SwarmEvent[] = [];
    const rejected: string[] = [];
    const source = new BoardTailSource({
      board,
      after: opts.after,
      onEvent: (ev) => events.push(ev),
      onCursorRejected: (c) => rejected.push(c),
      spawner: procs.spawner,
      killGroup: procs.killGroup,
      timers,
      backoffInitialMs: 1_000,
      backoffMaxMs: 8_000,
      healthyAfterMs: 2_000,
      stallTimeoutMs: opts.stallTimeoutMs ?? 0,
    });
    return { timers, procs, events, rejected, source };
  }

  it("spawns tail with the BoardClient's scope/name args and --after", () => {
    const { procs, source } = setup({ after: "x1.cursor" });
    source.start();
    assert.equal(procs.spawns.length, 1);
    assert.equal(procs.spawns[0]?.cmd, "vercel");
    assert.deepEqual(procs.spawns[0]?.args, [
      "board",
      "tail",
      "--after",
      "x1.cursor",
      "--json",
      "--name",
      "swarm",
      "--scope",
      "team",
    ]);
    const vb = new BoardClient({ url: "http://board/api", binary: "vb" });
    assert.deepEqual(vb.buildTailCommand({ channel: "#projects/" }).args, [
      "tail",
      "projects/",
      "--json",
      "--url",
      "http://board/api",
    ]);
  });

  it("emits parsed events, tracks the cursor, and reports health once", async () => {
    const { procs, events, source } = setup();
    source.start();
    const child = procs.spawns[0]!.child;
    const line = sample("task.ready");
    child.stdout.write(line.slice(0, 20));
    child.stdout.write(`${line.slice(20)}\n`);
    child.emitLine(sample("message.posted"));
    await flushMicrotasks();

    assert.deepEqual(
      events.map((e) => e.kind),
      ["source.health", "board.task", "board.message"],
    );
    assert.equal(source.isHealthy, true);
    assert.equal(
      source.cursor,
      (JSON.parse(sample("message.posted")) as { cursor: string }).cursor,
    );
    await source.stop();
  });

  it("restarts with capped exponential backoff and resumes from the last cursor", async () => {
    const { timers, procs, events, source } = setup();
    source.start();
    procs.spawns[0]!.child.emitLine({
      cursor: "c-1",
      type: "task.ready",
      payload: { id: "msg_a_1" },
    });
    await flushMicrotasks();

    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      procs.spawns.at(-1)!.child.exit(1);
      delays.push(timers.pendingDelays().at(-1)!);
      timers.advance(delays.at(-1)!);
    }
    assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 8_000]);
    assert.equal(procs.spawns.length, 6);
    assert.deepEqual(procs.spawns.at(-1)!.args.slice(0, 4), ["board", "tail", "--after", "c-1"]);
    const health = events.filter((e) => e.kind === "source.health");
    assert.deepEqual(
      health.map((e) => (e.kind === "source.health" ? e.healthy : null)),
      [true, false],
    );

    // Staying up past healthyAfterMs recovers health and resets the backoff.
    timers.advance(2_000);
    assert.equal(source.isHealthy, true);
    procs.spawns.at(-1)!.child.exit(1);
    assert.equal(timers.pendingDelays().at(-1), 1_000);
    await source.stop();
    assert.equal(timers.pendingCount, 0);
  });

  it("drops a rejected cursor and restarts without --after", async () => {
    const { procs, rejected, source } = setup({ after: "stale" });
    source.start();
    const child = procs.spawns[0]!.child;
    child.stdout.write('{\n  "status": "error",\n  "reason": "invalid_cursor",\n}\n');
    await flushMicrotasks();
    child.exit(2);
    assert.deepEqual(rejected, ["stale"]);
    assert.equal(procs.spawns.length, 2);
    assert.ok(!procs.spawns[1]!.args.includes("--after"));
    assert.equal(source.cursor, undefined);
    await source.stop();
  });

  it("restarts quietly when the stream stalls", async () => {
    const { timers, procs, events, source } = setup({ stallTimeoutMs: 60_000 });
    source.start();
    timers.advance(2_000);
    procs.spawns[0]!.child.emitLine({
      cursor: "c-7",
      type: "task.ready",
      payload: { id: "msg_a_1" },
    });
    await flushMicrotasks();
    timers.advance(60_000);
    assert.equal(procs.kills.length, 1);
    await flushMicrotasks();
    assert.equal(procs.spawns.length, 2);
    assert.ok(procs.spawns[1]!.args.includes("c-7"));
    assert.equal(
      events.filter((e) => e.kind === "source.health" && !e.healthy).length,
      0,
      "a watchdog restart is not an outage",
    );
    await source.stop();
  });

  it("kills the process group on stop, escalating to SIGKILL, and leaves nothing behind", async () => {
    const timers = new ManualTimers();
    const procs = createFakeTailProcesses({ exitOnKill: false });
    const source = new BoardTailSource({
      board,
      onEvent: () => {},
      spawner: procs.spawner,
      killGroup: procs.killGroup,
      timers,
      stopTimeoutMs: 500,
      stallTimeoutMs: 0,
    });
    source.start();
    const stopped = source.stop();
    assert.deepEqual(
      procs.kills.map((k) => k.signal),
      ["SIGTERM"],
    );
    timers.advance(500);
    await stopped;
    assert.deepEqual(
      procs.kills.map((k) => k.signal),
      ["SIGTERM", "SIGKILL"],
    );
    assert.equal(procs.kills[0]?.pid, procs.spawns[0]?.child.pid);
    // A late exit after stop must not restart anything.
    procs.spawns[0]!.child.exit(null, "SIGKILL");
    assert.equal(procs.spawns.length, 1);
    assert.equal(timers.pendingCount, 0);
  });

  it("stop() during backoff cancels the pending restart", async () => {
    const { timers, procs, source } = setup();
    source.start();
    procs.spawns[0]!.child.exit(1);
    assert.equal(timers.pendingCount, 1);
    await source.stop();
    assert.equal(timers.pendingCount, 0);
    timers.advance(60_000);
    assert.equal(procs.spawns.length, 1);
    assert.equal(procs.live().length, 0);
  });
});
