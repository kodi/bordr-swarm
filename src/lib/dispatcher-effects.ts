import type { BoardClient } from "./board.ts";
import type { SwarmConfig } from "./config.ts";
import { sanitizeHerdrAgentName, type HerdrClient } from "./herdr.ts";
import { buildFixRoundPrompt, renderReviewerPrompt } from "./review.ts";
import { formatReviewTabLabel, formatTabLabel, shortTaskId } from "./routing.ts";
import {
  assertNever,
  createManagedSession,
  type ManagedSession,
  type SessionHandle,
} from "./session-fsm.ts";
import {
  getImplHandle,
  type ActiveTask,
  type ParkedTab,
  type ParkedTabStepOutcome,
  type TaskEffect,
  type TaskStepOutcome,
} from "./task-fsm.ts";

export type { ParkedTab };

export type LogFn = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

export interface EffectExecutorDeps {
  swarm: SwarmConfig;
  machineName: string;
  board: BoardClient;
  herdr: HerdrClient;
  activeWorkers: Map<string, ActiveTask>;
  parkedTabs: Map<string, ParkedTab>;
  getReviewerPromptTemplate: () => string;
  log: LogFn;
}

export function buildBoardEnv(
  swarm: SwarmConfig,
  boardProfile: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = { BOARD_PROFILE: boardProfile };
  const boardUrl = (swarm.board.url || processEnv.BOARD_URL || "").trim();
  if (boardUrl) {
    env.BOARD_URL = boardUrl;
  } else {
    if (swarm.board.scope) env.VERCEL_SCOPE = swarm.board.scope;
    if (swarm.board.boardName) env.VERCEL_BOARD_NAME = swarm.board.boardName;
  }
  const boardToken = (processEnv.BOARD_TOKEN || "").trim();
  if (boardToken) {
    env.BOARD_TOKEN = boardToken;
  }
  return env;
}

async function safeRenameTab(
  herdr: HerdrClient,
  tabId: string,
  label: string,
  log: LogFn,
): Promise<void> {
  try {
    await herdr.renameTab(tabId, label);
  } catch (err) {
    log(
      "WARN",
      `Failed to rename tab ${tabId} to "${label}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parkTaskTab(
  deps: EffectExecutorDeps,
  task: ActiveTask,
  tabId: string,
  reason: "blocked" | "failed",
  nowMs: number,
): void {
  deps.parkedTabs.set(task.ctx.taskId, {
    taskId: task.ctx.taskId,
    projectSlug: task.ctx.projectSlug,
    useWorktree: task.ctx.useWorktree,
    workspaceId: task.ctx.workspaceId,
    tabId,
    reason,
    parkedAtMs: nowMs,
    task,
  });
}

function updateSessionOnActiveTask(
  deps: EffectExecutorDeps,
  taskId: string,
  role: "impl" | "reviewer",
  session: ManagedSession,
): void {
  const current = deps.activeWorkers.get(taskId);
  if (!current) return;
  if (role === "reviewer" && current.phase.kind === "reviewing") {
    deps.activeWorkers.set(taskId, {
      ...current,
      phase: { ...current.phase, reviewer: session },
    });
  } else if (role === "impl" && current.phase.kind !== "reviewing") {
    deps.activeWorkers.set(taskId, {
      ...current,
      phase: { ...current.phase, impl: session },
    });
  }
}

async function executeSpawnReviewer(
  deps: EffectExecutorDeps,
  task: ActiveTask,
  nextRound: number,
  reviewCwd: string,
  nowMs: number,
): Promise<void> {
  const { ctx } = task;
  const reviewRuntime = ctx.reviewConfig.runtime;
  if (!reviewRuntime) return;

  const shortId = shortTaskId(ctx.taskId);
  const implHandle = getImplHandle(task.phase);
  const reviewerBoardProfile = `reviewer-${deps.machineName}-${shortId}`;
  const reviewerAgentName = sanitizeHerdrAgentName(`r${nextRound}`, shortId);
  const reviewTabLabel = formatReviewTabLabel(ctx.taskId, reviewRuntime.profileName, nextRound);

  try {
    const reviewPane = await deps.herdr.createTab({
      workspaceId: ctx.workspaceId,
      cwd: reviewCwd,
      label: reviewTabLabel,
      env: buildBoardEnv(deps.swarm, reviewerBoardProfile),
      focus: false,
    });

    const reviewPrompt = renderReviewerPrompt(deps.getReviewerPromptTemplate(), {
      taskId: ctx.taskId,
      channel: ctx.channel,
      project: ctx.projectSlug,
      boardProfile: reviewerBoardProfile,
      baseRef: ctx.startHeadSha ?? ctx.baseBranch,
      branch: ctx.branch,
      round: nextRound,
      maxRounds: ctx.reviewConfig.maxRounds,
      reviewerProfile: reviewRuntime.profileName,
      humanHandle: ctx.humanHandle,
    });

    const startRes = await deps.herdr.startAgent({
      name: reviewerAgentName,
      kind: reviewRuntime.kind,
      paneId: reviewPane.paneId,
      args: reviewRuntime.cliArgs,
      timeoutMs: 60_000,
    });

    const reviewerHandle: SessionHandle = {
      boardProfile: reviewerBoardProfile,
      runtime: reviewRuntime,
      tabId: reviewPane.tabId,
      paneId: reviewPane.paneId,
      agentName: reviewerAgentName,
      startedAtMs: nowMs,
    };

    const reviewerSession = createManagedSession(reviewerHandle, {
      promptText: reviewPrompt,
      blockedOnStartup: startRes.blockedOnStartup,
    });

    const latest = deps.activeWorkers.get(ctx.taskId) ?? task;
    deps.activeWorkers.set(ctx.taskId, {
      ...latest,
      phase: {
        kind: "reviewing",
        round: nextRound,
        impl: implHandle,
        reviewer: reviewerSession,
      },
    });

    await safeRenameTab(
      deps.herdr,
      implHandle.tabId,
      formatTabLabel(
        ctx.taskId,
        implHandle.runtime.profileName,
        undefined,
        `[IN-REVIEW r${nextRound}]`,
      ),
      deps.log,
    );

    if (startRes.blockedOnStartup) {
      deps.log(
        "WARN",
        `Reviewer ${reviewerAgentName} for task #${ctx.taskId} hit an interactive prompt on startup; marking tab [BLOCKED] for Sheprd.`,
      );
      await safeRenameTab(
        deps.herdr,
        reviewPane.tabId,
        formatReviewTabLabel(ctx.taskId, reviewRuntime.profileName, nextRound, "BLOCKED"),
        deps.log,
      );
      await deps.board
        .reply(
          ctx.taskId,
          `Reviewer (${reviewRuntime.profileName}, round ${nextRound}/${ctx.reviewConfig.maxRounds}) paused on startup prompt in Sheprd on \`${deps.machineName}\` (workspace \`${ctx.projectSlug}\`). Approve/dismiss it in Sheprd to continue.`,
          { asProfile: reviewerBoardProfile },
        )
        .catch(() => {});
    } else {
      await deps.herdr.promptAgent(reviewerAgentName, reviewPrompt);
      deps.log(
        "INFO",
        `Spawned reviewer ${reviewerAgentName} (${reviewRuntime.profileName}/${reviewRuntime.kind}) for task #${ctx.taskId} round ${nextRound}/${ctx.reviewConfig.maxRounds}.`,
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log("ERROR", `Failed to spawn reviewer for task #${ctx.taskId}: ${detail}`);
    await deps.board
      .reply(
        ctx.taskId,
        `Dispatcher on \`${deps.machineName}\` failed to start reviewer \`${reviewRuntime.profileName}\` (round ${nextRound}):\n\`\`\`\n${detail.slice(0, 600)}\n\`\`\``,
        { asProfile: ctx.boardProfile },
      )
      .catch(() => {});
    await deps.board
      .blockTask(
        ctx.taskId,
        `Failed to start reviewer ${reviewRuntime.profileName} on ${deps.machineName}; inspect Sheprd.`,
        { asProfile: ctx.boardProfile, kind: "needs_input" },
      )
      .catch(() => {});
    await safeRenameTab(
      deps.herdr,
      implHandle.tabId,
      formatTabLabel(ctx.taskId, implHandle.runtime.profileName, "BLOCKED"),
      deps.log,
    );
    parkTaskTab(deps, task, implHandle.tabId, "blocked", nowMs);
    deps.activeWorkers.delete(ctx.taskId);
  }
}

async function executeResumeImplementerForFix(
  deps: EffectExecutorDeps,
  task: ActiveTask,
  round: number,
  reviewerProfile: string,
  implAlive: boolean,
  implTabExists: boolean,
  nowMs: number,
): Promise<void> {
  const { ctx } = task;
  const impl = getImplHandle(task.phase);

  if (!implTabExists) {
    deps.log(
      "WARN",
      `Original implementer tab ${impl.tabId} for task #${ctx.taskId} was closed; escalating to blocked.`,
    );
    await deps.board
      .blockTask(
        ctx.taskId,
        `Reviewer requested changes, but original implementer tab on ${deps.machineName} was closed.`,
        { asProfile: ctx.boardProfile, kind: "needs_input" },
      )
      .catch(() => {});
    deps.activeWorkers.delete(ctx.taskId);
    return;
  }

  const fixPrompt = buildFixRoundPrompt({
    taskId: ctx.taskId,
    round,
    maxRounds: ctx.reviewConfig.maxRounds,
    reviewerProfile,
  });

  await safeRenameTab(
    deps.herdr,
    impl.tabId,
    formatTabLabel(ctx.taskId, impl.runtime.profileName, undefined, `fix-r${round}`),
    deps.log,
  );

  try {
    if (implAlive) {
      await deps.herdr.promptAgent(impl.agentName, fixPrompt);
      deps.log(
        "INFO",
        `Reviewer requested changes on task #${ctx.taskId} (round ${round}/${ctx.reviewConfig.maxRounds}); woke original implementer ${impl.agentName}.`,
      );
      return;
    }

    // Self-heal if original implementer exited while waiting for review
    const restartedHandle: SessionHandle = { ...impl, startedAtMs: nowMs };
    const restart = await deps.herdr.startAgent({
      name: impl.agentName,
      kind: impl.runtime.kind,
      paneId: impl.paneId,
      args: impl.runtime.cliArgs,
      timeoutMs: 60_000,
    });

    const restartedSession = createManagedSession(restartedHandle, {
      promptText: fixPrompt,
      blockedOnStartup: restart.blockedOnStartup,
    });
    updateSessionOnActiveTask(deps, ctx.taskId, "impl", restartedSession);

    if (restart.blockedOnStartup) {
      await safeRenameTab(
        deps.herdr,
        impl.tabId,
        formatTabLabel(ctx.taskId, impl.runtime.profileName, "BLOCKED"),
        deps.log,
      );
      await deps.board
        .reply(
          ctx.taskId,
          `Implementer (${impl.runtime.profileName}) paused on startup prompt while resuming fix round ${round} in Sheprd on \`${deps.machineName}\`.`,
          { asProfile: ctx.boardProfile },
        )
        .catch(() => {});
    } else {
      await deps.herdr.promptAgent(impl.agentName, fixPrompt);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log(
      "ERROR",
      `Failed to wake implementer ${impl.agentName} for task #${ctx.taskId}: ${detail}`,
    );
    await deps.board
      .blockTask(
        ctx.taskId,
        `Failed to wake implementer ${impl.agentName} for review fixes: ${detail.slice(0, 300)}`,
        { asProfile: ctx.boardProfile, kind: "needs_input" },
      )
      .catch(() => {});
    await safeRenameTab(
      deps.herdr,
      impl.tabId,
      formatTabLabel(ctx.taskId, impl.runtime.profileName, "BLOCKED"),
      deps.log,
    );
    parkTaskTab(deps, task, impl.tabId, "blocked", nowMs);
    deps.activeWorkers.delete(ctx.taskId);
  }
}

async function executeSingleEffect(
  deps: EffectExecutorDeps,
  previousTask: ActiveTask,
  effect: TaskEffect,
  nowMs: number,
): Promise<void> {
  switch (effect.type) {
    case "renew_lease": {
      try {
        await deps.board.renewTask(effect.taskId, {
          asProfile: effect.boardProfile,
          lease: deps.swarm.board.leaseDuration,
        });
        deps.log("INFO", `Renewed lease for task #${effect.taskId} (${effect.boardProfile}).`);
      } catch (err) {
        deps.log(
          "WARN",
          `Lease renewal failed for task #${effect.taskId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        const cur = deps.activeWorkers.get(effect.taskId);
        if (cur) {
          deps.activeWorkers.set(effect.taskId, {
            ...cur,
            lastLeaseRenewMs: previousTask.lastLeaseRenewMs,
          });
        }
      }
      return;
    }

    case "reclaim_task": {
      try {
        await deps.board.claimTaskById(effect.taskId, {
          asProfile: effect.boardProfile,
          lease: deps.swarm.board.leaseDuration,
        });
        deps.log(
          "WARN",
          `Lease on task #${effect.taskId} had lapsed (Board reported ready); re-claimed it as ${effect.boardProfile}.`,
        );
      } catch (err) {
        deps.log(
          "WARN",
          `Lease on task #${effect.taskId} lapsed and re-claiming as ${effect.boardProfile} failed (${err instanceof Error ? err.message : String(err)}); treating it as claimed by another worker and orphaning its tab.`,
        );
        deps.activeWorkers.delete(effect.taskId);
        for (const lost of effect.onLost) {
          await executeSingleEffect(deps, previousTask, lost, nowMs);
        }
      }
      return;
    }

    case "rename_tab":
      await safeRenameTab(deps.herdr, effect.tabId, effect.label, deps.log);
      return;

    case "close_tab": {
      if (!deps.swarm.workerDefaults.closeTabOnComplete) return;
      try {
        await deps.herdr.closeTab(effect.tabId);
        deps.log(
          "INFO",
          `Closed tab ${effect.tabId} for task #${effect.taskId} (${effect.reason}).`,
        );
      } catch (err) {
        deps.log(
          "WARN",
          `Failed to close tab ${effect.tabId} for task #${effect.taskId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    case "cleanup_workspace": {
      if (!deps.swarm.workerDefaults.closeTabOnComplete) return;
      try {
        if (effect.useWorktree) {
          await deps.herdr.removeWorktree(effect.workspaceId);
          deps.log(
            "INFO",
            `Removed worktree workspace ${effect.workspaceId} for task #${effect.taskId}.`,
          );
        } else if (effect.tabExists) {
          await deps.herdr.closeTab(effect.tabId);
          deps.log("INFO", `Closed tab ${effect.tabId} for completed task #${effect.taskId}.`);
        }
      } catch (err) {
        deps.log(
          "WARN",
          `Cleanup failed for task #${effect.taskId} (${effect.tabId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    case "prompt_agent": {
      try {
        await deps.herdr.promptAgent(effect.agentName, effect.text);
      } catch (err) {
        deps.log(
          "WARN",
          `Could not deliver prompt to ${effect.agentName}: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (effect.revertSessionOnError) {
          updateSessionOnActiveTask(
            deps,
            previousTask.ctx.taskId,
            effect.revertSessionOnError.role,
            effect.revertSessionOnError.previous,
          );
        }
      }
      return;
    }

    case "reply_board":
      await deps.board
        .reply(effect.taskId, effect.text, { asProfile: effect.boardProfile })
        .catch(() => {});
      return;

    case "complete_task":
      await deps.board
        .completeTask(effect.taskId, effect.summary, { asProfile: effect.boardProfile })
        .catch((err) => {
          deps.log(
            "ERROR",
            `Failed to complete task #${effect.taskId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      return;

    case "block_task":
      await deps.board
        .blockTask(effect.taskId, effect.reason, {
          asProfile: effect.boardProfile,
          kind: effect.kind,
        })
        .catch(() => {});
      return;

    case "fail_on_unexpected_exit": {
      deps.log(
        "ERROR",
        `${effect.roleLabel} ${effect.agentName} for task #${effect.taskId} exited unexpectedly (tabExists=${effect.tabExists}).`,
      );
      const tail = effect.tabExists
        ? await deps.herdr.paneRead(effect.paneId, { lines: 40 }).catch(() => "")
        : "";
      if (effect.boardClaimed) {
        const snippet = tail.trim().slice(-1200);
        const verb =
          effect.roleLabel === "Reviewer" ? "posting a verdict" : "completing/blocking the task";
        const msg = snippet
          ? `${effect.roleLabel} \`${effect.agentName}\` on \`${deps.machineName}\` exited before ${verb}.\n\nLast terminal output:\n\`\`\`\n${snippet}\n\`\`\``
          : `${effect.roleLabel} \`${effect.agentName}\` on \`${deps.machineName}\` closed or exited before ${verb}.`;
        await deps.board
          .reply(effect.taskId, msg, { asProfile: effect.replyProfile })
          .catch(() => {});
        await deps.board
          .failTask(
            effect.taskId,
            `${effect.roleLabel} exited unexpectedly on ${deps.machineName}`,
            {
              asProfile: effect.claimProfile,
            },
          )
          .catch(() => {});
      }
      return;
    }

    case "spawn_reviewer":
      await executeSpawnReviewer(
        deps,
        deps.activeWorkers.get(previousTask.ctx.taskId) ?? previousTask,
        effect.nextRound,
        effect.reviewCwd,
        nowMs,
      );
      return;

    case "resume_implementer_for_fix":
      await executeResumeImplementerForFix(
        deps,
        deps.activeWorkers.get(previousTask.ctx.taskId) ?? previousTask,
        effect.round,
        effect.reviewerProfile,
        effect.implAlive,
        effect.implTabExists,
        nowMs,
      );
      return;

    default:
      return assertNever(effect);
  }
}

/**
 * Applies the pure FSM's state transition to activeWorkers/parkedTabs and runs every emitted effect.
 */
export async function applyTaskStepOutcome(
  deps: EffectExecutorDeps,
  previousTask: ActiveTask,
  outcome: TaskStepOutcome,
  nowMs: number,
): Promise<void> {
  const { taskId } = previousTask.ctx;

  switch (outcome.status) {
    case "active":
      deps.activeWorkers.set(taskId, outcome.next);
      break;
    case "park":
      parkTaskTab(deps, previousTask, outcome.parkTabId, outcome.reason, nowMs);
      deps.activeWorkers.delete(taskId);
      break;
    case "remove":
      deps.activeWorkers.delete(taskId);
      break;
    default:
      assertNever(outcome);
  }

  for (const effect of outcome.effects) {
    await executeSingleEffect(deps, previousTask, effect, nowMs);
  }
}

/**
 * Applies the pure parked-tab FSM transition to parkedTabs/activeWorkers and runs emitted effects.
 */
export async function applyParkedTabOutcome(
  deps: EffectExecutorDeps,
  parked: ParkedTab,
  outcome: ParkedTabStepOutcome,
  nowMs: number,
): Promise<void> {
  switch (outcome.status) {
    case "keep":
      break;
    case "unpark":
      deps.parkedTabs.delete(parked.taskId);
      deps.activeWorkers.set(parked.taskId, outcome.restored);
      deps.log(
        "INFO",
        `Parked tab ${parked.tabId} for task #${parked.taskId} resumed as claimed; restoring to active workers.`,
      );
      break;
    case "remove":
      deps.parkedTabs.delete(parked.taskId);
      if (outcome.reason === "tab_closed") {
        deps.log(
          "INFO",
          `Parked tab ${parked.tabId} for task #${parked.taskId} was closed in Sheprd; freeing slot.`,
        );
      } else {
        deps.log(
          "INFO",
          `Parked task #${parked.taskId} reached terminal Board state; cleaning up tab ${parked.tabId} and freeing slot.`,
        );
      }
      break;
    default:
      assertNever(outcome);
  }

  for (const effect of outcome.effects) {
    await executeSingleEffect(deps, parked.task, effect, nowMs);
  }
}
