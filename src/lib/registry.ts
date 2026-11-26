import type { BoardClient } from "./board.ts";
import type { ProjectsConfig, SwarmConfig } from "./config.ts";
import {
  MachineRegistryEntrySchema,
  type MachineRegistryEntry,
  type MachineRegistryProject,
  type MergedLeadProjectsCatalog,
} from "./schemas.ts";

export function buildMachineRegistryEntry(params: {
  swarm: SwarmConfig;
  projects: ProjectsConfig;
  machineName: string;
  availableAgentKinds: Set<string>;
  nowIso?: string;
}): MachineRegistryEntry {
  const machine = params.swarm.machines[params.machineName];
  if (!machine) {
    throw new Error(`Machine "${params.machineName}" not found in swarm config`);
  }

  // Expose profile names whose underlying binary is installed on this host
  const installedProfiles = new Set<string>();
  for (const [profileName, profile] of Object.entries(params.swarm.workerDefaults.agents)) {
    if (params.availableAgentKinds.has(profile.kind)) {
      installedProfiles.add(profileName);
    }
  }
  for (const kind of params.availableAgentKinds) {
    installedProfiles.add(kind);
  }

  const hostedProjects: MachineRegistryProject[] = [];
  for (const [slug, proj] of Object.entries(params.projects.projects)) {
    if (proj.paths[params.machineName]) {
      hostedProjects.push({
        slug,
        baseBranch: proj.baseBranch,
        ...(proj.useWorktree !== undefined ? { useWorktree: proj.useWorktree } : {}),
      });
    }
  }
  hostedProjects.sort((a, b) => a.slug.localeCompare(b.slug));

  return MachineRegistryEntrySchema.parse({
    version: 1,
    machine: params.machineName,
    os: machine.os,
    role: machine.role,
    maxWorkers: machine.maxWorkers,
    agents: [...installedProfiles].toSorted(),
    labels: [...machine.labels].toSorted(),
    projects: hostedProjects,
    updatedAt: params.nowIso ?? new Date().toISOString(),
  });
}

export function registryPayloadFingerprint(entry: MachineRegistryEntry): string {
  const { updatedAt: _ignored, ...stable } = entry;
  return JSON.stringify(stable);
}

export function formatRegistryCardMarkdown(entry: MachineRegistryEntry): string {
  const projectRows =
    entry.projects.length > 0
      ? entry.projects
          .map(
            (p) =>
              `| \`${p.slug}\` | \`${p.baseBranch}\` | ${p.useWorktree ? "worktree" : "plain-tab"} |`,
          )
          .join("\n")
      : "| *(none configured yet)* | — | — |";

  return [
    `### Machine Registry: \`${entry.machine}\``,
    "",
    `- **Role:** \`${entry.role}\` · **OS:** \`${entry.os}\` · **Max Workers:** \`${entry.maxWorkers}\``,
    `- **Agents:** ${entry.agents.length > 0 ? entry.agents.map((a) => `\`${a}\``).join(", ") : "*(none)*"}`,
    `- **Labels:** ${entry.labels.map((l) => `\`${l}\``).join(", ")}`,
    "",
    "| Project | Base Branch | Mode |",
    "| --- | --- | --- |",
    projectRows,
    "",
    "```json",
    JSON.stringify(entry, null, 2),
    "```",
  ].join("\n");
}

export function parseRegistryCardMarkdown(text: string): MachineRegistryEntry | null {
  const match = /```json\s*([\s\S]*?)```/i.exec(text);
  const candidate = match?.[1]?.trim() ?? text.trim();
  if (!candidate.startsWith("{")) return null;
  try {
    const raw: unknown = JSON.parse(candidate);
    const parsed = MachineRegistryEntrySchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function publishMachineRegistry(params: {
  board: BoardClient;
  registryChannel: string;
  entry: MachineRegistryEntry;
  asProfile?: string;
}): Promise<{ action: "created" | "updated" | "unchanged"; messageId: string }> {
  const profile = params.asProfile ?? `registry-${params.entry.machine}`;
  await params.board.ensureChannel(params.registryChannel, { asProfile: profile });

  const { threads } = await params.board.readChannel(params.registryChannel, { limit: 100 });
  const targetFingerprint = registryPayloadFingerprint(params.entry);

  for (const thread of threads) {
    if (thread.message.deleted) continue;
    const existing = parseRegistryCardMarkdown(thread.message.text);
    if (!existing || existing.machine !== params.entry.machine) continue;

    if (registryPayloadFingerprint(existing) === targetFingerprint) {
      return { action: "unchanged", messageId: thread.message.id };
    }

    const body = formatRegistryCardMarkdown(params.entry);
    await params.board.editMessage(thread.message.id, body, { asProfile: profile });
    return { action: "updated", messageId: thread.message.id };
  }

  const body = formatRegistryCardMarkdown(params.entry);
  const messageId = await params.board.postMessage(params.registryChannel, body, {
    asProfile: profile,
    labels: [`machine=${params.entry.machine}`, `os=${params.entry.os}`],
  });
  return { action: "created", messageId };
}

export async function readAllMachineRegistryEntries(
  board: BoardClient,
  registryChannel: string,
): Promise<MachineRegistryEntry[]> {
  const { threads } = await board.readChannel(registryChannel, { limit: 100 });
  const byMachine = new Map<string, MachineRegistryEntry>();

  for (const thread of threads) {
    if (thread.message.deleted) continue;
    const entry = parseRegistryCardMarkdown(thread.message.text);
    if (!entry) continue;
    const prev = byMachine.get(entry.machine);
    if (!prev || entry.updatedAt >= prev.updatedAt) {
      byMachine.set(entry.machine, entry);
    }
  }

  return [...byMachine.values()].toSorted((a, b) => a.machine.localeCompare(b.machine));
}

export function mergeRegistryIntoLeadCatalog(params: {
  entries: MachineRegistryEntry[];
  localProjects?: ProjectsConfig | null;
  nowIso?: string;
}): MergedLeadProjectsCatalog {
  const machines: MergedLeadProjectsCatalog["machines"] = {};
  const projectMachines = new Map<string, Set<string>>();
  const projectBaseBranch = new Map<string, string>();
  const localDefaultMachine = new Map<string, string>();

  // Seed from local projects.json if present (fallback when workers haven't published yet)
  if (params.localProjects) {
    for (const [slug, proj] of Object.entries(params.localProjects.projects)) {
      const set = projectMachines.get(slug) ?? new Set<string>();
      for (const m of Object.keys(proj.paths)) {
        set.add(m);
      }
      projectMachines.set(slug, set);
      projectBaseBranch.set(slug, proj.baseBranch);
      if (proj.defaultMachine && proj.defaultMachine !== "any") {
        localDefaultMachine.set(slug, proj.defaultMachine);
      }
    }
  }

  // Merge live advertised machine entries from #swarm/registry
  for (const entry of params.entries) {
    machines[entry.machine] = {
      os: entry.os,
      role: entry.role,
      maxWorkers: entry.maxWorkers,
      agents: entry.agents,
      labels: entry.labels,
      updatedAt: entry.updatedAt,
    };

    for (const proj of entry.projects) {
      const set = projectMachines.get(proj.slug) ?? new Set<string>();
      set.add(entry.machine);
      projectMachines.set(proj.slug, set);
      projectBaseBranch.set(proj.slug, proj.baseBranch);
    }
  }

  const projects: MergedLeadProjectsCatalog["projects"] = {};
  for (const slug of [...projectMachines.keys()].toSorted()) {
    const hosts = [...(projectMachines.get(slug) ?? [])].toSorted();
    const defaultMachine =
      hosts.length === 1
        ? hosts[0]!
        : hosts.length > 1
          ? "any"
          : (localDefaultMachine.get(slug) ?? "any");

    projects[slug] = {
      defaultMachine,
      machines: hosts,
      baseBranch: projectBaseBranch.get(slug) ?? "main",
    };
  }

  return {
    source: "swarm-registry",
    updatedAt: params.nowIso ?? new Date().toISOString(),
    machines,
    projects,
  };
}

export function catalogFingerprint(catalog: MergedLeadProjectsCatalog): string {
  const { updatedAt: _ignored, ...stable } = catalog;
  return JSON.stringify(stable);
}
