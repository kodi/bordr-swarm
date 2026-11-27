import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import {
  ProjectsConfigSchema,
  SwarmConfigSchema,
  type BoardConfig,
  type ConfiguredReactor,
  type EffortLevel,
  type EventsConfig,
  type LeadConfig,
  type MachineOs,
  type MachineRole,
  type MachineRuntime,
  type PermissionMode,
  type ProjectConfig,
  type ProjectReviewerOverride,
  type ProjectsConfig,
} from "./schemas.ts";

export type {
  BoardConfig,
  ConfiguredReactor,
  EffortLevel,
  EventsConfig,
  LeadConfig,
  MachineOs,
  MachineRole,
  MachineRuntime,
  PermissionMode,
  ProjectConfig,
  ProjectReviewerOverride,
  ProjectsConfig,
};

export interface WorkerAgentProfile {
  kind: string;
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  extraArgs: string[];
}

export interface ReviewerConfig {
  enabled: boolean;
  agent: string;
  model: string;
  effort?: EffortLevel;
  maxRounds: number;
  skipIfNoDiff: boolean;
}

export interface WorkerDefaultsConfig {
  defaultAgent: string;
  agents: Record<string, WorkerAgentProfile>;
  reviewer: ReviewerConfig;
  useWorktree: boolean;
  closeTabOnComplete: boolean;
  keepTabOnBlockedOrFailed: boolean;
  maxParkedTabs: number;
  pollIntervalSeconds: number;
  /** Full-reconcile interval while live events are healthy (default 60). */
  reconcileIntervalSeconds?: number;
  idleTimeoutSeconds: number;
  /** Seconds a spawned worker has to reach first idle before `[BLOCKED]` (default 90). */
  startupTimeoutSeconds?: number;
  /** Optional base directory for Dispatcher-managed Git worktrees on Rex machines. */
  worktreeRoot?: string;
  claimWaitSeconds: number;
}

export interface MachineConfig {
  role: MachineRole;
  os: MachineOs;
  hostname: string;
  allowedHosts: string[];
  runtime?: MachineRuntime;
  herdrTarget: string;
  maxWorkers: number;
  labels: string[];
}

export interface SwarmConfig {
  board: BoardConfig;
  lead: LeadConfig;
  workerDefaults: WorkerDefaultsConfig;
  /** Live event sources (on when omitted). */
  events?: EventsConfig;
  /** User-defined reactors from local config. */
  reactors?: ConfiguredReactor[];
  machines: Record<string, MachineConfig>;
}

/** Default for `lead.reconcileIntervalSeconds` and `workerDefaults.reconcileIntervalSeconds`. */
export const DEFAULT_RECONCILE_INTERVAL_SECONDS = 60;

/** Default for `workerDefaults.startupTimeoutSeconds`. */
export const DEFAULT_STARTUP_TIMEOUT_SECONDS = 90;

/** Resolved live-event settings (`events` omitted means all sources on). */
export function resolveEventsConfig(swarm: Pick<SwarmConfig, "events">): EventsConfig {
  return {
    boardTail: swarm.events?.boardTail ?? true,
    herdr: swarm.events?.herdr ?? true,
    rex: swarm.events?.rex ?? true,
  };
}

/** Resolved machine worker runtime (`runtime` omitted defaults to Herdr with `herdrTarget` / `"local"`). */
export function resolveMachineRuntime(
  machine: Pick<MachineConfig, "runtime" | "herdrTarget">,
): MachineRuntime {
  if (machine.runtime) return machine.runtime;
  return { kind: "herdr", target: machine.herdrTarget || "local" };
}

export interface ResolvedWorkerRuntime {
  profileName: string;
  kind: string;
  model: string;
  effort: string;
  permissionMode: string;
  cliArgs: string[];
}

export interface ResolvedReviewerConfig {
  enabled: boolean;
  required: boolean;
  maxRounds: number;
  skipIfNoDiff: boolean;
  runtime: ResolvedWorkerRuntime | null;
}

export const BUILTIN_AGENT_KINDS = ["claude", "agy", "codex", "pi"] as const;

export const BUILTIN_AGENT_PROFILES: Record<string, WorkerAgentProfile> = {
  claude: {
    kind: "claude",
    model: "opus",
    effort: "medium",
    permissionMode: "auto",
    extraArgs: [],
  },
  agy: {
    kind: "agy",
    model: "",
    effort: "medium",
    permissionMode: "auto",
    extraArgs: [],
  },
  codex: {
    kind: "codex",
    model: "",
    effort: "medium",
    permissionMode: "auto",
    extraArgs: [],
  },
  pi: {
    kind: "pi",
    model: "",
    effort: "medium",
    permissionMode: "auto",
    extraArgs: [],
  },
};

function readRawJson(filePath: string): unknown {
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON syntax in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

export function currentPlatformOs(): MachineOs {
  return process.platform === "darwin" ? "macos" : "linux";
}

export function parseSwarmConfig(input: unknown, sourceLabel = "swarm.json"): SwarmConfig {
  const result = SwarmConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid ${sourceLabel}:\n${z.prettifyError(result.error)}`);
  }

  const parsed = result.data;
  const machines: Record<string, MachineConfig> = {};
  const fallbackOs = currentPlatformOs();

  for (const [machineName, m] of Object.entries(parsed.machines)) {
    const inferredRole: MachineRole =
      m.role ??
      (parsed.lead.machine && machineName === parsed.lead.machine
        ? (m.maxWorkers ?? 0) > 0
          ? "both"
          : "main"
        : "worker");

    const maxWorkers = m.maxWorkers ?? (inferredRole === "main" ? 0 : 2);
    const resolvedOs = m.os ?? fallbackOs;
    const resolvedRuntime: MachineRuntime = m.runtime
      ? m.runtime
      : { kind: "herdr", target: m.herdrTarget ?? "local" };
    const resolvedHerdrTarget =
      resolvedRuntime.kind === "herdr" ? resolvedRuntime.target : (m.herdrTarget ?? "local");

    const labelSet = new Set(m.labels);
    labelSet.add(`machine=${machineName}`);
    labelSet.add(`os=${resolvedOs}`);
    labelSet.add(`runtime=${resolvedRuntime.kind}`);

    machines[machineName] = {
      role: inferredRole,
      os: resolvedOs,
      hostname: m.hostname ?? machineName,
      allowedHosts: m.allowedHosts,
      runtime: resolvedRuntime,
      herdrTarget: resolvedHerdrTarget,
      maxWorkers,
      labels: [...labelSet],
    };
  }

  const inferredLeadMachine =
    parsed.lead.machine ||
    Object.entries(machines).find(([, m]) => m.role === "main" || m.role === "both")?.[0] ||
    "";

  const normalizedAgents: Record<string, WorkerAgentProfile> = {};
  for (const [profileKey, profile] of Object.entries(parsed.workerDefaults.agents)) {
    normalizedAgents[profileKey] = {
      kind: profile.kind ?? profileKey,
      model: profile.model,
      effort: profile.effort,
      permissionMode: profile.permissionMode,
      extraArgs: profile.extraArgs,
    };
  }

  const rawReviewer = parsed.workerDefaults.reviewer;
  const normalizedReviewer: ReviewerConfig = rawReviewer
    ? {
        enabled: rawReviewer.enabled ?? true,
        agent: rawReviewer.agent,
        model: rawReviewer.model,
        ...(rawReviewer.effort !== undefined ? { effort: rawReviewer.effort } : {}),
        maxRounds: rawReviewer.maxRounds,
        skipIfNoDiff: rawReviewer.skipIfNoDiff,
      }
    : {
        enabled: false,
        agent: "codex",
        model: "",
        maxRounds: 2,
        skipIfNoDiff: true,
      };

  const resolvedBoardUrl = (process.env.BOARD_URL || parsed.board.url || "").trim();

  return {
    board: {
      ...parsed.board,
      ...(resolvedBoardUrl ? { url: resolvedBoardUrl } : {}),
      scope: (process.env.VERCEL_SCOPE || parsed.board.scope).trim(),
      boardName: (process.env.VERCEL_BOARD_NAME || parsed.board.boardName).trim(),
    },
    lead: {
      ...parsed.lead,
      machine: inferredLeadMachine,
    },
    workerDefaults: {
      ...parsed.workerDefaults,
      agents: normalizedAgents,
      reviewer: normalizedReviewer,
    },
    ...(parsed.events ? { events: parsed.events } : {}),
    ...(parsed.reactors ? { reactors: parsed.reactors } : {}),
    machines,
  };
}

export function parseProjectsConfig(input: unknown, sourceLabel = "projects.json"): ProjectsConfig {
  const result = ProjectsConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid ${sourceLabel}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function validateSwarmAndProjects(swarm: SwarmConfig, projects: ProjectsConfig): string[] {
  const warnings: string[] = [];
  const knownMachines = new Set(Object.keys(swarm.machines));
  const knownAgents = new Set<string>([
    ...BUILTIN_AGENT_KINDS,
    ...Object.keys(swarm.workerDefaults.agents),
  ]);

  for (const [slug, project] of Object.entries(projects.projects)) {
    if (project.defaultMachine !== "any" && !knownMachines.has(project.defaultMachine)) {
      warnings.push(
        `Project "${slug}" sets defaultMachine="${project.defaultMachine}" which is not defined in swarm.json machines.`,
      );
    }
    for (const machineKey of Object.keys(project.paths)) {
      if (!knownMachines.has(machineKey)) {
        warnings.push(
          `Project "${slug}" defines a path for unknown machine "${machineKey}" not in swarm.json.`,
        );
      }
    }
    const revAgent = project.reviewer?.agent?.trim();
    if (revAgent && !knownAgents.has(revAgent)) {
      warnings.push(
        `Project "${slug}" sets reviewer.agent="${revAgent}" which is not defined in swarm.json workerDefaults.agents.`,
      );
    }
  }
  return warnings;
}

export function loadSwarmConfig(repoRoot = process.cwd(), configPath?: string): SwarmConfig {
  const resolvedPath =
    configPath ?? process.env.SWARM_CONFIG_PATH ?? resolve(repoRoot, "config/swarm.json");
  const raw = readRawJson(resolvedPath);
  return parseSwarmConfig(raw, resolvedPath);
}

export function loadProjectsConfig(repoRoot = process.cwd(), configPath?: string): ProjectsConfig {
  const resolvedPath =
    configPath ?? process.env.PROJECTS_CONFIG_PATH ?? resolve(repoRoot, "config/projects.json");
  const raw = readRawJson(resolvedPath);
  return parseProjectsConfig(raw, resolvedPath);
}

export function loadProjectsConfigOptional(
  repoRoot = process.cwd(),
  configPath?: string,
): ProjectsConfig {
  const resolvedPath =
    configPath ?? process.env.PROJECTS_CONFIG_PATH ?? resolve(repoRoot, "config/projects.json");
  if (!existsSync(resolvedPath)) {
    return { projects: {} };
  }
  const raw = readRawJson(resolvedPath);
  return parseProjectsConfig(raw, resolvedPath);
}

export function resolveCurrentMachineName(
  config: SwarmConfig,
  explicit?: string,
  preferredRole?: "main" | "worker",
): string {
  const candidate = explicit?.trim() || process.env.SWARM_MACHINE?.trim();
  if (candidate) {
    if (!config.machines[candidate]) {
      throw new Error(
        `Unknown machine "${candidate}". Available machines in swarm.json: ${Object.keys(config.machines).join(", ")}`,
      );
    }
    return candidate;
  }

  // 1. Match OS hostname against configured machine key or machine.hostname
  const host = hostname().toLowerCase();
  const hostShort = host.split(".")[0] ?? host;
  for (const [key, machine] of Object.entries(config.machines)) {
    const keyLower = key.toLowerCase();
    const cfgHost = machine.hostname.toLowerCase();
    const cfgHostShort = cfgHost.split(".")[0] ?? cfgHost;
    if (
      host === keyLower ||
      hostShort === keyLower ||
      host === cfgHost ||
      hostShort === cfgHostShort ||
      host.includes(keyLower) ||
      host.includes(cfgHostShort)
    ) {
      return key;
    }
  }

  // 2. Match by preferred role + current OS
  const localOs = currentPlatformOs();
  const entries = Object.entries(config.machines);

  if (preferredRole === "main") {
    if (config.machines[config.lead.machine]) {
      return config.lead.machine;
    }
    const mainMatch = entries.find(([, m]) => m.role === "main" || m.role === "both");
    if (mainMatch) return mainMatch[0];
  }

  if (preferredRole === "worker") {
    const workerOsMatch = entries.find(
      ([, m]) => (m.role === "worker" || m.role === "both" || m.maxWorkers > 0) && m.os === localOs,
    );
    if (workerOsMatch) return workerOsMatch[0];

    const anyWorker = entries.find(
      ([, m]) => m.role === "worker" || m.role === "both" || m.maxWorkers > 0,
    );
    if (anyWorker) return anyWorker[0];
  }

  // 3. Match any machine with the same OS
  const osMatches = entries.filter(([, m]) => m.os === localOs);
  if (osMatches.length === 1 && osMatches[0]) {
    return osMatches[0][0];
  }

  const first = entries[0]?.[0];
  if (!first) {
    throw new Error("No machines configured in swarm.json");
  }
  return first;
}

export function buildAgentCliArgs(profile: WorkerAgentProfile): string[] {
  const args: string[] = [];
  const kind = profile.kind.toLowerCase();

  if (kind === "claude") {
    if (profile.model) {
      args.push("--model", profile.model);
    }
    if (profile.effort) {
      args.push("--effort", profile.effort);
    }
    if (profile.permissionMode) {
      args.push("--permission-mode", profile.permissionMode);
    }
  } else if (kind === "agy") {
    if (profile.model) {
      args.push("--model", profile.model);
    }
    if (profile.effort) {
      args.push("--effort", profile.effort);
    }
    if (profile.permissionMode) {
      const mode = profile.permissionMode;
      if (mode === "bypassPermissions") {
        args.push("--dangerously-skip-permissions");
      } else if (mode === "acceptEdits") {
        args.push("--mode", "accept-edits");
      } else if (mode === "auto" || mode === "plan") {
        args.push("--mode", mode);
      }
    }
  } else if (kind === "codex") {
    if (profile.model) {
      args.push("--model", profile.model);
    }
    if (profile.effort) {
      args.push("-c", `model_reasoning_effort="${profile.effort}"`);
    }
    if (profile.permissionMode) {
      const mode = profile.permissionMode;
      if (mode === "bypassPermissions") {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      } else if (mode === "auto" || mode === "acceptEdits") {
        // workspace-write blocks outbound network by default; enable network so `vercel board` CLI works
        args.push("-c", "sandbox_workspace_write.network_access=true", "--approve-for-me");
      } else if (mode === "dontAsk") {
        args.push(
          "-s",
          "workspace-write",
          "-c",
          "sandbox_workspace_write.network_access=true",
          "-a",
          "never",
        );
      } else if (mode === "plan") {
        args.push(
          "-s",
          "read-only",
          "-c",
          "sandbox_workspace_write.network_access=true",
          "-a",
          "on-request",
        );
      } else if (mode === "manual") {
        args.push(
          "-s",
          "workspace-write",
          "-c",
          "sandbox_workspace_write.network_access=true",
          "-a",
          "on-request",
        );
      }
    }
  } else if (kind === "pi") {
    if (profile.model) {
      args.push("--model", profile.model);
    }
    if (profile.effort) {
      args.push("--thinking", profile.effort);
    }
    if (profile.permissionMode) {
      const mode = profile.permissionMode;
      if (mode === "plan") {
        args.push("--tools", "read,grep,find,ls", "--approve");
      } else if (mode === "manual") {
        args.push("--no-approve");
      } else if (
        mode === "auto" ||
        mode === "acceptEdits" ||
        mode === "bypassPermissions" ||
        mode === "dontAsk"
      ) {
        args.push("--approve");
      }
    }
  } else {
    if (profile.model) {
      args.push("--model", profile.model);
    }
    if (profile.effort) {
      args.push("--effort", profile.effort);
    }
  }

  if (profile.extraArgs.length > 0) {
    args.push(...profile.extraArgs);
  }

  return args;
}

export function resolveWorkerRuntime(
  workerDefaults: WorkerDefaultsConfig,
  taskLabels: Record<string, string>,
): ResolvedWorkerRuntime {
  const requestedProfile = (taskLabels.agent ?? "").trim() || workerDefaults.defaultAgent;
  const baseProfile =
    workerDefaults.agents[requestedProfile] ?? BUILTIN_AGENT_PROFILES[requestedProfile];

  if (!baseProfile) {
    const known = [
      ...new Set([...Object.keys(workerDefaults.agents), ...Object.keys(BUILTIN_AGENT_PROFILES)]),
    ];
    throw new Error(
      `Unsupported worker agent label "agent=${requestedProfile}". Configured profiles: ${known.join(", ")}`,
    );
  }

  const labelEffort = taskLabels.effort?.trim();
  const effectiveEffort =
    labelEffort && ["low", "medium", "high", "xhigh", "max"].includes(labelEffort)
      ? (labelEffort as WorkerAgentProfile["effort"])
      : baseProfile.effort;

  const effectiveProfile: WorkerAgentProfile = {
    kind: baseProfile.kind,
    model: taskLabels.model?.trim() || baseProfile.model,
    effort: effectiveEffort,
    permissionMode: baseProfile.permissionMode,
    extraArgs: [...baseProfile.extraArgs],
  };

  return {
    profileName: requestedProfile,
    kind: effectiveProfile.kind,
    model: effectiveProfile.model,
    effort: effectiveProfile.effort,
    permissionMode: effectiveProfile.permissionMode,
    cliArgs: buildAgentCliArgs(effectiveProfile),
  };
}

const VALID_EFFORT_LEVELS = new Set(["", "low", "medium", "high", "xhigh", "max"]);

export function resolveReviewerConfig(
  workerDefaults: WorkerDefaultsConfig,
  project?: ProjectConfig,
  taskLabels: Record<string, string> = {},
): ResolvedReviewerConfig {
  const base = workerDefaults.reviewer;
  const projOverride = project?.reviewer;

  const reviewLabel = (taskLabels.review ?? "").trim().toLowerCase();
  const labelReviewerAgent = (taskLabels.reviewer ?? "").trim();
  const labelReviewerModel = taskLabels.reviewer_model?.trim();
  const labelReviewerEffort = taskLabels.reviewer_effort?.trim();

  const explicitlySkipped =
    reviewLabel === "skip" ||
    reviewLabel === "false" ||
    reviewLabel === "off" ||
    reviewLabel === "0" ||
    reviewLabel === "no";
  const explicitlyRequired = reviewLabel === "required";
  const explicitlyEnabledByLabel =
    explicitlyRequired ||
    reviewLabel === "true" ||
    reviewLabel === "on" ||
    reviewLabel === "1" ||
    reviewLabel === "yes" ||
    Boolean(labelReviewerAgent);

  let enabled = base.enabled;
  if (projOverride) {
    enabled = projOverride.enabled ?? true;
  }
  if (explicitlySkipped) {
    enabled = false;
  } else if (explicitlyEnabledByLabel) {
    enabled = true;
  }

  const maxRounds = projOverride?.maxRounds ?? base.maxRounds;
  const skipIfNoDiff = projOverride?.skipIfNoDiff ?? base.skipIfNoDiff;

  if (!enabled) {
    return {
      enabled: false,
      required: false,
      maxRounds,
      skipIfNoDiff,
      runtime: null,
    };
  }

  // Resolve agent + model without leaking a previous agent's model when agent changes
  let selectedAgent = base.agent;
  let selectedModel = base.model;
  let selectedEffort: EffortLevel | undefined = base.effort;

  if (projOverride) {
    const projectChangedAgent =
      projOverride.agent !== undefined && projOverride.agent !== selectedAgent;
    if (projOverride.agent !== undefined) {
      selectedAgent = projOverride.agent;
    }
    if (projOverride.model !== undefined) {
      selectedModel = projOverride.model;
    } else if (projectChangedAgent) {
      selectedModel = "";
    }
    if (projOverride.effort !== undefined) {
      selectedEffort = projOverride.effort;
    }
  }

  if (labelReviewerAgent) {
    const labelChangedAgent = labelReviewerAgent !== selectedAgent;
    selectedAgent = labelReviewerAgent;
    if (labelReviewerModel !== undefined) {
      selectedModel = labelReviewerModel;
    } else if (labelChangedAgent) {
      selectedModel = "";
    }
  } else if (labelReviewerModel !== undefined) {
    selectedModel = labelReviewerModel;
  }

  if (labelReviewerEffort !== undefined && VALID_EFFORT_LEVELS.has(labelReviewerEffort)) {
    selectedEffort = labelReviewerEffort as EffortLevel;
  }

  const baseProfile = workerDefaults.agents[selectedAgent] ?? BUILTIN_AGENT_PROFILES[selectedAgent];
  if (!baseProfile) {
    const known = [
      ...new Set([...Object.keys(workerDefaults.agents), ...Object.keys(BUILTIN_AGENT_PROFILES)]),
    ];
    throw new Error(
      `Unsupported reviewer agent "${selectedAgent}". Configured profiles: ${known.join(", ")}`,
    );
  }

  // Reviewers need shell access for `git diff` and `vercel board reply`, so never run in `plan` mode.
  const effectivePermissionMode: PermissionMode =
    baseProfile.permissionMode === "plan" ? "auto" : baseProfile.permissionMode;

  const effectiveProfile: WorkerAgentProfile = {
    kind: baseProfile.kind,
    model: selectedModel || baseProfile.model,
    effort: selectedEffort ?? baseProfile.effort,
    permissionMode: effectivePermissionMode,
    extraArgs: [...baseProfile.extraArgs],
  };

  return {
    enabled: true,
    required: explicitlyRequired,
    maxRounds,
    skipIfNoDiff,
    runtime: {
      profileName: selectedAgent,
      kind: effectiveProfile.kind,
      model: effectiveProfile.model,
      effort: effectiveProfile.effort,
      permissionMode: effectiveProfile.permissionMode,
      cliArgs: buildAgentCliArgs(effectiveProfile),
    },
  };
}
