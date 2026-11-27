import type { BoardTask } from "./board.ts";
import { sanitizeHerdrAgentName, type HerdrAgent } from "./herdr.ts";
import {
  formatTabLabel,
  shortTaskId,
  type CandidateTask,
  type TaskRoutingResult,
} from "./routing.ts";
import type { SessionHandle } from "./session-fsm.ts";
import type { ActiveTask, ParkedTab } from "./task-fsm.ts";

/**
 * Orphan sweep: recovery for when there is no usable state file (first deploy, corrupt file,
 * manual wipe). A task the Board says is `claimed` by this machine's deterministic worker profile
 * but that the dispatcher does not track is an orphan. Everything here is pure; the dispatcher
 * runs the I/O.
 */

/** Upper bound on review rounds probed when looking for a live `r<N>-<shortId>` reviewer agent. */
const MAX_PROBED_REVIEW_ROUNDS = 20;

export interface OrphanCandidate {
  task: BoardTask;
  shortId: string;
  boardProfile: string;
  implAgentName: string;
}

export function workerBoardProfile(machineName: string, taskId: string): string {
  return `worker-${machineName}-${shortTaskId(taskId)}`;
}

/**
 * Open tasks claimed by `worker-<machineName>-<shortId>` (an exact match, so a machine whose name
 * is a prefix of another's never picks up the other's work) that nothing tracks.
 */
export function findUntrackedOwnClaims(
  tasks: readonly BoardTask[],
  trackedTaskIds: ReadonlySet<string>,
  machineName: string,
): OrphanCandidate[] {
  const out: OrphanCandidate[] = [];
  for (const task of tasks) {
    if (task.state !== "claimed" || trackedTaskIds.has(task.id)) continue;
    const boardProfile = workerBoardProfile(machineName, task.id);
    if (task.assignee !== boardProfile) continue;
    const shortId = shortTaskId(task.id);
    out.push({ task, shortId, boardProfile, implAgentName: sanitizeHerdrAgentName("w", shortId) });
  }
  return out;
}

function reviewerAgentNames(shortId: string): Set<string> {
  const names = new Set<string>();
  for (let round = 1; round <= MAX_PROBED_REVIEW_ROUNDS; round += 1) {
    names.add(sanitizeHerdrAgentName(`r${round}`, shortId));
  }
  return names;
}

/** A Herdr agent we can attach to: we need its tab and pane to track it. */
export interface LocatedAgent {
  name: string;
  tabId: string;
  paneId: string;
  workspaceId: string;
  cwd?: string;
}

function locate(agent: HerdrAgent | undefined): LocatedAgent | null {
  if (!agent?.name || !agent.tab_id || !agent.pane_id) return null;
  return {
    name: agent.name,
    tabId: agent.tab_id,
    paneId: agent.pane_id,
    workspaceId: agent.workspace_id ?? "",
    cwd: agent.cwd,
  };
}

export type OrphanDecision =
  /** Live implementer agent: track it again as `implementing` / `running`. */
  | { kind: "adopt"; orphan: OrphanCandidate; routing: CandidateTask; impl: LocatedAgent }
  /** Live reviewer too: the review round is unknown, so park `[BLOCKED]` for a human. */
  | {
      kind: "park_in_review";
      orphan: OrphanCandidate;
      routing: CandidateTask;
      impl: LocatedAgent;
      reviewerAgentName: string;
    }
  /** No live implementer agent: give the task back so it becomes `ready`. */
  | { kind: "release"; orphan: OrphanCandidate }
  /** An agent is alive but we cannot rebuild its context; leave everything alone. */
  | { kind: "skip"; orphan: OrphanCandidate; reason: string };

export function decideOrphan(
  orphan: OrphanCandidate,
  agents: readonly HerdrAgent[],
  routing: TaskRoutingResult,
): OrphanDecision {
  const implAgent = agents.find((a) => a.name === orphan.implAgentName);
  if (!implAgent) {
    return { kind: "release", orphan };
  }

  const impl = locate(implAgent);
  if (!impl) {
    return {
      kind: "skip",
      orphan,
      reason: `live agent ${orphan.implAgentName} has no tab/pane id in herdr agent list`,
    };
  }
  if (!routing.ok) {
    return {
      kind: "skip",
      orphan,
      reason: `live agent ${orphan.implAgentName} found, but the task cannot be routed here: ${routing.reason}`,
    };
  }

  const reviewerNames = reviewerAgentNames(orphan.shortId);
  const reviewer = agents.find((a) => a.name !== undefined && reviewerNames.has(a.name));
  if (reviewer?.name) {
    return {
      kind: "park_in_review",
      orphan,
      routing: routing.candidate,
      impl,
      reviewerAgentName: reviewer.name,
    };
  }
  return { kind: "adopt", orphan, routing: routing.candidate, impl };
}

/**
 * Rebuilds an `ActiveTask` for a live orphaned implementer. Every reply already on the thread is
 * marked seen (so an old `READY_FOR_REVIEW` is not replayed) and `startHeadSha` is unknown.
 * `lastLeaseRenewMs: 0` makes the next reconcile renew the lease straight away.
 */
export function buildAdoptedTask(params: {
  orphan: OrphanCandidate;
  routing: CandidateTask;
  impl: LocatedAgent;
  replyIds: readonly string[];
  machineName: string;
  humanHandle: string;
  nowMs: number;
}): ActiveTask {
  const { orphan, routing, impl, replyIds, machineName, humanHandle, nowMs } = params;
  const handle: SessionHandle = {
    boardProfile: orphan.boardProfile,
    runtime: routing.runtime,
    tabId: impl.tabId,
    paneId: impl.paneId,
    agentName: impl.name,
    startedAtMs: nowMs,
  };
  return {
    ctx: {
      taskId: orphan.task.id,
      channel: orphan.task.channel,
      projectSlug: routing.projectSlug,
      repoPath: routing.repoPath,
      baseBranch: routing.project.baseBranch,
      branch: `task/${orphan.shortId}`,
      useWorktree: routing.useWorktree,
      workspaceId: impl.workspaceId,
      boardProfile: orphan.boardProfile,
      reviewConfig: routing.reviewer,
      startHeadSha: null,
      machineName,
      humanHandle,
    },
    phase: { kind: "implementing", impl: { handle, lifecycle: { kind: "running" } } },
    lastLeaseRenewMs: 0,
    phaseSeenReplyIds: new Set(replyIds),
    lastImplSummary: `Completed task #${orphan.task.id}`,
  };
}

export function buildParkedAdoption(task: ActiveTask, nowMs: number): ParkedTab {
  const impl = task.phase.kind === "reviewing" ? task.phase.impl : task.phase.impl.handle;
  return {
    taskId: task.ctx.taskId,
    projectSlug: task.ctx.projectSlug,
    useWorktree: task.ctx.useWorktree,
    workspaceId: task.ctx.workspaceId,
    tabId: impl.tabId,
    reason: "blocked",
    parkedAtMs: nowMs,
    task,
  };
}

export function blockedAdoptionLabel(task: ActiveTask): string {
  const impl = task.phase.kind === "reviewing" ? task.phase.impl : task.phase.impl.handle;
  return formatTabLabel(task.ctx.taskId, impl.runtime.profileName, "BLOCKED");
}
