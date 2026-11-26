import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResolvedWorkerRuntime } from "../src/lib/config.ts";
import {
  createManagedSession,
  stepSession,
  type ManagedSession,
  type SessionHandle,
} from "../src/lib/session-fsm.ts";
import { stepTask, type ActiveTask, type TaskObservation } from "../src/lib/task-fsm.ts";

const claudeRuntime: ResolvedWorkerRuntime = {
  profileName: "claude",
  kind: "claude",
  model: "opus",
  effort: "medium",
  permissionMode: "auto",
  cliArgs: ["--model", "opus", "--effort", "medium", "--permission-mode", "auto"],
};

const codexRuntime: ResolvedWorkerRuntime = {
  profileName: "codex",
  kind: "codex",
  model: "",
  effort: "high",
  permissionMode: "auto",
  cliArgs: [
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    "sandbox_workspace_write.network_access=true",
    "--approve-for-me",
  ],
};

function makeHandle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    boardProfile: "worker-host-1",
    runtime: claudeRuntime,
    tabId: "w1:t1",
    paneId: "w1:p1",
    agentName: "w-1",
    startedAtMs: 1_000,
    ...overrides,
  };
}

function makeTask(phaseOverride?: ActiveTask["phase"], reviewRequired = false): ActiveTask {
  const implHandle = makeHandle();
  return {
    ctx: {
      taskId: "1",
      channel: "projects/app",
      projectSlug: "app",
      repoPath: "/tmp/app",
      baseBranch: "main",
      branch: "task/1",
      useWorktree: false,
      workspaceId: "w1",
      boardProfile: "worker-host-1",
      reviewConfig: {
        enabled: true,
        required: reviewRequired,
        maxRounds: 2,
        skipIfNoDiff: true,
        runtime: codexRuntime,
      },
      startHeadSha: "aaaa111",
      machineName: "host",
      humanHandle: "@owner",
    },
    phase: phaseOverride ?? {
      kind: "implementing",
      impl: createManagedSession(implHandle, { promptText: "Do task", blockedOnStartup: false }),
    },
    lastLeaseRenewMs: 1_000,
    phaseSeenReplyIds: new Set(),
    lastImplSummary: "Implemented feature",
  };
}

function baseObs(overrides: Partial<TaskObservation> = {}): TaskObservation {
  return {
    boardState: "claimed",
    implTabExists: true,
    implAgentStatus: "working",
    reviewerTabExists: false,
    reviewerAgentStatus: null,
    signal: { kind: "none" },
    nowMs: 5_000,
    leaseRenewIntervalMs: 300_000,
    idleTimeoutMs: 30_000,
    startupGraceMs: 20_000,
    ...overrides,
  };
}

describe("session-fsm (pure Herdr agent session transitions)", () => {
  it("handles startup grace, unexpected exit, and queued startup prompt delivery", () => {
    const starting = createManagedSession(makeHandle({ startedAtMs: 1_000 }), {
      promptText: "Start task",
      blockedOnStartup: true,
    });

    // Agent still initializing within startup grace -> continue
    const grace = stepSession(starting, {
      tabExists: true,
      agentStatus: null,
      nowMs: 10_000,
      startupGraceMs: 20_000,
      idleTimeoutMs: 30_000,
      canIdleTimeout: true,
    });
    assert.equal(grace.kind, "continue");

    // Agent unblocked and idle -> delivers queued prompt and enters running
    const delivered = stepSession(starting, {
      tabExists: true,
      agentStatus: "idle",
      nowMs: 12_000,
      startupGraceMs: 20_000,
      idleTimeoutMs: 30_000,
      canIdleTimeout: true,
    });
    assert.equal(delivered.kind, "deliver_prompt");
    assert.equal(delivered.promptText, "Start task");
    assert.equal(delivered.session.lifecycle.kind, "running");
    assert.equal(delivered.previous.lifecycle.kind, "awaiting_prompt");

    // Agent missing past startup grace -> exited_unexpectedly
    const crashed = stepSession(delivered.session, {
      tabExists: true,
      agentStatus: null,
      nowMs: 25_000,
      startupGraceMs: 20_000,
      idleTimeoutMs: 30_000,
      canIdleTimeout: true,
    });
    assert.deepEqual(crashed, { kind: "exited_unexpectedly", tabExists: true });
  });

  it("handles UI block -> recovery and two-stage idle timeout cleanly with no stale flags", () => {
    let session: ManagedSession = createManagedSession(makeHandle(), {
      promptText: "Go",
      blockedOnStartup: false,
    });

    // Running -> UI blocked
    const blocked = stepSession(session, {
      tabExists: true,
      agentStatus: "blocked",
      nowMs: 2_000,
      startupGraceMs: 20_000,
      idleTimeoutMs: 30_000,
      canIdleTimeout: true,
    });
    assert.equal(blocked.kind, "ui_blocked");
    session = blocked.session;
    assert.equal(session.lifecycle.kind, "ui_blocked");

    // UI blocked -> working recovers cleanly
    const recovered = stepSession(session, {
      tabExists: true,
      agentStatus: "working",
      nowMs: 3_000,
      startupGraceMs: 20_000,
      idleTimeoutMs: 30_000,
      canIdleTimeout: true,
    });
    assert.equal(recovered.kind, "ui_recovered");
    session = recovered.session;
    assert.equal(session.lifecycle.kind, "running");

    // Idle starts grace window
    const grace = stepSession(session, {
      tabExists: true,
      agentStatus: "idle",
      nowMs: 10_000,
      startupGraceMs: 20_000,
      idleTimeoutMs: 30_000,
      canIdleTimeout: true,
    });
    assert.equal(grace.kind, "continue");
    session = grace.session;
    assert.equal(session.lifecycle.kind, "idle_grace");

    // First timeout -> sends 1 reminder
    const reminded = stepSession(session, {
      tabExists: true,
      agentStatus: "idle",
      nowMs: 40_000,
      startupGraceMs: 20_000,
      idleTimeoutMs: 30_000,
      canIdleTimeout: true,
    });
    assert.equal(reminded.kind, "send_idle_reminder");
    session = reminded.session;
    assert.equal(session.lifecycle.kind, "idle_reminded");

    // Second timeout -> idle_timed_out
    const timedOut = stepSession(session, {
      tabExists: true,
      agentStatus: "idle",
      nowMs: 70_000,
      startupGraceMs: 20_000,
      idleTimeoutMs: 30_000,
      canIdleTimeout: true,
    });
    assert.equal(timedOut.kind, "idle_timed_out");
  });
});

describe("task-fsm (pure outer implement -> review -> fix state table)", () => {
  it("renews lease independently of phase and respects review=required even with empty diff", () => {
    const task = makeTask(undefined, true); // review=required
    const outcome = stepTask(
      task,
      baseObs({
        nowMs: 400_000, // > 300_000 leaseRenewIntervalMs
        signal: {
          kind: "ready_for_review",
          summary: "Checked docs",
          allReplyIds: ["r1"],
          hasGitChanges: false,
          gitDetail: "no local git changes",
          reviewCwd: "/tmp/app",
        },
      }),
    );

    assert.equal(outcome.status, "active");
    assert.equal(outcome.next.lastLeaseRenewMs, 400_000);
    assert.ok(outcome.effects.some((e) => e.type === "renew_lease"));
    assert.ok(outcome.effects.some((e) => e.type === "spawn_reviewer" && e.nextRound === 1));
  });

  it("completes task on APPROVE even if reviewer exited immediately after posting verdict", () => {
    const implHandle = makeHandle();
    const revHandle = makeHandle({
      boardProfile: "reviewer-host-1",
      runtime: codexRuntime,
      tabId: "w1:t2",
      paneId: "w1:p2",
      agentName: "r1-1",
    });
    const task = makeTask({
      kind: "reviewing",
      round: 1,
      impl: implHandle,
      reviewer: createManagedSession(revHandle, { promptText: "Review", blockedOnStartup: false }),
    });

    const outcome = stepTask(
      task,
      baseObs({
        reviewerTabExists: true,
        reviewerAgentStatus: null, // exited right after posting!
        nowMs: 50_000, // past startup grace
        signal: {
          kind: "verdict",
          verdict: "approve",
          summary: "LGTM",
          allReplyIds: ["r2"],
        },
      }),
    );

    assert.equal(outcome.status, "remove");
    assert.ok(outcome.effects.some((e) => e.type === "close_tab" && e.tabId === "w1:t2"));
    assert.ok(outcome.effects.some((e) => e.type === "complete_task"));
    assert.ok(outcome.effects.some((e) => e.type === "cleanup_workspace"));
  });

  it("closes reviewer tab when Board task becomes completed/blocked externally during review", () => {
    const implHandle = makeHandle();
    const revHandle = makeHandle({
      boardProfile: "reviewer-host-1",
      runtime: codexRuntime,
      tabId: "w1:t2",
      paneId: "w1:p2",
      agentName: "r1-1",
    });
    const task = makeTask({
      kind: "reviewing",
      round: 1,
      impl: implHandle,
      reviewer: createManagedSession(revHandle, { promptText: "Review", blockedOnStartup: false }),
    });

    const completed = stepTask(task, baseObs({ boardState: "completed", reviewerTabExists: true }));
    assert.equal(completed.status, "remove");
    assert.ok(completed.effects.some((e) => e.type === "close_tab" && e.tabId === "w1:t2"));
    assert.ok(completed.effects.some((e) => e.type === "cleanup_workspace"));

    const blocked = stepTask(task, baseObs({ boardState: "blocked", reviewerTabExists: true }));
    assert.equal(blocked.status, "park");
    assert.equal(blocked.parkTabId, "w1:t1");
    assert.ok(blocked.effects.some((e) => e.type === "close_tab" && e.tabId === "w1:t2"));
  });

  it("parks implementer tab as [FAILED] if reviewer tab is closed unexpectedly without verdict", () => {
    const implHandle = makeHandle();
    const revHandle = makeHandle({
      boardProfile: "reviewer-host-1",
      runtime: codexRuntime,
      tabId: "w1:t2",
      paneId: "w1:p2",
      agentName: "r1-1",
    });
    const task = makeTask({
      kind: "reviewing",
      round: 1,
      impl: implHandle,
      reviewer: createManagedSession(revHandle, { promptText: "Review", blockedOnStartup: false }),
    });

    const outcome = stepTask(
      task,
      baseObs({
        implTabExists: true,
        reviewerTabExists: false, // reviewer tab vanished!
        reviewerAgentStatus: null,
        nowMs: 50_000,
      }),
    );

    assert.equal(outcome.status, "park");
    assert.equal(outcome.reason, "failed");
    assert.equal(outcome.parkTabId, "w1:t1");
    assert.ok(outcome.effects.some((e) => e.type === "fail_on_unexpected_exit"));
    assert.ok(
      outcome.effects.some(
        (e) => e.type === "rename_tab" && e.tabId === "w1:t1" && e.label.startsWith("[FAILED]"),
      ),
    );
  });
});
