import type { BoardTask } from "./board.ts";
import {
  resolveReviewerConfig,
  resolveWorkerRuntime,
  type MachineConfig,
  type ProjectConfig,
  type ProjectsConfig,
  type ResolvedReviewerConfig,
  type ResolvedWorkerRuntime,
  type SwarmConfig,
} from "./config.ts";

export interface CandidateTask {
  task: BoardTask;
  projectSlug: string;
  project: ProjectConfig;
  repoPath: string;
  useWorktree: boolean;
  runtime: ResolvedWorkerRuntime;
  reviewer: ResolvedReviewerConfig;
}

export interface RoutingSkip {
  taskId: string;
  reason: string;
}

export function extractProjectSlug(channel: string, prefix: string): string | null {
  const cleanChannel = channel.replace(/^#/, "");
  const cleanPrefix = prefix.replace(/^#/, "");
  if (!cleanChannel.startsWith(cleanPrefix)) {
    return null;
  }
  const rest = cleanChannel.slice(cleanPrefix.length).trim();
  if (!rest) return null;
  return rest.split("/")[0] ?? null;
}

export function matchesMachineLabels(
  taskLabels: Record<string, string>,
  machineName: string,
  machineConfig: MachineConfig,
  projectDefaultMachine: string,
): { matched: boolean; reason?: string } {
  const hostLabelSet = new Set(machineConfig.labels.map((l) => l.toLowerCase()));
  hostLabelSet.add(`machine=${machineName.toLowerCase()}`);

  const requestedMachine = taskLabels.machine?.trim().toLowerCase();
  if (requestedMachine) {
    if (requestedMachine !== "any" && requestedMachine !== machineName.toLowerCase()) {
      return {
        matched: false,
        reason: `routed to machine=${requestedMachine} (this host is ${machineName})`,
      };
    }
  } else {
    const def = projectDefaultMachine.trim().toLowerCase();
    if (def && def !== "any" && def !== machineName.toLowerCase()) {
      return {
        matched: false,
        reason: `project defaultMachine=${projectDefaultMachine} (this host is ${machineName})`,
      };
    }
  }

  const requestedOs = taskLabels.os?.trim().toLowerCase();
  if (requestedOs && !hostLabelSet.has(`os=${requestedOs}`)) {
    return {
      matched: false,
      reason: `requires os=${requestedOs} (not in host labels)`,
    };
  }

  return { matched: true };
}

export function selectEligibleTasks(params: {
  tasks: BoardTask[];
  swarm: SwarmConfig;
  projects: ProjectsConfig;
  machineName: string;
  busyPlainTabProjects: Set<string>;
  alreadyTrackedTaskIds: Set<string>;
  availableAgentKinds?: Set<string>;
}): { candidates: CandidateTask[]; skips: RoutingSkip[] } {
  const {
    tasks,
    swarm,
    projects,
    machineName,
    busyPlainTabProjects,
    alreadyTrackedTaskIds,
    availableAgentKinds,
  } = params;

  const machineConfig = swarm.machines[machineName];
  if (!machineConfig) {
    throw new Error(`Machine "${machineName}" not found in swarm config`);
  }

  const candidates: CandidateTask[] = [];
  const skips: RoutingSkip[] = [];

  for (const task of tasks) {
    if (alreadyTrackedTaskIds.has(task.id)) {
      skips.push({ taskId: task.id, reason: "already tracked by dispatcher" });
      continue;
    }

    if (task.state !== "ready") {
      skips.push({ taskId: task.id, reason: `state is ${task.state}` });
      continue;
    }

    const projectSlug = extractProjectSlug(task.channel, swarm.board.projectChannelPrefix);
    if (!projectSlug) {
      skips.push({
        taskId: task.id,
        reason: `channel "${task.channel}" does not match prefix "${swarm.board.projectChannelPrefix}"`,
      });
      continue;
    }

    const project = projects.projects[projectSlug];
    if (!project) {
      skips.push({ taskId: task.id, reason: `unknown project "${projectSlug}" in projects.json` });
      continue;
    }

    const repoPath = project.paths[machineName];
    if (!repoPath) {
      skips.push({
        taskId: task.id,
        reason: `project "${projectSlug}" has no local path configured for ${machineName}`,
      });
      continue;
    }

    const labelMatch = matchesMachineLabels(
      task.labels,
      machineName,
      machineConfig,
      project.defaultMachine,
    );
    if (!labelMatch.matched) {
      skips.push({ taskId: task.id, reason: labelMatch.reason ?? "machine label mismatch" });
      continue;
    }

    const useWorktree = project.useWorktree ?? swarm.workerDefaults.useWorktree;
    if (!useWorktree && busyPlainTabProjects.has(projectSlug)) {
      skips.push({
        taskId: task.id,
        reason: `plain-tab checkout for "${projectSlug}" already has an active or parked worker`,
      });
      continue;
    }

    let runtime: ResolvedWorkerRuntime;
    try {
      runtime = resolveWorkerRuntime(swarm.workerDefaults, task.labels);
    } catch (err) {
      skips.push({
        taskId: task.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (availableAgentKinds && !availableAgentKinds.has(runtime.kind)) {
      skips.push({
        taskId: task.id,
        reason: `agent binary "${runtime.kind}" is not installed on ${machineName}`,
      });
      continue;
    }

    let reviewer: ResolvedReviewerConfig;
    try {
      reviewer = resolveReviewerConfig(swarm.workerDefaults, project, task.labels);
    } catch (err) {
      skips.push({
        taskId: task.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (
      reviewer.enabled &&
      reviewer.runtime &&
      availableAgentKinds &&
      !availableAgentKinds.has(reviewer.runtime.kind)
    ) {
      skips.push({
        taskId: task.id,
        reason: `reviewer binary "${reviewer.runtime.kind}" is not installed on ${machineName}`,
      });
      continue;
    }

    candidates.push({
      task,
      projectSlug,
      project,
      repoPath,
      useWorktree,
      runtime,
      reviewer,
    });
  }

  return { candidates, skips };
}

export function renderWorkerPrompt(
  template: string,
  vars: {
    taskId: string;
    channel: string;
    project: string;
    boardProfile: string;
    branch: string;
    baseBranch?: string;
    agentProfile: string;
    humanHandle: string;
    review?: {
      enabled: boolean;
      reviewerProfile?: string;
      maxRounds?: number;
    };
  },
): string {
  const completionWorkflow = vars.review?.enabled
    ? [
        `   - **Do NOT call \`vercel board tasks complete\`** — an automated Reviewer (\`${vars.review.reviewerProfile ?? "reviewer"}\`, up to ${vars.review.maxRounds ?? 2} review rounds) will inspect your work directly on thread \`${vars.taskId}\` first.`,
        `   - Post a structured summary reply on thread \`${vars.taskId}\` (**Changes**, **Verification**, and branch/commit SHA) ending with the exact final line:`,
        "     ```",
        "     STATUS: READY_FOR_REVIEW",
        "     ```",
        "   - Stop cleanly and wait — if the Reviewer approves, the Dispatcher completes the task and closes your tab automatically. If changes are requested, the Dispatcher will wake you in this tab to fix them.",
      ].join("\n")
    : [
        `   - Post a structured final summary reply on thread \`${vars.taskId}\` (**Changes**, **Verification**, and branch/commit SHA).`,
        "   - Mark the task complete with a concise summary:",
        "     ```bash",
        `     vercel board tasks complete ${vars.taskId} "<summary + verification>"`,
        "     ```",
        "   - Stop cleanly — the Dispatcher will close your tab once the task is marked `completed`.",
      ].join("\n");

  return template
    .replaceAll("{{TASK_ID}}", vars.taskId)
    .replaceAll("{{CHANNEL}}", vars.channel)
    .replaceAll("{{PROJECT}}", vars.project)
    .replaceAll("{{BOARD_PROFILE}}", vars.boardProfile)
    .replaceAll("{{BRANCH}}", vars.branch)
    .replaceAll("{{BASE_BRANCH}}", vars.baseBranch ?? "main")
    .replaceAll("{{AGENT_PROFILE}}", vars.agentProfile)
    .replaceAll("{{HUMAN_HANDLE}}", vars.humanHandle)
    .replaceAll("{{COMPLETION_WORKFLOW}}", completionWorkflow);
}

export function shortTaskId(taskId: string): string {
  const msgUuid = /^msg_([a-zA-Z0-9]{8})/.exec(taskId);
  if (msgUuid?.[1]) return msgUuid[1];
  return taskId.replace(/^#/, "").slice(0, 12);
}

export function formatTabLabel(
  taskId: string,
  agentProfile: string,
  prefix?: "BLOCKED" | "FAILED",
  tag?: string,
): string {
  const mid = tag ? ` ${tag}` : "";
  const base = `task-${shortTaskId(taskId)}${mid} (${agentProfile})`;
  return prefix ? `[${prefix}] ${base}` : base;
}

export function formatReviewTabLabel(
  taskId: string,
  reviewerProfile: string,
  round: number,
  prefix?: "BLOCKED" | "FAILED",
): string {
  const base = `review-${shortTaskId(taskId)} r${round} (${reviewerProfile})`;
  return prefix ? `[${prefix}] ${base}` : base;
}
