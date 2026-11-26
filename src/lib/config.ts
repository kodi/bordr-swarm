import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import {
  ProjectsConfigSchema,
  SwarmConfigSchema,
  type BoardConfig,
  type LeadConfig,
  type MachineOs,
  type MachineRole,
  type ProjectConfig,
  type ProjectsConfig,
  type WorkerAgentProfile,
  type WorkerDefaultsConfig,
} from "./schemas.ts";

export type {
  BoardConfig,
  LeadConfig,
  MachineOs,
  MachineRole,
  ProjectConfig,
  ProjectsConfig,
  WorkerAgentProfile,
  WorkerDefaultsConfig,
};

export interface MachineConfig {
  role: MachineRole;
  os: MachineOs;
  hostname: string;
  allowedHosts: string[];
  herdrTarget: string;
  maxWorkers: number;
  labels: string[];
}

export interface SwarmConfig {
  board: BoardConfig;
  lead: LeadConfig;
  workerDefaults: WorkerDefaultsConfig;
  machines: Record<string, MachineConfig>;
}

export interface ResolvedWorkerRuntime {
  profileName: string;
  kind: string;
  model: string;
  effort: string;
  permissionMode: string;
  cliArgs: string[];
}

const BUILTIN_AGENT_PROFILES: Record<string, WorkerAgentProfile> = {
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

  for (const [machineName, m] of Object.entries(parsed.machines)) {
    const role: MachineRole =
      m.role ??
      (machineName === parsed.lead.machine ? (m.maxWorkers > 0 ? "both" : "main") : "worker");

    const labelSet = new Set(m.labels);
    labelSet.add(`machine=${machineName}`);
    labelSet.add(`os=${m.os}`);

    machines[machineName] = {
      role,
      os: m.os,
      hostname: m.hostname ?? machineName,
      allowedHosts: m.allowedHosts,
      herdrTarget: m.herdrTarget,
      maxWorkers: m.maxWorkers,
      labels: [...labelSet],
    };
  }

  return {
    board: {
      ...parsed.board,
      scope: (process.env.VERCEL_SCOPE || parsed.board.scope).trim(),
      boardName: (process.env.VERCEL_BOARD_NAME || parsed.board.boardName).trim(),
    },
    lead: parsed.lead,
    workerDefaults: parsed.workerDefaults,
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
