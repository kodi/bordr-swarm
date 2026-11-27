import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResolvedWorkerRuntime } from "../src/lib/config.ts";
import {
  createManagedSession,
  stepSession,
  type ManagedSession,
  type SessionHandle,
} from "../src/lib/session-fsm.ts";
import {
  stepParkedTab,
  stepTask,
  type ActiveTask,
  type ParkedTab,
  type TaskObservation,
} from "../src/lib/task-fsm.ts";

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

function makeParkedTab(overrides: Partial<ParkedTab> = {}): ParkedTab {
  const task = overrides.task ?? makeTask();
  return {
    taskId: task.ctx.taskId,
    projectSlug: task.ctx.projectSlug,
    useWorktree: task.ctx.useWorktree,
    workspaceId: task.ctx.workspaceId,
    tabId: "w1:t1",
    reason: "blocked",
    parkedAtMs: 20_000,
    task,
    ...overrides,
  };
}

describe("stepParkedTab (parked [BLOCKED]/[FAILED] reconciliation)", () => {
  it("auto-closes parked tab and cleans up workspace when Board task becomes completed or canceled", () => {
    const parked = makeParkedTab();

    const completed = stepParkedTab(parked, {
      boardState: "completed",
      parkedTabExists: true,
      implTabExists: true,
      reviewerTabExists: false,
      parkedAgentAlive: true,
      nowMs: 30_000,
    });
    assert.equal(completed.status, "remove");
    assert.equal(completed.reason, "board_terminal");
    assert.ok(
      completed.effects.some(
        (e) => e.type === "cleanup_workspace" && e.tabId === "w1:t1" && e.tabExists === true,
      ),
    );

    const canceled = stepParkedTab(makeParkedTab({ reason: "failed", useWorktree: true }), {
      boardState: "canceled",
      parkedTabExists: false,
      implTabExists: false,
      reviewerTabExists: false,
      parkedAgentAlive: false,
      nowMs: 30_000,
    });
    assert.equal(canceled.status, "remove");
    assert.equal(canceled.reason, "board_terminal");
    assert.ok(
      canceled.effects.some(
        (e) => e.type === "cleanup_workspace" && e.useWorktree === true && e.workspaceId === "w1",
      ),
    );
  });

  it("removes parked entry when manually closed in Sheprd while still blocked", () => {
    const outcome = stepParkedTab(makeParkedTab(), {
      boardState: "blocked",
      parkedTabExists: false,
      implTabExists: false,
      reviewerTabExists: false,
      parkedAgentAlive: false,
      nowMs: 30_000,
    });
    assert.equal(outcome.status, "remove");
    assert.equal(outcome.reason, "tab_closed");
    assert.deepEqual(outcome.effects, []);
  });

  it("unparks and renames tab back when blocked task returns to claimed with live agent", () => {
    const parked = makeParkedTab();
    const outcome = stepParkedTab(parked, {
      boardState: "claimed",
      boardAssignee: "worker-host-1",
      parkedTabExists: true,
      implTabExists: true,
      reviewerTabExists: false,
      parkedAgentAlive: true,
      nowMs: 30_000,
    });
    assert.equal(outcome.status, "unpark");
    assert.equal(outcome.restored.phase.kind, "implementing");
    if (outcome.restored.phase.kind === "implementing") {
      assert.equal(outcome.restored.phase.impl.lifecycle.kind, "running");
    }
    assert.deepEqual(outcome.effects, [
      { type: "rename_tab", tabId: "w1:t1", label: "task-1 (claude)" },
    ]);
  });

  it("keeps tab parked when claimed by another worker, agent died, or reason is failed", () => {
    const claimedByOther = stepParkedTab(makeParkedTab(), {
      boardState: "claimed",
      boardAssignee: "worker-other-host-1",
      parkedTabExists: true,
      implTabExists: true,
      reviewerTabExists: false,
      parkedAgentAlive: true,
      nowMs: 30_000,
    });
    assert.equal(claimedByOther.status, "keep");

    const deadAgent = stepParkedTab(makeParkedTab(), {
      boardState: "claimed",
      boardAssignee: "worker-host-1",
      parkedTabExists: true,
      implTabExists: true,
      reviewerTabExists: false,
      parkedAgentAlive: false,
      nowMs: 30_000,
    });
    assert.equal(deadAgent.status, "keep");

    const failedParked = stepParkedTab(makeParkedTab({ reason: "failed" }), {
      boardState: "claimed",
      boardAssignee: "worker-host-1",
      parkedTabExists: true,
      implTabExists: true,
      reviewerTabExists: false,
      parkedAgentAlive: true,
      nowMs: 30_000,
    });
    assert.equal(failedParked.status, "keep");
  });

  it("closes both reviewer and implementer tabs when a parked reviewer task completes", () => {
    const implHandle = makeHandle();
    const revHandle = makeHandle({
      boardProfile: "reviewer-host-1",
      runtime: codexRuntime,
      tabId: "w1:t2",
      paneId: "w1:p2",
      agentName: "r1-1",
    });
    const revTask = makeTask({
      kind: "reviewing",
      round: 1,
      impl: implHandle,
      reviewer: createManagedSession(revHandle, { promptText: "Review", blockedOnStartup: false }),
    });
    const parked = makeParkedTab({ task: revTask, tabId: "w1:t2" });

    const outcome = stepParkedTab(parked, {
      boardState: "completed",
      parkedTabExists: true,
      implTabExists: true,
      reviewerTabExists: true,
      parkedAgentAlive: true,
      nowMs: 40_000,
    });
    assert.equal(outcome.status, "remove");
    assert.equal(outcome.reason, "board_terminal");
    assert.ok(outcome.effects.some((e) => e.type === "close_tab" && e.tabId === "w1:t2"));
    assert.ok(outcome.effects.some((e) => e.type === "cleanup_workspace" && e.tabId === "w1:t1"));
  });
});

describe("stepTask claim continuity (lease lapsed / claim lost)", () => {
  function reviewingTask(): ActiveTask {
    const base = makeTask();
    return {
      ...base,
      phase: {
        kind: "reviewing",
        round: 1,
        impl: makeHandle(),
        reviewer: {
          handle: makeHandle({
            boardProfile: "reviewer-host-1",
            runtime: codexRuntime,
            tabId: "w1:t2",
            paneId: "w1:p2",
            agentName: "r1-1",
          }),
          lifecycle: { kind: "running" },
        },
      },
    };
  }

  it("holds the claim when the Board assignee is our own profile (no extra effects)", () => {
    const outcome = stepTask(makeTask(), baseObs({ boardAssignee: "worker-host-1" }));
    assert.equal(outcome.status, "active");
    assert.deepEqual(outcome.effects, []);
  });

  it("reclaims under the same profile when the lease lapsed to ready and the agent is alive", () => {
    const task = makeTask();
    const outcome = stepTask(task, baseObs({ boardState: "ready", nowMs: 9_000_000 }));
    assert.equal(outcome.status, "active");
    if (outcome.status !== "active") return;
    assert.equal(outcome.next.lastLeaseRenewMs, 9_000_000);
    assert.deepEqual(outcome.next.phase, task.phase, "phase is untouched");
    assert.equal(outcome.effects.length, 1);
    const [effect] = outcome.effects;
    assert.equal(effect?.type, "reclaim_task");
    if (effect?.type !== "reclaim_task") return;
    assert.equal(effect.boardProfile, "worker-host-1");
    // Fallback if the reclaim fails: orphan, never touch task state
    assert.ok(
      effect.onLost.some(
        (e) => e.type === "rename_tab" && e.label === "[ORPHANED] task-1 (claude)",
      ),
    );
    assert.ok(effect.onLost.some((e) => e.type === "reply_board"));
    assert.ok(
      !effect.onLost.some((e) =>
        ["complete_task", "block_task", "fail_on_unexpected_exit"].includes(e.type),
      ),
    );
  });

  it("does not reclaim a lapsed task whose agent is gone; the exit path handles it", () => {
    const outcome = stepTask(
      makeTask(),
      baseObs({ boardState: "ready", implAgentStatus: null, nowMs: 100_000 }),
    );
    assert.ok(!outcome.effects.some((e) => e.type === "reclaim_task"));
    const exit = outcome.effects.find((e) => e.type === "fail_on_unexpected_exit");
    assert.ok(exit);
    if (exit?.type === "fail_on_unexpected_exit") {
      assert.equal(exit.boardClaimed, false, "a ready task is never failed by us");
    }
  });

  it("checks the reviewer session (not the implementer) for liveness during review", () => {
    const alive = stepTask(
      reviewingTask(),
      baseObs({
        boardState: "ready",
        implAgentStatus: null,
        reviewerTabExists: true,
        reviewerAgentStatus: "working",
      }),
    );
    assert.equal(alive.effects[0]?.type, "reclaim_task");
  });

  it("orphans and stops tracking when another profile holds the claim", () => {
    const outcome = stepTask(
      reviewingTask(),
      baseObs({
        boardAssignee: "worker-other-machine-1",
        reviewerTabExists: true,
        reviewerAgentStatus: "working",
        nowMs: 9_000_000,
      }),
    );
    assert.equal(outcome.status, "remove");
    const renames = outcome.effects.filter((e) => e.type === "rename_tab");
    assert.deepEqual(
      renames.map((e) => (e.type === "rename_tab" ? e.label : "")),
      ["[ORPHANED] task-1 (claude)", "[ORPHANED] review-1 r1 (codex)"],
    );
    const replies = outcome.effects.filter((e) => e.type === "reply_board");
    assert.equal(replies.length, 1);
    if (replies[0]?.type === "reply_board") {
      assert.match(replies[0].text, /worker-other-machine-1/);
    }
    assert.ok(
      !outcome.effects.some((e) =>
        ["renew_lease", "complete_task", "block_task", "close_tab", "cleanup_workspace"].includes(
          e.type,
        ),
      ),
      "never renews, closes, or changes task state for a claim we lost",
    );
  });
});
