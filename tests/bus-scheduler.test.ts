import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Bus, selectReconcileIntervalMs, SourceHealth } from "../src/bus/bus.ts";
import type { SwarmEvent } from "../src/bus/events.ts";
import { FsWatchSource } from "../src/bus/fs-watch-source.ts";
import { WakeScheduler, type WakeRunInfo } from "../src/bus/scheduler.ts";
import { flushMicrotasks, ManualTimers } from "./helpers/bus-fakes.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(intervalMs: () => number = () => 60_000) {
  const timers = new ManualTimers();
  const runs: WakeRunInfo[] = [];
  let gate: ReturnType<typeof deferred> | null = null;
  let concurrent = 0;
  let maxConcurrent = 0;
  const scheduler = new WakeScheduler({
    timers,
    debounceMs: 250,
    intervalMs,
    run: async (info) => {
      runs.push(info);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (gate) await gate.promise;
      concurrent -= 1;
    },
  });
  return {
    timers,
    runs,
    scheduler,
    hold: () => {
      gate = deferred();
      return gate;
    },
    release: () => {
      const g = gate;
      gate = null;
      g?.resolve();
    },
    maxConcurrent: () => maxConcurrent,
  };
}

describe("WakeScheduler", () => {
  it("runs a full reconcile immediately on start", async () => {
    const { runs, scheduler } = setup();
    scheduler.start();
    await flushMicrotasks();
    assert.deepEqual(runs, [{ periodic: true, reasons: ["start"] }]);
    await scheduler.stop();
  });

  it("coalesces a burst of wakes into one debounced, non-periodic tick", async () => {
    const { timers, runs, scheduler } = setup();
    scheduler.start();
    await flushMicrotasks();
    scheduler.wake("board.task");
    timers.advance(100);
    scheduler.wake("board.task");
    scheduler.wake("herdr.agent_status");
    timers.advance(149);
    assert.equal(runs.length, 1, "debounce window not elapsed yet");
    timers.advance(1);
    await flushMicrotasks();
    assert.equal(runs.length, 2);
    assert.deepEqual(runs[1], { periodic: false, reasons: ["board.task", "herdr.agent_status"] });
    await scheduler.stop();
  });

  it("never overlaps ticks and runs exactly one follow-up for wakes during a tick", async () => {
    const t = setup();
    const gate = t.hold();
    t.scheduler.start();
    await flushMicrotasks();
    for (let i = 0; i < 5; i += 1) t.scheduler.wake(`e${i}`);
    t.timers.advance(1_000);
    assert.equal(t.runs.length, 1, "no second tick while the first is running");
    t.release();
    void gate;
    await flushMicrotasks();
    t.timers.advance(250);
    await flushMicrotasks();
    t.timers.advance(250);
    await flushMicrotasks();
    assert.equal(t.runs.length, 2);
    assert.deepEqual(t.runs[1]?.reasons, ["e0", "e1", "e2", "e3", "e4"]);
    assert.equal(t.maxConcurrent(), 1);
    await t.scheduler.stop();
  });

  it("keeps the periodic cadence regardless of event-driven ticks", async () => {
    const { timers, runs, scheduler } = setup(() => 10_000);
    scheduler.start();
    await flushMicrotasks();
    for (let i = 0; i < 4; i += 1) {
      timers.advance(2_000);
      scheduler.wake("event");
      timers.advance(250);
      await flushMicrotasks();
    }
    // 4 × 2.25s = 9s elapsed; the periodic reconcile is due at 10s, not pushed back by events.
    assert.equal(runs.filter((r) => r.periodic).length, 1);
    timers.advance(1_000);
    await flushMicrotasks();
    assert.equal(runs.filter((r) => r.periodic).length, 2);
    assert.deepEqual(runs.at(-1)?.reasons, ["interval"]);
    await scheduler.stop();
  });

  it("switches to the degraded interval when refreshInterval() is called", async () => {
    let interval = 60_000;
    const { timers, runs, scheduler } = setup(() => interval);
    scheduler.start();
    await flushMicrotasks();
    timers.advance(5_000);
    assert.equal(runs.length, 1);
    interval = 15_000;
    scheduler.refreshInterval();
    timers.advance(9_999);
    assert.equal(runs.length, 1);
    timers.advance(1);
    await flushMicrotasks();
    assert.equal(runs.length, 2);
    assert.equal(runs[1]?.periodic, true);
    await scheduler.stop();
  });

  it("requestReconcile() makes the next tick periodic", async () => {
    const { timers, runs, scheduler } = setup();
    scheduler.start();
    await flushMicrotasks();
    scheduler.requestReconcile("cursor_rejected");
    timers.advance(250);
    await flushMicrotasks();
    assert.deepEqual(runs[1], { periodic: true, reasons: ["cursor_rejected"] });
    await scheduler.stop();
  });

  it("stop() waits for the running tick and cancels every timer", async () => {
    const t = setup();
    t.hold();
    t.scheduler.start();
    await flushMicrotasks();
    t.scheduler.wake("x");
    let stopped = false;
    const stopping = t.scheduler.stop().then(() => {
      stopped = true;
    });
    await flushMicrotasks();
    assert.equal(stopped, false);
    t.release();
    await stopping;
    assert.equal(t.timers.pendingCount, 0);
    t.scheduler.wake("late");
    assert.equal(t.timers.pendingCount, 0);
  });
});

const ev = (source: "board" | "herdr", healthy: boolean): SwarmEvent => ({
  kind: "source.health",
  source,
  healthy,
  detail: "",
});

describe("Bus and SourceHealth", () => {
  it("isolates a throwing subscriber", () => {
    const logs: string[] = [];
    const bus = new Bus((_l, m) => logs.push(m));
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    const unsubscribe = bus.subscribe((e) => seen.push(e.kind));
    bus.publish({ kind: "timer.reconcile" });
    unsubscribe();
    bus.publish({ kind: "timer.reconcile" });
    assert.deepEqual(seen, ["timer.reconcile"]);
    assert.equal(logs.length, 2);
  });

  it("is healthy only when every enabled source is", () => {
    const health = new SourceHealth();
    assert.equal(health.allHealthy, false, "no sources = polling mode");
    health.enable("board");
    health.enable("herdr");
    assert.equal(health.apply(ev("board", true)), false);
    assert.equal(health.apply(ev("herdr", true)), true);
    assert.equal(health.allHealthy, true);
    assert.equal(health.apply(ev("herdr", false)), true);
    assert.equal(health.allHealthy, false);
    assert.equal(health.apply({ kind: "timer.reconcile" }), false);
  });

  it("selects the interval from health and time-sensitive work", () => {
    const base = { pollMs: 15_000, reconcileMs: 60_000 };
    assert.equal(
      selectReconcileIntervalMs({ ...base, sourcesHealthy: false, timeSensitiveWork: false }),
      15_000,
    );
    assert.equal(
      selectReconcileIntervalMs({ ...base, sourcesHealthy: true, timeSensitiveWork: false }),
      60_000,
    );
    assert.equal(
      selectReconcileIntervalMs({ ...base, sourcesHealthy: true, timeSensitiveWork: true }),
      15_000,
    );
  });
});

describe("FsWatchSource", () => {
  it("watches the directory, filters by file name, and debounces", () => {
    const timers = new ManualTimers();
    const listeners: Array<(type: string, name: string | null) => void> = [];
    const dirs: string[] = [];
    let closed = 0;
    const events: SwarmEvent[] = [];
    const source = new FsWatchSource({
      files: ["/cfg/projects.json"],
      onEvent: (e) => events.push(e),
      timers,
      watchDir: (dir, listener) => {
        dirs.push(dir);
        listeners.push(listener);
        return { close: () => void (closed += 1), on: () => ({}) as never };
      },
    });
    source.start();
    assert.deepEqual(dirs, ["/cfg"]);
    listeners[0]!("rename", "projects.json.tmp");
    listeners[0]!("rename", "projects.json");
    listeners[0]!("change", "projects.json");
    timers.advance(200);
    assert.deepEqual(events, [{ kind: "fs.changed", path: "/cfg/projects.json" }]);
    listeners[0]!("change", "projects.json");
    source.stop();
    timers.advance(1_000);
    assert.equal(events.length, 1);
    assert.equal(closed, 1);
    assert.equal(timers.pendingCount, 0);
  });
});
