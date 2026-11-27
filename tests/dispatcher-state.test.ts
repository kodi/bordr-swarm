import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ResolvedWorkerRuntime } from "../src/lib/config.ts";
import {
  dispatcherStateFingerprint,
  fromPersisted,
  loadDispatcherState,
  resolveDispatcherStatePath,
  saveDispatcherState,
  toPersisted,
} from "../src/lib/dispatcher-state.ts";
import type { SessionHandle, SessionLifecycle } from "../src/lib/session-fsm.ts";
import type { ActiveTask, ParkedTab, TaskPhase } from "../src/lib/task-fsm.ts";

const runtime: ResolvedWorkerRuntime = {
  profileName: "claude",
  kind: "claude",
  model: "opus",
  effort: "medium",
  permissionMode: "auto",
  cliArgs: ["--model", "opus", "--effort", "medium", "--permission-mode", "auto"],
};

function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    boardProfile: "worker-worker-machine-1",
    runtime,
    tabId: "w1:t1",
    paneId: "w1:p1",
    agentName: "w-1",
    startedAtMs: 1_000,
    ...overrides,
  };
}

function task(id: string, phase: TaskPhase, seen: string[] = []): ActiveTask {
  return {
    ctx: {
      taskId: id,
      channel: "projects/app",
      projectSlug: "app",
      repoPath: "/tmp/app",
      baseBranch: "main",
      branch: `task/${id}`,
      useWorktree: false,
      workspaceId: "w1",
      boardProfile: `worker-worker-machine-${id}`,
      reviewConfig: {
        enabled: true,
        required: false,
        maxRounds: 2,
        skipIfNoDiff: true,
        runtime: { ...runtime, profileName: "codex", kind: "codex", cliArgs: [] },
      },
      startHeadSha: id === "nosha" ? null : "aaaa111",
      machineName: "worker-machine",
      humanHandle: "@owner",
    },
    phase,
    lastLeaseRenewMs: 5_000,
    phaseSeenReplyIds: new Set(seen),
    lastImplSummary: `Completed task #${id}`,
  };
}

const LIFECYCLES: SessionLifecycle[] = [
  { kind: "awaiting_prompt", promptText: "Do the task\nwith newlines", uiBlockedNotified: true },
  { kind: "running" },
  { kind: "ui_blocked" },
  { kind: "idle_grace", sinceMs: 12_345 },
  { kind: "idle_reminded", remindedAtMs: 23_456 },
];

function buildTracked(): {
  activeWorkers: Map<string, ActiveTask>;
  parkedTabs: Map<string, ParkedTab>;
} {
  const activeWorkers = new Map<string, ActiveTask>();
  // Every SessionLifecycle variant, on the implementer session
  LIFECYCLES.forEach((lifecycle, i) => {
    const id = `impl-${lifecycle.kind}`;
    activeWorkers.set(
      id,
      task(
        id,
        { kind: "implementing", impl: { handle: handle({ tabId: `w1:t${i}` }), lifecycle } },
        [`r${i}`],
      ),
    );
  });
  // Every TaskPhase variant
  activeWorkers.set(
    "reviewing",
    task(
      "reviewing",
      {
        kind: "reviewing",
        round: 2,
        impl: handle(),
        reviewer: {
          handle: handle({ boardProfile: "reviewer-worker-machine-x", agentName: "r2-x" }),
          lifecycle: { kind: "idle_grace", sinceMs: 99 },
        },
      },
      ["a", "b", "c"],
    ),
  );
  activeWorkers.set(
    "fixing",
    task("fixing", {
      kind: "fixing",
      round: 1,
      impl: { handle: handle(), lifecycle: { kind: "running" } },
    }),
  );
  activeWorkers.set(
    "nosha",
    task("nosha", {
      kind: "implementing",
      impl: { handle: handle(), lifecycle: { kind: "running" } },
    }),
  );

  const parkedTabs = new Map<string, ParkedTab>();
  parkedTabs.set("parked", {
    taskId: "parked",
    projectSlug: "app",
    useWorktree: true,
    workspaceId: "w9",
    tabId: "w9:t1",
    reason: "blocked",
    parkedAtMs: 7_000,
    task: task(
      "parked",
      {
        kind: "reviewing",
        round: 1,
        impl: handle({ tabId: "w9:t1" }),
        reviewer: { handle: handle({ tabId: "w9:t2" }), lifecycle: { kind: "running" } },
      },
      ["z"],
    ),
  });
  return { activeWorkers, parkedTabs };
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "dispatcher-state-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("dispatcher persisted state (pure)", () => {
  it("round-trips every TaskPhase and SessionLifecycle variant plus a parked tab", () => {
    const tracked = buildTracked();
    const persisted = toPersisted(tracked, "worker-machine", 42);
    // Must survive JSON, which is what actually hits disk
    const restored = fromPersisted(JSON.parse(JSON.stringify(persisted)));

    assert.deepEqual(restored.activeWorkers, tracked.activeWorkers);
    assert.deepEqual(restored.parkedTabs, tracked.parkedTabs);
    assert.ok(restored.activeWorkers.get("reviewing")!.phaseSeenReplyIds instanceof Set);
    assert.deepEqual(persisted.activeWorkers.reviewing!.phaseSeenReplyIds, ["a", "b", "c"]);
    assert.equal(persisted.version, 1);
    assert.equal(persisted.machine, "worker-machine");
  });

  it("fingerprint ignores savedAtMs and Set/Map insertion order but tracks real changes", () => {
    const a = buildTracked();
    const b = buildTracked();
    const reordered = new Map([...b.activeWorkers.entries()].toReversed());
    assert.equal(
      dispatcherStateFingerprint(a, "m"),
      dispatcherStateFingerprint({ activeWorkers: reordered, parkedTabs: b.parkedTabs }, "m"),
    );
    const changed = new Map(a.activeWorkers);
    changed.set("fixing", { ...changed.get("fixing")!, lastLeaseRenewMs: 1 });
    assert.notEqual(
      dispatcherStateFingerprint(a, "m"),
      dispatcherStateFingerprint({ activeWorkers: changed, parkedTabs: a.parkedTabs }, "m"),
    );
  });

  it("resolves the default path per machine and honors DISPATCHER_STATE_PATH", () => {
    assert.equal(
      resolveDispatcherStatePath("worker-machine", {}, "/home/agent"),
      "/home/agent/.local/state/bordr-swarm/dispatcher-worker-machine.json",
    );
    assert.equal(
      resolveDispatcherStatePath("worker-machine", { DISPATCHER_STATE_PATH: "/tmp/x.json" }, "/h"),
      "/tmp/x.json",
    );
  });
});

describe("dispatcher state store", () => {
  it("saves atomically and loads back the same state", () => {
    withTmp((dir) => {
      const path = join(dir, "nested", "dispatcher-worker-machine.json");
      const tracked = buildTracked();
      saveDispatcherState(path, toPersisted(tracked, "worker-machine", 1_234));
      assert.deepEqual(readdirSync(join(dir, "nested")), ["dispatcher-worker-machine.json"]);

      const res = loadDispatcherState(path, { machine: "worker-machine" });
      assert.equal(res.kind, "loaded");
      if (res.kind !== "loaded") return;
      assert.equal(res.savedAtMs, 1_234);
      assert.deepEqual(res.state.activeWorkers, tracked.activeWorkers);
      assert.deepEqual(res.state.parkedTabs, tracked.parkedTabs);
    });
  });

  it("reports a missing file without creating anything", () => {
    withTmp((dir) => {
      const path = join(dir, "none.json");
      assert.deepEqual(loadDispatcherState(path, { machine: "m" }), { kind: "missing" });
      assert.ok(!existsSync(path));
    });
  });

  it("quarantines unparseable JSON and schema-invalid files", () => {
    withTmp((dir) => {
      const path = join(dir, "state.json");
      writeFileSync(path, "{ not json");
      const res = loadDispatcherState(path, { machine: "m", nowMs: Date.UTC(2026, 10, 27) });
      assert.equal(res.kind, "quarantined");
      if (res.kind !== "quarantined") return;
      assert.ok(!existsSync(path));
      assert.equal(readFileSync(res.quarantinePath, "utf8"), "{ not json");
      assert.match(res.quarantinePath, /state\.json\.corrupt-2026-11-27T00-00-00-000Z$/);

      writeFileSync(path, JSON.stringify({ version: 2, machine: "m", activeWorkers: {} }));
      const res2 = loadDispatcherState(path, { machine: "m", nowMs: Date.UTC(2026, 10, 28) });
      assert.equal(res2.kind, "quarantined");
      assert.ok(!existsSync(path));
    });
  });

  it("ignores (but keeps) a file written for a different machine", () => {
    withTmp((dir) => {
      const path = join(dir, "state.json");
      saveDispatcherState(path, toPersisted(buildTracked(), "other-machine", 1));
      const res = loadDispatcherState(path, { machine: "worker-machine" });
      assert.deepEqual(res, { kind: "other_machine", machine: "other-machine" });
      assert.ok(existsSync(path));
    });
  });
});
