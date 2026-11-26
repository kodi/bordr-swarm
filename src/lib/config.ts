import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

export type MachineOs = "linux" | "macos";
export type MachineRole = "main" | "worker" | "both";

export interface BoardConfig {
  scope: string;
  boardName: string;
  inboxChannel: string;
  projectChannelPrefix: string;
  humanHandle: string;
  viewerPort: number;
  viewerUrl: string;
  leaseDuration: string;
  leaseRenewIntervalSeconds: number;
}

export interface LeadConfig {
  machine: string;
  boardProfile: string;
  model: string;
  effort: string;
  permissionMode: string;
  workspaceDir: string;
}

export interface WorkerAgentProfile {
  kind: string;
  model: string;
  effort: string;
  permissionMode: string;
  extraArgs: string[];
}

export interface WorkerDefaultsConfig {
  defaultAgent: string;
  agents: Record<string, WorkerAgentProfile>;
  useWorktree: boolean;
  closeTabOnComplete: boolean;
  keepTabOnBlockedOrFailed: boolean;
  maxParkedTabs: number;
  pollIntervalSeconds: number;
  idleTimeoutSeconds: number;
  claimWaitSeconds: number;
}

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

export interface ProjectConfig {
  defaultMachine: string;
  baseBranch: string;
  useWorktree?: boolean;
  paths: Record<string, string>;
}

export interface ProjectsConfig {
  projects: Record<string, ProjectConfig>;
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

function readJsonFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string");
}

function parseMachineOs(rawOs: unknown, labels: string[]): MachineOs {
  const explicit = asString(rawOs, "").toLowerCase();
  if (explicit === "macos" || explicit === "darwin") return "macos";
  if (explicit === "linux") return "linux";
  if (labels.some((l) => l.toLowerCase() === "os=macos")) return "macos";
  return "linux";
}

function parseMachineRole(
  rawRole: unknown,
  machineName: string,
  leadMachine: string,
  maxWorkers: number,
): MachineRole {
  const explicit = asString(rawRole, "").toLowerCase();
  if (explicit === "main" || explicit === "worker" || explicit === "both") {
    return explicit;
  }
  if (machineName === leadMachine) {
    return maxWorkers > 0 ? "both" : "main";
  }
  return "worker";
}

function parseAgentProfile(
  name: string,
  raw: unknown,
  fallbackKind?: string,
): WorkerAgentProfile {
  const obj =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const builtin = BUILTIN_AGENT_PROFILES[name];
  return {
    kind: asString(obj.kind, fallbackKind ?? builtin?.kind ?? name),
    model: asString(obj.model, builtin?.model ?? ""),
    effort: asString(obj.effort, builtin?.effort ?? ""),
    permissionMode: asString(obj.permissionMode, builtin?.permissionMode ?? "auto"),
    extraArgs: asStringArray(obj.extraArgs, builtin?.extraArgs ?? []),
  };
}

export function currentPlatformOs(): MachineOs {
  return process.platform === "darwin" ? "macos" : "linux";
}

export function loadSwarmConfig(repoRoot = process.cwd(), configPath?: string): SwarmConfig {
  const resolvedPath =
    configPath ?? process.env.SWARM_CONFIG_PATH ?? resolve(repoRoot, "config/swarm.json");
  const raw = readJsonFile(resolvedPath);

  const rawBoard = (raw.board ?? {}) as Record<string, unknown>;
  const rawLead = (raw.lead ?? {}) as Record<string, unknown>;
  const rawWorker = (raw.workerDefaults ?? {}) as Record<string, unknown>;
  const rawMachines = (raw.machines ?? {}) as Record<string, unknown>;

  const agents: Record<string, WorkerAgentProfile> = {};
  const rawAgents = rawWorker.agents;
  if (typeof rawAgents === "object" && rawAgents !== null && !Array.isArray(rawAgents)) {
    for (const [key, value] of Object.entries(rawAgents as Record<string, unknown>)) {
      agents[key] = parseAgentProfile(key, value);
    }
  }

  // Backward compatibility if a config only defines top-level workerDefaults.kind/model/effort
  if (Object.keys(agents).length === 0) {
    const legacyKind = asString(rawWorker.kind, "claude");
    agents[legacyKind] = {
      kind: legacyKind,
      model: asString(rawWorker.model, legacyKind === "claude" ? "opus" : ""),
      effort: asString(rawWorker.effort, "medium"),
      permissionMode: asString(rawWorker.permissionMode, "auto"),
      extraArgs: asStringArray(rawWorker.extraArgs, []),
    };
  }

  const defaultAgent = asString(
    rawWorker.defaultAgent,
    agents.claude ? "claude" : (Object.keys(agents)[0] ?? "claude"),
  );

  const machineNames = Object.keys(rawMachines);
  const leadMachine = asString(rawLead.machine, machineNames[0] ?? "main-machine");

  const machines: Record<string, MachineConfig> = {};
  for (const [machineName, value] of Object.entries(rawMachines)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const m = value as Record<string, unknown>;
    const rawLabels = asStringArray(m.labels, []);
    const os = parseMachineOs(m.os, rawLabels);
    const maxWorkers = Math.max(0, Math.floor(asNumber(m.maxWorkers, 0)));
    const role = parseMachineRole(m.role, machineName, leadMachine, maxWorkers);
    const machineHostname = asString(m.hostname, machineName);
    const allowedHosts = asStringArray(m.allowedHosts, []);

    const labelSet = new Set(rawLabels);
    labelSet.add(`machine=${machineName}`);
    labelSet.add(`os=${os}`);

    machines[machineName] = {
      role,
      os,
      hostname: machineHostname,
      allowedHosts,
      herdrTarget: asString(m.herdrTarget, "local"),
      maxWorkers,
      labels: [...labelSet],
    };
  }

  if (Object.keys(machines).length === 0) {
    throw new Error(`No machines defined in ${resolvedPath}`);
  }

  const rawPrefix = asString(rawBoard.projectChannelPrefix, "projects/");
  const normalizedPrefix = rawPrefix.endsWith("/") ? rawPrefix : `${rawPrefix}/`;

  return {
    board: {
      scope: asString(process.env.VERCEL_SCOPE || rawBoard.scope, ""),
      boardName: asString(process.env.VERCEL_BOARD_NAME || rawBoard.boardName, ""),
      inboxChannel: asString(rawBoard.inboxChannel, "inbox"),
      projectChannelPrefix: normalizedPrefix,
      humanHandle: asString(rawBoard.humanHandle, "@owner"),
      viewerPort: Math.max(1, Math.floor(asNumber(rawBoard.viewerPort, 4747))),
      viewerUrl: asString(rawBoard.viewerUrl, "http://main-machine:4748"),
      leaseDuration: asString(rawBoard.leaseDuration, "15m"),
      leaseRenewIntervalSeconds: Math.max(30, asNumber(rawBoard.leaseRenewIntervalSeconds, 300)),
    },
    lead: {
      machine: leadMachine,
      boardProfile: asString(rawLead.boardProfile, "lead"),
      model: asString(rawLead.model, "opus"),
      effort: asString(rawLead.effort, "high"),
      permissionMode: asString(rawLead.permissionMode, "auto"),
      workspaceDir: asString(rawLead.workspaceDir, "~/swarm-hq"),
    },
    workerDefaults: {
      defaultAgent,
      agents,
      useWorktree: asBoolean(rawWorker.useWorktree, false),
      closeTabOnComplete: asBoolean(rawWorker.closeTabOnComplete, true),
      keepTabOnBlockedOrFailed: asBoolean(rawWorker.keepTabOnBlockedOrFailed, true),
      maxParkedTabs: Math.max(0, Math.floor(asNumber(rawWorker.maxParkedTabs, 4))),
      pollIntervalSeconds: Math.max(3, asNumber(rawWorker.pollIntervalSeconds, 15)),
      idleTimeoutSeconds: Math.max(5, asNumber(rawWorker.idleTimeoutSeconds, 30)),
      claimWaitSeconds: Math.max(5, asNumber(rawWorker.claimWaitSeconds, 30)),
    },
    machines,
  };
}

export function loadProjectsConfig(
  repoRoot = process.cwd(),
  configPath?: string,
): ProjectsConfig {
  const resolvedPath =
    configPath ?? process.env.PROJECTS_CONFIG_PATH ?? resolve(repoRoot, "config/projects.json");
  const raw = readJsonFile(resolvedPath);
  const rawProjects = (raw.projects ?? {}) as Record<string, unknown>;

  const projects: Record<string, ProjectConfig> = {};
  for (const [slug, value] of Object.entries(rawProjects)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const p = value as Record<string, unknown>;
    const paths: Record<string, string> = {};
    if (typeof p.paths === "object" && p.paths !== null && !Array.isArray(p.paths)) {
      for (const [machine, pathVal] of Object.entries(p.paths as Record<string, unknown>)) {
        if (typeof pathVal === "string" && pathVal.trim().length > 0) {
          paths[machine] = pathVal;
        }
      }
    }
    projects[slug] = {
      defaultMachine: asString(p.defaultMachine, "any"),
      baseBranch: asString(p.baseBranch, "main"),
      useWorktree: typeof p.useWorktree === "boolean" ? p.useWorktree : undefined,
      paths,
    };
  }

  return { projects };
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
      } else if (mode === "acceptEdits" || mode === "accept-edits") {
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

  const effectiveProfile: WorkerAgentProfile = {
    kind: baseProfile.kind,
    model: taskLabels.model?.trim() || baseProfile.model,
    effort: taskLabels.effort?.trim() || baseProfile.effort,
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
