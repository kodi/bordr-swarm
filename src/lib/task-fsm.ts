import type { BoardTaskState } from "./board.ts";
import type { ResolvedReviewerConfig } from "./config.ts";
import type { ReviewVerdict } from "./review.ts";
import { formatReviewTabLabel, formatTabLabel, type TabLabelPrefix } from "./routing.ts";
import type { AgentStatus, RuntimeKind } from "./runtime.ts";
import {
  assertNever,
  stepSession,
  type ManagedSession,
  type SessionHandle,
  type SessionStepResult,
} from "./session-fsm.ts";

export interface TaskContext {
  taskId: string;
  channel: string;
  projectSlug: string;
  repoPath: string;
  baseBranch: string;
  branch: string;
  useWorktree: boolean;
  /** Set only when the Dispatcher itself created a `git worktree` (Rex machines). */
  worktreePath?: string;
  /** Terminal runtime hosting this task (defaults to `"herdr"` when omitted in legacy state). */
  runtimeKind?: RuntimeKind;
  workspaceId: string;
  boardProfile: string;
  reviewConfig: ResolvedReviewerConfig;
  startHeadSha: string | null;
  machineName: string;
  humanHandle: string;
}

/**
 * Discriminated union for the outer task lifecycle.
 * `reviewing` statically guarantees a Reviewer session exists; `implementing` and `fixing` cannot hold one.
 */
export type TaskPhase =
  | { kind: "implementing"; impl: ManagedSession }
  | { kind: "reviewing"; round: number; impl: SessionHandle; reviewer: ManagedSession }
  | { kind: "fixing"; round: number; impl: ManagedSession };

export interface ActiveTask {
  ctx: TaskContext;
  phase: TaskPhase;
  lastLeaseRenewMs: number;
  phaseSeenReplyIds: ReadonlySet<string>;
  lastImplSummary: string;
}

export type ThreadSignal =
  | { kind: "none" }
  | {
      kind: "ready_for_review";
      summary: string;
      allReplyIds: string[];
      hasGitChanges: boolean;
      gitDetail: string;
      reviewCwd: string;
    }
  | {
      kind: "verdict";
      verdict: ReviewVerdict;
      summary: string;
      allReplyIds: string[];
    };

export interface TaskObservation {
  boardState: BoardTaskState;
  /** Board profile currently holding the claim (normalized from the claim actor), if any. */
  boardAssignee?: string;
  implTabExists: boolean;
  implAgentStatus: AgentStatus | null;
  reviewerTabExists: boolean;
  reviewerAgentStatus: AgentStatus | null;
  signal: ThreadSignal;
  nowMs: number;
  leaseRenewIntervalMs: number;
  idleTimeoutMs: number;
  startupGraceMs: number;
  startupTimeoutMs?: number;
}

export type TaskEffect =
  | { type: "renew_lease"; taskId: string; boardProfile: string }
  | {
      /**
       * Lease lapsed while the dispatcher was away and nobody else took the task: claim it again
       * under the same profile. If that fails, the task was taken meanwhile; the executor stops
       * tracking it and runs `onLost` (the same effects as a claim lost to another profile).
       */
      type: "reclaim_task";
      taskId: string;
      boardProfile: string;
      onLost: TaskEffect[];
    }
  | { type: "rename_tab"; tabId: string; label: string }
  | { type: "close_tab"; tabId: string; taskId: string; reason: string }
  | {
      type: "cleanup_workspace";
      taskId: string;
      workspaceId: string;
      tabId: string;
      useWorktree: boolean;
      worktreePath?: string;
      tabExists: boolean;
    }
  | {
      type: "prompt_agent";
      agentName: string;
      tabId?: string;
      paneId?: string;
      text: string;
      revertSessionOnError?: { role: "impl" | "reviewer"; previous: ManagedSession };
    }
  | {
      type: "reply_board";
      taskId: string;
      text: string;
      boardProfile: string;
      /** When set, the executor reads a terminal tail from this pane and appends it to the reply. */
      includeTailFromPaneId?: string;
    }
  | { type: "complete_task"; taskId: string; summary: string; boardProfile: string }
  | {
      type: "block_task";
      taskId: string;
      reason: string;
      boardProfile: string;
      kind: "needs_input" | "awaiting_approval";
    }
  | {
      type: "fail_on_unexpected_exit";
      taskId: string;
      paneId: string;
      tabExists: boolean;
      agentName: string;
      roleLabel: "Worker" | "Reviewer";
      replyProfile: string;
      claimProfile: string;
      boardClaimed: boolean;
    }
  | { type: "spawn_reviewer"; nextRound: number; reviewCwd: string }
  | {
      type: "resume_implementer_for_fix";
      round: number;
      reviewerProfile: string;
      implAlive: boolean;
      implTabExists: boolean;
    };

export type TaskStepOutcome =
  | { status: "active"; next: ActiveTask; effects: TaskEffect[] }
  | { status: "park"; parkTabId: string; reason: "blocked" | "failed"; effects: TaskEffect[] }
  | { status: "remove"; effects: TaskEffect[] };

export interface ParkedTab {
  taskId: string;
  projectSlug: string;
  useWorktree: boolean;
  workspaceId: string;
  tabId: string;
  reason: "blocked" | "failed";
  parkedAtMs: number;
  task: ActiveTask;
}

export interface ParkedTabObservation {
  boardState: BoardTaskState;
  boardAssignee?: string;
  parkedTabExists: boolean;
  implTabExists: boolean;
  reviewerTabExists: boolean;
  parkedAgentAlive: boolean;
  nowMs: number;
}

export type ParkedTabStepOutcome =
  | { status: "keep"; effects: TaskEffect[] }
  | { status: "unpark"; restored: ActiveTask; effects: TaskEffect[] }
  | { status: "remove"; reason: "tab_closed" | "board_terminal"; effects: TaskEffect[] };

export function getImplHandle(phase: TaskPhase): SessionHandle {
  return phase.kind === "reviewing" ? phase.impl : phase.impl.handle;
}

export function getReviewerHandle(phase: TaskPhase): SessionHandle | null {
  return phase.kind === "reviewing" ? phase.reviewer.handle : null;
}

function runtimeUiName(ctx: TaskContext): string {
  return ctx.runtimeKind === "rex" ? "Rex" : "Sheprd";
}

function getImplTabLabel(ctx: TaskContext, phase: TaskPhase, prefix?: TabLabelPrefix): string {
  const impl = getImplHandle(phase);
  const tag =
    prefix !== undefined
      ? undefined
      : phase.kind === "fixing"
        ? `fix-r${phase.round}`
        : phase.kind === "reviewing"
          ? `[IN-REVIEW r${phase.round}]`
          : undefined;
  return formatTabLabel(ctx.taskId, impl.runtime.profileName, prefix, tag);
}

function buildIdleReminder(ctx: TaskContext, role: "impl" | "reviewer"): string {
  if (role === "reviewer") {
    return `Please post your code review reply to thread \`${ctx.taskId}\` using \`vercel board reply ${ctx.taskId} ...\` ending with either \`VERDICT: APPROVE\` or \`VERDICT: REQUEST_CHANGES\`.`;
  }
  if (ctx.reviewConfig.enabled) {
    return `Task #${ctx.taskId} is still in state "claimed" and awaiting code review. If you finished implementing and committed your changes, post your summary reply to thread ${ctx.taskId} ending with \`STATUS: READY_FOR_REVIEW\` (do NOT call \`vercel board tasks complete\`). If you need input or approval, run \`vercel board tasks block ${ctx.taskId} "<reason>" --kind needs_input\`.`;
  }
  return `Task #${ctx.taskId} is still in state "claimed". If you finished, run \`vercel board tasks complete ${ctx.taskId} "<summary>"\`. If you need input or approval, run \`vercel board tasks block ${ctx.taskId} "<reason>" --kind needs_input\`.`;
}

function applySessionStep(params: {
  task: ActiveTask;
  role: "impl" | "reviewer";
  step: SessionStepResult;
  obs: TaskObservation;
  effects: TaskEffect[];
  normalLabel: string;
  blockedLabel: string;
  failedLabel: string;
  withUpdatedSession: (session: ManagedSession) => TaskPhase;
}): TaskStepOutcome {
  const {
    task,
    role,
    step,
    obs,
    effects,
    normalLabel,
    blockedLabel,
    failedLabel,
    withUpdatedSession,
  } = params;
  const { ctx } = task;
  const handle =
    role === "reviewer" && task.phase.kind === "reviewing"
      ? task.phase.reviewer.handle
      : getImplHandle(task.phase);
  const roleLabel = role === "reviewer" ? "Reviewer" : "Worker";

  switch (step.kind) {
    case "continue":
      return {
        status: "active",
        next: { ...task, phase: withUpdatedSession(step.session) },
        effects,
      };

    case "deliver_prompt":
      effects.push(
        {
          type: "prompt_agent",
          agentName: handle.agentName,
          tabId: handle.tabId,
          paneId: handle.paneId,
          text: step.promptText,
          revertSessionOnError: { role, previous: step.previous },
        },
        { type: "rename_tab", tabId: handle.tabId, label: normalLabel },
      );
      return {
        status: "active",
        next: { ...task, phase: withUpdatedSession(step.session) },
        effects,
      };

    case "ui_blocked": {
      const ui = runtimeUiName(ctx);
      const isTimeout = step.reason === "startup_timeout";
      effects.push(
        { type: "rename_tab", tabId: handle.tabId, label: blockedLabel },
        {
          type: "reply_board",
          taskId: ctx.taskId,
          boardProfile: handle.boardProfile,
          text: isTimeout
            ? `${roleLabel} \`${handle.agentName}\` (${handle.runtime.profileName}) did not become ready within startup timeout in ${ui} on \`${ctx.machineName}\` (workspace \`${ctx.projectSlug}\`, tab \`${blockedLabel}\`).`
            : `${roleLabel} \`${handle.agentName}\` (${handle.runtime.profileName}) is waiting on an interactive prompt in ${ui} on \`${ctx.machineName}\` (workspace \`${ctx.projectSlug}\`, tab \`${blockedLabel}\`).`,
          ...(isTimeout ? { includeTailFromPaneId: handle.paneId } : {}),
        },
      );
      return {
        status: "active",
        next: { ...task, phase: withUpdatedSession(step.session) },
        effects,
      };
    }

    case "ui_recovered":
      effects.push({ type: "rename_tab", tabId: handle.tabId, label: normalLabel });
      return {
        status: "active",
        next: { ...task, phase: withUpdatedSession(step.session) },
        effects,
      };

    case "send_idle_reminder":
      effects.push({
        type: "prompt_agent",
        agentName: handle.agentName,
        tabId: handle.tabId,
        paneId: handle.paneId,
        text: buildIdleReminder(ctx, role),
      });
      return {
        status: "active",
        next: { ...task, phase: withUpdatedSession(step.session) },
        effects,
      };

    case "idle_timed_out": {
      const ui = runtimeUiName(ctx);
      effects.push(
        { type: "rename_tab", tabId: handle.tabId, label: blockedLabel },
        {
          type: "block_task",
          taskId: ctx.taskId,
          boardProfile: ctx.boardProfile,
          kind: "needs_input",
          reason:
            role === "reviewer"
              ? `Reviewer ${handle.agentName} on ${ctx.machineName} went idle without posting a verdict; inspect tab in ${ui}.`
              : `Worker ${handle.agentName} on ${ctx.machineName} went idle without completing; inspect tab in ${ui}.`,
        },
      );
      return { status: "park", parkTabId: handle.tabId, reason: "blocked", effects };
    }

    case "exited_unexpectedly": {
      effects.push({
        type: "fail_on_unexpected_exit",
        taskId: ctx.taskId,
        paneId: handle.paneId,
        tabExists: step.tabExists,
        agentName: handle.agentName,
        roleLabel,
        replyProfile: handle.boardProfile,
        claimProfile: ctx.boardProfile,
        boardClaimed: obs.boardState === "claimed",
      });

      if (step.tabExists) {
        effects.push({ type: "rename_tab", tabId: handle.tabId, label: failedLabel });
        return { status: "park", parkTabId: handle.tabId, reason: "failed", effects };
      }

      if (role === "reviewer" && obs.implTabExists) {
        const impl = getImplHandle(task.phase);
        effects.push({
          type: "rename_tab",
          tabId: impl.tabId,
          label: getImplTabLabel(ctx, task.phase, "FAILED"),
        });
        return { status: "park", parkTabId: impl.tabId, reason: "failed", effects };
      }

      return { status: "remove", effects };
    }

    default:
      return assertNever(step);
  }
}

type ClaimLoss =
  | { kind: "held" }
  /** Board says `ready`: our lease ran out and nobody else claimed it (yet). */
  | { kind: "lapsed" }
  /** Board says `claimed` by a different profile. */
  | { kind: "taken"; holder: string };

/**
 * Only a live session can usefully reclaim: if the agent is gone, the normal session step
 * reports the exit and the task stays `ready` for any worker to pick up.
 */
function isActiveSessionAlive(task: ActiveTask, obs: TaskObservation): boolean {
  return task.phase.kind === "reviewing"
    ? obs.reviewerTabExists && obs.reviewerAgentStatus !== null
    : obs.implTabExists && obs.implAgentStatus !== null;
}

function classifyClaimLoss(task: ActiveTask, obs: TaskObservation): ClaimLoss {
  if (obs.boardState === "ready" && isActiveSessionAlive(task, obs)) {
    return { kind: "lapsed" };
  }
  if (
    obs.boardState === "claimed" &&
    obs.boardAssignee !== undefined &&
    obs.boardAssignee !== "" &&
    obs.boardAssignee !== task.ctx.boardProfile
  ) {
    return { kind: "taken", holder: obs.boardAssignee };
  }
  return { kind: "held" };
}

/**
 * We no longer hold the claim: rename our tabs `[ORPHANED]` and explain once on the thread.
 * The task's Board state belongs to whoever holds it now, so nothing here touches it.
 */
function buildOrphanEffects(
  task: ActiveTask,
  obs: TaskObservation,
  holder: string | undefined,
): TaskEffect[] {
  const { ctx, phase } = task;
  const implHandle = getImplHandle(phase);
  const reviewerHandle = getReviewerHandle(phase);
  const effects: TaskEffect[] = [];
  const orphanedLabel = getImplTabLabel(ctx, phase, "ORPHANED");

  if (obs.implTabExists) {
    effects.push({ type: "rename_tab", tabId: implHandle.tabId, label: orphanedLabel });
  }
  if (reviewerHandle && phase.kind === "reviewing" && obs.reviewerTabExists) {
    effects.push({
      type: "rename_tab",
      tabId: reviewerHandle.tabId,
      label: formatReviewTabLabel(
        ctx.taskId,
        reviewerHandle.runtime.profileName,
        phase.round,
        "ORPHANED",
      ),
    });
  }
  const who = holder ? `\`${holder}\`` : "another worker";
  const ui = runtimeUiName(ctx);
  effects.push({
    type: "reply_board",
    taskId: ctx.taskId,
    boardProfile: ctx.boardProfile,
    text: `Dispatcher on \`${ctx.machineName}\` lost its claim on this task (lease ran out while it was offline; now held by ${who}). It stopped tracking its tab \`${orphanedLabel}\` in workspace \`${ctx.projectSlug}\` and left the task's state alone. The agent there may still be running: close the tab in ${ui} once it is no longer needed.`,
  });
  return effects;
}

/**
 * Pure, deterministic outer Task FSM.
 * Given the current ActiveTask and a TickObservation, computes the exact next state
 * and declarative side effects with zero I/O or mutation.
 */
export function stepTask(task: ActiveTask, obs: TaskObservation): TaskStepOutcome {
  const { ctx } = task;
  const implHandle = getImplHandle(task.phase);
  const reviewerHandle = getReviewerHandle(task.phase);
  const effects: TaskEffect[] = [];

  // 1. Terminal Board states (override all active phases cleanly)
  if (obs.boardState === "completed" || obs.boardState === "canceled") {
    if (reviewerHandle && obs.reviewerTabExists) {
      effects.push({
        type: "close_tab",
        tabId: reviewerHandle.tabId,
        taskId: ctx.taskId,
        reason: `task ${obs.boardState}`,
      });
    }
    effects.push({
      type: "cleanup_workspace",
      taskId: ctx.taskId,
      workspaceId: ctx.workspaceId,
      tabId: implHandle.tabId,
      useWorktree: ctx.useWorktree,
      ...(ctx.worktreePath ? { worktreePath: ctx.worktreePath } : {}),
      tabExists: obs.implTabExists,
    });
    return { status: "remove", effects };
  }

  if (obs.boardState === "blocked" || obs.boardState === "failed") {
    const reason = obs.boardState;
    const prefix = reason === "blocked" ? "BLOCKED" : "FAILED";
    if (reviewerHandle && obs.reviewerTabExists) {
      effects.push({
        type: "close_tab",
        tabId: reviewerHandle.tabId,
        taskId: ctx.taskId,
        reason: `task ${reason}`,
      });
    }
    if (obs.implTabExists) {
      effects.push({
        type: "rename_tab",
        tabId: implHandle.tabId,
        label: getImplTabLabel(ctx, task.phase, prefix),
      });
      return { status: "park", parkTabId: implHandle.tabId, reason, effects };
    }
    return { status: "remove", effects };
  }

  // 2. Claim continuity: the dispatcher may have been down for longer than the lease.
  const claimLoss = classifyClaimLoss(task, obs);
  switch (claimLoss.kind) {
    case "held":
      break;
    case "lapsed":
      return {
        status: "active",
        next: { ...task, lastLeaseRenewMs: obs.nowMs },
        effects: [
          {
            type: "reclaim_task",
            taskId: ctx.taskId,
            boardProfile: ctx.boardProfile,
            onLost: buildOrphanEffects(task, obs, undefined),
          },
        ],
      };
    case "taken":
      return { status: "remove", effects: buildOrphanEffects(task, obs, claimLoss.holder) };
    default:
      return assertNever(claimLoss);
  }

  // 3. Lease heartbeat (independent of phase)
  let currentTask = task;
  if (
    obs.boardState === "claimed" &&
    obs.nowMs - task.lastLeaseRenewMs >= obs.leaseRenewIntervalMs
  ) {
    effects.push({ type: "renew_lease", taskId: ctx.taskId, boardProfile: ctx.boardProfile });
    currentTask = { ...task, lastLeaseRenewMs: obs.nowMs };
  }

  // 4. Phase-specific transitions (exhaustive switch)
  const phase = currentTask.phase;
  switch (phase.kind) {
    case "implementing":
    case "fixing": {
      if (
        ctx.reviewConfig.enabled &&
        obs.boardState === "claimed" &&
        obs.signal.kind === "ready_for_review"
      ) {
        const nextSeen = new Set([...currentTask.phaseSeenReplyIds, ...obs.signal.allReplyIds]);
        const updatedTask: ActiveTask = {
          ...currentTask,
          phaseSeenReplyIds: nextSeen,
          lastImplSummary: obs.signal.summary,
          phase:
            phase.kind === "fixing"
              ? {
                  kind: "fixing",
                  round: phase.round,
                  impl: { handle: phase.impl.handle, lifecycle: { kind: "running" } },
                }
              : {
                  kind: "implementing",
                  impl: { handle: phase.impl.handle, lifecycle: { kind: "running" } },
                },
        };

        if (
          !ctx.reviewConfig.required &&
          ctx.reviewConfig.skipIfNoDiff &&
          !obs.signal.hasGitChanges
        ) {
          effects.push(
            {
              type: "reply_board",
              taskId: ctx.taskId,
              boardProfile: ctx.boardProfile,
              text: `Dispatcher skipped automated code review (${obs.signal.gitDetail}) and marked task complete.`,
            },
            {
              type: "complete_task",
              taskId: ctx.taskId,
              summary: obs.signal.summary,
              boardProfile: ctx.boardProfile,
            },
            {
              type: "cleanup_workspace",
              taskId: ctx.taskId,
              workspaceId: ctx.workspaceId,
              tabId: implHandle.tabId,
              useWorktree: ctx.useWorktree,
              ...(ctx.worktreePath ? { worktreePath: ctx.worktreePath } : {}),
              tabExists: obs.implTabExists,
            },
          );
          return { status: "remove", effects };
        }

        const nextRound = phase.kind === "fixing" ? phase.round + 1 : 1;
        effects.push({
          type: "spawn_reviewer",
          nextRound,
          reviewCwd: obs.signal.reviewCwd,
        });
        return { status: "active", next: updatedTask, effects };
      }

      const implStep = stepSession(phase.impl, {
        tabExists: obs.implTabExists,
        agentStatus: obs.implAgentStatus,
        nowMs: obs.nowMs,
        startupGraceMs: obs.startupGraceMs,
        startupTimeoutMs: obs.startupTimeoutMs,
        idleTimeoutMs: obs.idleTimeoutMs,
        canIdleTimeout: obs.boardState === "claimed",
      });

      return applySessionStep({
        task: currentTask,
        role: "impl",
        step: implStep,
        obs,
        effects,
        normalLabel: getImplTabLabel(ctx, phase),
        blockedLabel: getImplTabLabel(ctx, phase, "BLOCKED"),
        failedLabel: getImplTabLabel(ctx, phase, "FAILED"),
        withUpdatedSession: (session) =>
          phase.kind === "fixing"
            ? { kind: "fixing", round: phase.round, impl: session }
            : { kind: "implementing", impl: session },
      });
    }

    case "reviewing": {
      // Check reviewer verdict FIRST so a reviewer that exited right after posting still succeeds
      if (obs.boardState === "claimed" && obs.signal.kind === "verdict") {
        const nextSeen = new Set([...currentTask.phaseSeenReplyIds, ...obs.signal.allReplyIds]);
        const reviewerProfile = phase.reviewer.handle.runtime.profileName;

        if (obs.reviewerTabExists) {
          effects.push({
            type: "close_tab",
            tabId: phase.reviewer.handle.tabId,
            taskId: ctx.taskId,
            reason: `review round ${phase.round} ${obs.signal.verdict}`,
          });
        }

        if (obs.signal.verdict === "approve") {
          const summary = `${currentTask.lastImplSummary} (Reviewed & approved by ${reviewerProfile}, round ${phase.round}/${ctx.reviewConfig.maxRounds})`;
          effects.push(
            {
              type: "complete_task",
              taskId: ctx.taskId,
              summary,
              boardProfile: ctx.boardProfile,
            },
            {
              type: "cleanup_workspace",
              taskId: ctx.taskId,
              workspaceId: ctx.workspaceId,
              tabId: phase.impl.tabId,
              useWorktree: ctx.useWorktree,
              ...(ctx.worktreePath ? { worktreePath: ctx.worktreePath } : {}),
              tabExists: obs.implTabExists,
            },
          );
          return { status: "remove", effects };
        }

        // REQUEST_CHANGES
        if (phase.round < ctx.reviewConfig.maxRounds) {
          const nextTask: ActiveTask = {
            ...currentTask,
            phaseSeenReplyIds: nextSeen,
            phase: {
              kind: "fixing",
              round: phase.round,
              impl: { handle: phase.impl, lifecycle: { kind: "running" } },
            },
          };
          effects.push({
            type: "resume_implementer_for_fix",
            round: phase.round,
            reviewerProfile,
            implAlive: obs.implAgentStatus !== null,
            implTabExists: obs.implTabExists,
          });
          return { status: "active", next: nextTask, effects };
        }

        // Max review rounds exhausted -> escalate cleanly
        effects.push(
          {
            type: "reply_board",
            taskId: ctx.taskId,
            boardProfile: ctx.boardProfile,
            text: `Review round cap (${phase.round}/${ctx.reviewConfig.maxRounds}) reached on task \`${ctx.taskId}\` with blocking issues remaining from \`${reviewerProfile}\`. Pausing for review/decision (${ctx.humanHandle} @lead).`,
          },
          {
            type: "block_task",
            taskId: ctx.taskId,
            boardProfile: ctx.boardProfile,
            kind: "awaiting_approval",
            reason: `Review round cap (${ctx.reviewConfig.maxRounds}) reached; inspect review thread & Sheprd tab.`,
          },
        );
        if (obs.implTabExists) {
          effects.push({
            type: "rename_tab",
            tabId: phase.impl.tabId,
            label: getImplTabLabel(ctx, phase, "BLOCKED"),
          });
          return { status: "park", parkTabId: phase.impl.tabId, reason: "blocked", effects };
        }
        return { status: "remove", effects };
      }

      const reviewerStep = stepSession(phase.reviewer, {
        tabExists: obs.reviewerTabExists,
        agentStatus: obs.reviewerAgentStatus,
        nowMs: obs.nowMs,
        startupGraceMs: obs.startupGraceMs,
        startupTimeoutMs: obs.startupTimeoutMs,
        idleTimeoutMs: obs.idleTimeoutMs,
        canIdleTimeout: obs.boardState === "claimed",
      });

      const revProfile = phase.reviewer.handle.runtime.profileName;
      return applySessionStep({
        task: currentTask,
        role: "reviewer",
        step: reviewerStep,
        obs,
        effects,
        normalLabel: formatReviewTabLabel(ctx.taskId, revProfile, phase.round),
        blockedLabel: formatReviewTabLabel(ctx.taskId, revProfile, phase.round, "BLOCKED"),
        failedLabel: formatReviewTabLabel(ctx.taskId, revProfile, phase.round, "FAILED"),
        withUpdatedSession: (session) => ({
          kind: "reviewing",
          round: phase.round,
          impl: phase.impl,
          reviewer: session,
        }),
      });
    }

    default:
      return assertNever(phase);
  }
}

/**
 * Pure, deterministic reconciliation for a parked ([BLOCKED] / [FAILED]) tab.
 * - Auto-closes and frees the slot/repo lock when the Board task reaches completed/canceled.
 * - Removes the parked entry if the human manually closed the tab in Sheprd.
 * - Restores a blocked tab back to active tracking if the task returns to claimed with the
 *   same live agent session still running in that tab.
 */
export function stepParkedTab(parked: ParkedTab, obs: ParkedTabObservation): ParkedTabStepOutcome {
  const { ctx } = parked.task;
  const implHandle = getImplHandle(parked.task.phase);
  const reviewerHandle = getReviewerHandle(parked.task.phase);

  if (obs.boardState === "completed" || obs.boardState === "canceled") {
    const effects: TaskEffect[] = [];
    if (reviewerHandle && obs.reviewerTabExists) {
      effects.push({
        type: "close_tab",
        tabId: reviewerHandle.tabId,
        taskId: ctx.taskId,
        reason: `task ${obs.boardState}`,
      });
    }
    if (
      parked.tabId !== implHandle.tabId &&
      parked.tabId !== reviewerHandle?.tabId &&
      obs.parkedTabExists
    ) {
      effects.push({
        type: "close_tab",
        tabId: parked.tabId,
        taskId: ctx.taskId,
        reason: `task ${obs.boardState}`,
      });
    }
    effects.push({
      type: "cleanup_workspace",
      taskId: ctx.taskId,
      workspaceId: parked.workspaceId,
      tabId: implHandle.tabId,
      useWorktree: parked.useWorktree,
      ...(ctx.worktreePath ? { worktreePath: ctx.worktreePath } : {}),
      tabExists: obs.implTabExists,
    });
    return { status: "remove", reason: "board_terminal", effects };
  }

  if (!obs.parkedTabExists) {
    return { status: "remove", reason: "tab_closed", effects: [] };
  }

  if (parked.reason === "blocked" && obs.boardState === "claimed" && obs.parkedAgentAlive) {
    const ownedByOther =
      obs.boardAssignee !== undefined &&
      obs.boardAssignee !== "" &&
      obs.boardAssignee !== ctx.boardProfile;

    if (!ownedByOther) {
      let restoredPhase: TaskPhase;
      let normalLabel: string;

      if (
        parked.task.phase.kind === "reviewing" &&
        parked.tabId === parked.task.phase.reviewer.handle.tabId
      ) {
        const revPhase = parked.task.phase;
        restoredPhase = {
          kind: "reviewing",
          round: revPhase.round,
          impl: revPhase.impl,
          reviewer: {
            handle: revPhase.reviewer.handle,
            lifecycle: { kind: "running" },
          },
        };
        normalLabel = formatReviewTabLabel(
          ctx.taskId,
          revPhase.reviewer.handle.runtime.profileName,
          revPhase.round,
        );
      } else if (parked.task.phase.kind === "fixing") {
        restoredPhase = {
          kind: "fixing",
          round: parked.task.phase.round,
          impl: { handle: implHandle, lifecycle: { kind: "running" } },
        };
        normalLabel = getImplTabLabel(ctx, restoredPhase);
      } else {
        restoredPhase = {
          kind: "implementing",
          impl: { handle: implHandle, lifecycle: { kind: "running" } },
        };
        normalLabel = getImplTabLabel(ctx, restoredPhase);
      }

      const restored: ActiveTask = {
        ...parked.task,
        phase: restoredPhase,
      };
      return {
        status: "unpark",
        restored,
        effects: [{ type: "rename_tab", tabId: parked.tabId, label: normalLabel }],
      };
    }
  }

  return { status: "keep", effects: [] };
}
