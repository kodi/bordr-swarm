import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardClient } from "../src/lib/board.ts";
import {
  loadProjectsConfig,
  loadSwarmConfig,
  resolveCurrentMachineName,
  type ProjectsConfig,
  type SwarmConfig,
} from "../src/lib/config.ts";
import { buildMachineRegistryEntry, publishMachineRegistry } from "../src/lib/registry.ts";

function expandHome(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/")) return resolve(homedir(), inputPath.slice(2));
  return resolve(inputPath);
}

function detectGitBaseBranch(repoPath: string): string {
  try {
    const ref = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
    const parts = ref.split("/");
    return parts.at(-1) || "main";
  } catch {
    try {
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: repoPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      }).trim();
      return branch && branch !== "HEAD" ? branch : "main";
    } catch {
      return "main";
    }
  }
}

function detectInstalledAgents(swarm: SwarmConfig): Set<string> {
  const available = new Set<string>();
  const kinds = new Set<string>(["claude", "agy"]);
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

function loadOrInitProjects(repoRoot: string, projectsPath: string): ProjectsConfig {
  if (!existsSync(projectsPath)) {
    return { $schema: "./projects.schema.json", projects: {} };
  }
  return loadProjectsConfig(repoRoot, projectsPath);
}

function saveProjects(projectsPath: string, data: ProjectsConfig): void {
  mkdirSync(dirname(projectsPath), { recursive: true });
  const output = {
    $schema: "./projects.schema.json",
    projects: data.projects,
  };
  writeFileSync(projectsPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

function printUsage(): void {
  console.log("Usage:");
  console.log(
    "  mise run project:add -- <path> [--slug <name>] [--branch <base>] [--worktree] [--no-publish]",
  );
  console.log("  mise run project:rm -- <slug> [--no-publish]");
  console.log("  mise run project:ls");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const swarm = loadSwarmConfig(repoRoot);
  const projectsPath =
    process.env.PROJECTS_CONFIG_PATH ?? resolve(repoRoot, "config/projects.json");
  const machineName = resolveCurrentMachineName(swarm, undefined, "worker");

  if (subcommand === "ls" || subcommand === "list") {
    if (!existsSync(projectsPath)) {
      console.log(`No local ${projectsPath} found on ${machineName}.`);
      return;
    }
    const projects = loadProjectsConfig(repoRoot, projectsPath);
    const entries = Object.entries(projects.projects).filter(([, p]) =>
      Boolean(p.paths[machineName]),
    );
    if (entries.length === 0) {
      console.log(`No projects configured for machine "${machineName}".`);
      return;
    }
    console.log(`Projects configured on "${machineName}":`);
    for (const [slug, proj] of entries) {
      console.log(`  - ${slug} -> ${proj.paths[machineName]} (base=${proj.baseBranch})`);
    }
    return;
  }

  const noPublish = args.includes("--no-publish");

  if (subcommand === "add") {
    const rawPath = args[1];
    if (!rawPath || rawPath.startsWith("-")) {
      throw new Error(
        "Missing project path. Example: mise run project:add -- ~/data/personal/my-app",
      );
    }

    let customSlug = "";
    let customBranch = "";
    let useWorktree: boolean | undefined;

    for (let i = 2; i < args.length; i += 1) {
      const flag = args[i];
      if (flag === "--slug" && args[i + 1]) {
        customSlug = args[i + 1]!;
        i += 1;
      } else if (flag === "--branch" && args[i + 1]) {
        customBranch = args[i + 1]!;
        i += 1;
      } else if (flag === "--worktree") {
        useWorktree = true;
      }
    }

    const fullPath = expandHome(rawPath);
    if (!existsSync(fullPath) || !statSync(fullPath).isDirectory()) {
      throw new Error(`Directory does not exist: ${fullPath}`);
    }

    const slug = (customSlug || basename(fullPath)).replace(/[^a-zA-Z0-9._-]/g, "-");
    const baseBranch = customBranch || detectGitBaseBranch(fullPath);

    const cfg = loadOrInitProjects(repoRoot, projectsPath);
    const existing = cfg.projects[slug];
    cfg.projects[slug] = {
      defaultMachine: existing?.defaultMachine ?? machineName,
      baseBranch: customBranch || existing?.baseBranch || baseBranch,
      useWorktree: useWorktree ?? existing?.useWorktree ?? false,
      paths: {
        ...existing?.paths,
        [machineName]: fullPath,
      },
    };

    saveProjects(projectsPath, cfg);
    console.log(
      `[project:add] Registered "${slug}" -> ${fullPath} (machine=${machineName}, base=${cfg.projects[slug]!.baseBranch})`,
    );

    if (!noPublish) {
      const board = new BoardClient({ scope: swarm.board.scope, boardName: swarm.board.boardName });
      const entry = buildMachineRegistryEntry({
        swarm,
        projects: cfg,
        machineName,
        availableAgentKinds: detectInstalledAgents(swarm),
      });
      const res = await publishMachineRegistry({
        board,
        registryChannel: swarm.board.registryChannel,
        entry,
      });
      console.log(
        `[project:add] Published #${swarm.board.registryChannel} (${res.action}) — Lead will pick it up automatically!`,
      );
    }
    return;
  }

  if (subcommand === "rm" || subcommand === "remove") {
    const slug = args[1];
    if (!slug || slug.startsWith("-")) {
      throw new Error("Missing project slug. Example: mise run project:rm -- my-app");
    }

    const cfg = loadOrInitProjects(repoRoot, projectsPath);
    const proj = cfg.projects[slug];
    if (!proj || !proj.paths[machineName]) {
      console.log(`[project:rm] "${slug}" is not registered on "${machineName}".`);
      return;
    }

    delete proj.paths[machineName];
    if (Object.keys(proj.paths).length === 0) {
      delete cfg.projects[slug];
    }

    saveProjects(projectsPath, cfg);
    console.log(`[project:rm] Removed "${slug}" from "${machineName}".`);

    if (!noPublish) {
      const board = new BoardClient({ scope: swarm.board.scope, boardName: swarm.board.boardName });
      const entry = buildMachineRegistryEntry({
        swarm,
        projects: cfg,
        machineName,
        availableAgentKinds: detectInstalledAgents(swarm),
      });
      const res = await publishMachineRegistry({
        board,
        registryChannel: swarm.board.registryChannel,
        entry,
      });
      console.log(`[project:rm] Updated #${swarm.board.registryChannel} (${res.action}).`);
    }
    return;
  }

  // Fallback for checking raw file
  if (existsSync(projectsPath)) {
    readFileSync(projectsPath, "utf8");
  }
  throw new Error(`Unknown project subcommand "${subcommand}". Use add, rm, or ls.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
