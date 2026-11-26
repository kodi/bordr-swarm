import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardClient } from "../src/lib/board.ts";
import {
  BUILTIN_AGENT_KINDS,
  loadProjectsConfigOptional,
  loadSwarmConfig,
  parseProjectsConfig,
  parseSwarmConfig,
  resolveCurrentMachineName,
  resolveReviewerConfig,
  type EffortLevel,
  type ProjectReviewerOverride,
  type ProjectsConfig,
  type SwarmConfig,
} from "../src/lib/config.ts";
import { buildMachineRegistryEntry, publishMachineRegistry } from "../src/lib/registry.ts";

export interface ReviewerCliOptions {
  help: boolean;
  project?: string;
  agent?: string;
  model?: string;
  clearModel: boolean;
  effort?: EffortLevel;
  maxRounds?: number;
  skipIfNoDiff?: boolean;
  mode?: "on" | "off" | "inherit";
  noReload: boolean;
  noPublish: boolean;
}

const VALID_EFFORTS = new Set<string>(["", "low", "medium", "high", "xhigh", "max"]);

export function parseReviewerCliArgs(argv: string[]): ReviewerCliOptions {
  const opts: ReviewerCliOptions = {
    help: false,
    clearModel: false,
    noReload: false,
    noPublish: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === "--help" || flag === "-h") {
      opts.help = true;
    } else if ((flag === "--project" || flag === "-p") && argv[i + 1]) {
      opts.project = argv[i + 1]!;
      i += 1;
    } else if (flag.startsWith("--project=")) {
      opts.project = flag.slice("--project=".length);
    } else if ((flag === "--agent" || flag === "-a") && argv[i + 1]) {
      opts.agent = argv[i + 1]!;
      i += 1;
    } else if (flag.startsWith("--agent=")) {
      opts.agent = flag.slice("--agent=".length);
    } else if ((flag === "--model" || flag === "-m") && argv[i + 1] !== undefined) {
      opts.model = argv[i + 1]!;
      i += 1;
    } else if (flag.startsWith("--model=")) {
      opts.model = flag.slice("--model=".length);
    } else if (flag === "--clear-model") {
      opts.clearModel = true;
    } else if ((flag === "--effort" || flag === "-e") && argv[i + 1] !== undefined) {
      const rawEffort = argv[i + 1]!;
      if (!VALID_EFFORTS.has(rawEffort)) {
        throw new Error(
          `Invalid --effort "${rawEffort}". Valid values: low, medium, high, xhigh, max, or "".`,
        );
      }
      opts.effort = rawEffort as EffortLevel;
      i += 1;
    } else if (flag.startsWith("--effort=")) {
      const rawEffort = flag.slice("--effort=".length);
      if (!VALID_EFFORTS.has(rawEffort)) {
        throw new Error(
          `Invalid --effort "${rawEffort}". Valid values: low, medium, high, xhigh, max, or "".`,
        );
      }
      opts.effort = rawEffort as EffortLevel;
    } else if (flag === "--max-rounds" && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        throw new Error(`Invalid --max-rounds "${argv[i + 1]}". Must be an integer from 1 to 10.`);
      }
      opts.maxRounds = n;
      i += 1;
    } else if (flag.startsWith("--max-rounds=")) {
      const raw = flag.slice("--max-rounds=".length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        throw new Error(`Invalid --max-rounds "${raw}". Must be an integer from 1 to 10.`);
      }
      opts.maxRounds = n;
    } else if (flag === "--skip-no-diff") {
      opts.skipIfNoDiff = true;
    } else if (flag === "--no-skip-no-diff") {
      opts.skipIfNoDiff = false;
    } else if (flag === "--on" || flag === "--enable") {
      opts.mode = "on";
    } else if (flag === "--off" || flag === "--disable") {
      opts.mode = "off";
    } else if (flag === "--inherit" || flag === "--reset") {
      opts.mode = "inherit";
    } else if (flag === "--no-reload") {
      opts.noReload = true;
    } else if (flag === "--no-publish") {
      opts.noPublish = true;
    } else {
      throw new Error(`Unknown option "${flag}". Run \`mise run reviewer -- --help\` for usage.`);
    }
  }

  return opts;
}

export function hasMutationFlags(opts: ReviewerCliOptions): boolean {
  return (
    opts.agent !== undefined ||
    opts.model !== undefined ||
    opts.clearModel ||
    opts.effort !== undefined ||
    opts.maxRounds !== undefined ||
    opts.skipIfNoDiff !== undefined ||
    opts.mode !== undefined
  );
}

/**
 * Mutates a raw `swarm.json` object in-memory (preserving minimal user config keys),
 * validates the full result via Zod, and returns both raw JSON and parsed SwarmConfig.
 */
export function applyWorkerReviewerUpdate(
  rawSwarm: Record<string, unknown>,
  opts: ReviewerCliOptions,
): { nextRaw: Record<string, unknown>; parsed: SwarmConfig } {
  const existingWd =
    typeof rawSwarm.workerDefaults === "object" &&
    rawSwarm.workerDefaults !== null &&
    !Array.isArray(rawSwarm.workerDefaults)
      ? { ...(rawSwarm.workerDefaults as Record<string, unknown>) }
      : {};

  if (opts.mode === "inherit") {
    delete existingWd.reviewer;
    const nextRaw: Record<string, unknown> = { ...rawSwarm };
    if (Object.keys(existingWd).length > 0) {
      nextRaw.workerDefaults = existingWd;
    } else {
      delete nextRaw.workerDefaults;
    }
    const parsed = parseSwarmConfig(nextRaw, "config/swarm.json");
    return { nextRaw, parsed };
  }

  const existingRev =
    typeof existingWd.reviewer === "object" &&
    existingWd.reviewer !== null &&
    !Array.isArray(existingWd.reviewer)
      ? { ...(existingWd.reviewer as Record<string, unknown>) }
      : {};

  const prevAgent = typeof existingRev.agent === "string" ? existingRev.agent : undefined;
  const agentChanged = opts.agent !== undefined && opts.agent !== prevAgent;

  if (opts.mode === "off") {
    existingRev.enabled = false;
  } else if (opts.mode === "on") {
    existingRev.enabled = true;
  } else if (existingRev.enabled === false || existingRev.enabled === undefined) {
    existingRev.enabled = true;
  }

  if (opts.agent !== undefined) {
    existingRev.agent = opts.agent;
  }
  if (opts.clearModel) {
    delete existingRev.model;
  } else if (opts.model !== undefined) {
    existingRev.model = opts.model;
  } else if (agentChanged) {
    delete existingRev.model;
  }
  if (opts.effort !== undefined) {
    existingRev.effort = opts.effort;
  }
  if (opts.maxRounds !== undefined) {
    existingRev.maxRounds = opts.maxRounds;
  }
  if (opts.skipIfNoDiff !== undefined) {
    existingRev.skipIfNoDiff = opts.skipIfNoDiff;
  }

  existingWd.reviewer = existingRev;
  const nextRaw: Record<string, unknown> = {
    ...rawSwarm,
    workerDefaults: existingWd,
  };
  const parsed = parseSwarmConfig(nextRaw, "config/swarm.json");
  // Also validate that resolved reviewer profile builds cleanly
  resolveReviewerConfig(parsed.workerDefaults);
  return { nextRaw, parsed };
}

/**
 * Updates a single project's reviewer override in `projects.json` and validates with Zod.
 */
export function applyProjectReviewerUpdate(
  projectsCfg: ProjectsConfig,
  swarm: SwarmConfig,
  slug: string,
  opts: ReviewerCliOptions,
): ProjectsConfig {
  const existingProj = projectsCfg.projects[slug];
  if (!existingProj) {
    const known = Object.keys(projectsCfg.projects);
    const hint =
      known.length > 0
        ? `Registered projects: ${known.join(", ")}`
        : "No projects registered yet (run: mise run project:add -- ~/path/to/repo)";
    throw new Error(`Project "${slug}" not found in config/projects.json. ${hint}`);
  }

  let nextReviewer: ProjectReviewerOverride | undefined;
  if (opts.mode === "inherit") {
    nextReviewer = undefined;
  } else {
    const current: ProjectReviewerOverride = { ...existingProj.reviewer };
    const agentChanged = opts.agent !== undefined && opts.agent !== current.agent;

    if (opts.mode === "off") {
      current.enabled = false;
    } else if (opts.mode === "on") {
      current.enabled = true;
    } else {
      current.enabled = true;
    }

    if (opts.agent !== undefined) {
      current.agent = opts.agent;
    }
    if (opts.clearModel) {
      delete current.model;
    } else if (opts.model !== undefined) {
      current.model = opts.model;
    } else if (agentChanged) {
      delete current.model;
    }
    if (opts.effort !== undefined) {
      current.effort = opts.effort;
    }
    if (opts.maxRounds !== undefined) {
      current.maxRounds = opts.maxRounds;
    }
    if (opts.skipIfNoDiff !== undefined) {
      current.skipIfNoDiff = opts.skipIfNoDiff;
    }
    nextReviewer = current;
  }

  const { reviewer: _oldReviewer, ...restProj } = existingProj;
  const updatedProj = nextReviewer ? { ...restProj, reviewer: nextReviewer } : restProj;

  const candidate: ProjectsConfig = {
    ...(projectsCfg.$schema ? { $schema: projectsCfg.$schema } : {}),
    projects: {
      ...projectsCfg.projects,
      [slug]: updatedProj,
    },
  };

  const validated = parseProjectsConfig(candidate, "config/projects.json");
  resolveReviewerConfig(swarm.workerDefaults, validated.projects[slug]);
  return validated;
}

function detectInstalledAgents(swarm: SwarmConfig): Set<string> {
  const available = new Set<string>();
  const kinds = new Set<string>(BUILTIN_AGENT_KINDS);
  for (const p of Object.values(swarm.workerDefaults.agents)) {
    kinds.add(p.kind);
  }
  for (const kind of kinds) {
    try {
      execFileSync("which", [kind], { stdio: "ignore", timeout: 5_000 });
      available.add(kind);
    } catch {
      // Not installed
    }
  }
  return available;
}

function formatReviewerSummary(
  swarm: SwarmConfig,
  installed: Set<string>,
  project?: ProjectsConfig["projects"][string],
): string {
  const resolved = resolveReviewerConfig(swarm.workerDefaults, project);
  if (!resolved.enabled || !resolved.runtime) {
    return "disabled";
  }
  const rt = resolved.runtime;
  const modelPart = rt.model ? ` model=${rt.model}` : " model=<default>";
  const effortPart = rt.effort ? ` effort=${rt.effort}` : "";
  const binWarn = installed.has(rt.kind) ? "" : ` [WARN: "${rt.kind}" not in PATH]`;
  return `${rt.profileName}${modelPart}${effortPart} (maxRounds=${resolved.maxRounds}, skipIfNoDiff=${resolved.skipIfNoDiff})${binWarn}`;
}

function printStatus(
  swarm: SwarmConfig,
  projects: ProjectsConfig,
  machineName: string,
  installed: Set<string>,
): void {
  console.log(`Reviewer configuration on "${machineName}":`);
  console.log(`  Worker default: ${formatReviewerSummary(swarm, installed)}`);

  const localProjects = Object.entries(projects.projects).filter(([, p]) =>
    Boolean(p.paths[machineName]),
  );
  if (localProjects.length === 0) {
    console.log(
      "  Projects:       none registered yet (run: mise run project:add -- ~/path/to/repo)",
    );
    return;
  }

  console.log("  Projects:");
  for (const [slug, proj] of localProjects) {
    const source = proj.reviewer ? "project override" : "inherits default";
    const summary = formatReviewerSummary(swarm, installed, proj);
    console.log(`    - ${slug.padEnd(20)} ${summary}  [${source}]`);
  }
}

function printUsage(): void {
  console.log(`Usage:
  mise run reviewer                                                      Show current default & per-project reviewers
  mise run reviewer -- --agent <name> [--model <id>] [--effort <lvl>] [--max-rounds <n>]
                                                                         Set worker-wide default reviewer in swarm.json
  mise run reviewer -- --off | --on | --reset                            Disable, enable, or remove worker default reviewer
  mise run reviewer -- --project <slug> --agent <name> [--model <id>] [--effort <lvl>] [--max-rounds <n>]
                                                                         Override reviewer for a single project
  mise run reviewer -- --project <slug> --off | --on | --inherit         Disable, enable, or inherit default for a project

Options:
  -p, --project <slug>       Target a registered project slug instead of the worker default
  -a, --agent <profile>      Agent profile (claude, agy, codex, pi, or custom profile key)
  -m, --model <model>        Model override (e.g. openai-codex/gpt-5.4, opus); use --clear-model to inherit CLI default
      --clear-model          Remove explicit model override and use the agent CLI's default model
  -e, --effort <level>       Reasoning effort (low, medium, high, xhigh, max)
      --max-rounds <1-10>    Max review/fix rounds before escalating to [BLOCKED] (default 2)
      --skip-no-diff         Skip review when there are no local Git changes (default)
      --no-skip-no-diff      Always run review even when there are no local Git changes
      --on / --off           Enable or disable review
      --inherit / --reset    Remove project override (inherit default) or reset worker default
      --no-reload            Do not reload the worker Dispatcher service after updating swarm.json
      --no-publish           Do not publish updated #swarm/registry card

Examples:
  mise run reviewer -- --agent codex --effort high --max-rounds 2
  mise run reviewer -- --project my-app --agent pi --model openai-codex/gpt-5.4 --effort high
  mise run reviewer -- --project notes-repo --off
  mise run reviewer -- --project my-app --inherit`);
}

async function publishRegistryBestEffort(
  swarm: SwarmConfig,
  projects: ProjectsConfig,
  machineName: string,
  installed: Set<string>,
): Promise<void> {
  try {
    const board = new BoardClient({ scope: swarm.board.scope, boardName: swarm.board.boardName });
    const entry = buildMachineRegistryEntry({
      swarm,
      projects,
      machineName,
      availableAgentKinds: installed,
    });
    const res = await publishMachineRegistry({
      board,
      registryChannel: swarm.board.registryChannel,
      entry,
    });
    console.log(`[reviewer] Updated #${swarm.board.registryChannel} (${res.action}).`);
  } catch (err) {
    console.warn(
      `[reviewer] Warning: could not publish #${swarm.board.registryChannel}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function main(): Promise<void> {
  const opts = parseReviewerCliArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return;
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const swarmPath = process.env.SWARM_CONFIG_PATH ?? resolve(repoRoot, "config/swarm.json");
  const projectsPath =
    process.env.PROJECTS_CONFIG_PATH ?? resolve(repoRoot, "config/projects.json");

  const swarm = loadSwarmConfig(repoRoot, swarmPath);
  const projects = loadProjectsConfigOptional(repoRoot, projectsPath);
  const machineName = resolveCurrentMachineName(swarm, undefined, "worker");
  const installed = detectInstalledAgents(swarm);

  if (!hasMutationFlags(opts)) {
    printStatus(swarm, projects, machineName, installed);
    return;
  }

  if (opts.project) {
    const updatedProjects = applyProjectReviewerUpdate(projects, swarm, opts.project, opts);
    mkdirSync(dirname(projectsPath), { recursive: true });
    const output = {
      $schema: "./projects.schema.json",
      projects: updatedProjects.projects,
    };
    writeFileSync(projectsPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(
      `[reviewer] Updated project "${opts.project}" in ${projectsPath} (Dispatcher hot-reloads automatically):`,
    );
    console.log(
      `  -> ${formatReviewerSummary(swarm, installed, updatedProjects.projects[opts.project])}`,
    );

    if (!opts.noPublish) {
      await publishRegistryBestEffort(swarm, updatedProjects, machineName, installed);
    }
    return;
  }

  // Update worker-wide default in config/swarm.json
  if (!existsSync(swarmPath)) {
    throw new Error(`Config file not found: ${swarmPath} (run: mise run init)`);
  }
  const rawSwarm = JSON.parse(readFileSync(swarmPath, "utf8")) as Record<string, unknown>;
  const { nextRaw, parsed } = applyWorkerReviewerUpdate(rawSwarm, opts);
  writeFileSync(swarmPath, `${JSON.stringify(nextRaw, null, 2)}\n`, "utf8");
  console.log(`[reviewer] Updated worker default in ${swarmPath}:`);
  console.log(`  -> ${formatReviewerSummary(parsed, installed)}`);

  if (!opts.noReload) {
    const machineCfg = parsed.machines[machineName];
    if (
      machineCfg &&
      (machineCfg.role === "worker" || machineCfg.role === "both" || machineCfg.maxWorkers > 0)
    ) {
      console.log("[reviewer] Reloading Worker Dispatcher service...");
      execFileSync(process.execPath, [resolve(repoRoot, "scripts/apply-worker.ts")], {
        cwd: repoRoot,
        stdio: "inherit",
      });
    }
  }

  if (!opts.noPublish) {
    await publishRegistryBestEffort(parsed, projects, machineName, installed);
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
