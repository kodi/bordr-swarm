import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadProjectsConfig,
  loadSwarmConfig,
  validateSwarmAndProjects,
  type ProjectsConfig,
  type SwarmConfig,
} from "../src/lib/config.ts";

type CheckStatus = "ok" | "warn" | "fail";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

function runCommand(cmd: string, args: string[]): { ok: boolean; output: string } {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    return { ok: true, output: out.trim() };
  } catch (err) {
    const message =
      err instanceof Error
        ? ((err as { stderr?: string; stdout?: string }).stderr || err.message).trim()
        : String(err);
    return { ok: false, output: message };
  }
}

function checkVersion(
  name: string,
  cmd: string,
  args: string[],
  optional = false,
): CheckResult {
  const res = runCommand(cmd, args);
  if (!res.ok) {
    return {
      name,
      status: optional ? "warn" : "fail",
      detail: `${optional ? "optional — " : ""}not found or failed (${res.output.split("\n")[0]})`,
    };
  }
  return { name, status: "ok", detail: res.output.split("\n")[0]?.trim() || "installed" };
}

const repoRoot = process.cwd();
const results: CheckResult[] = [
  checkVersion("node", "node", ["--version"]),
  checkVersion("mise", "mise", ["--version"]),
  checkVersion("vercel", "vercel", ["--version"]),
  checkVersion("board (@vercel/board)", "board", ["--help"], true),
  checkVersion("herdr", "herdr", ["--version"]),
  checkVersion("claude", "claude", ["--version"]),
  checkVersion("agy", "agy", ["--help"], true),
];

// Validate swarm.json and projects.json via Zod schemas
let loadedSwarm: SwarmConfig | null = null;
let loadedProjects: ProjectsConfig | null = null;

const swarmPath = process.env.SWARM_CONFIG_PATH ?? resolve(repoRoot, "config/swarm.json");
if (!existsSync(swarmPath)) {
  results.push({
    name: "swarm config",
    status: "warn",
    detail: "missing config/swarm.json (copy from config/swarm.example.json)",
  });
} else {
  try {
    loadedSwarm = loadSwarmConfig(repoRoot, swarmPath);
    results.push({
      name: "swarm config",
      status: "ok",
      detail: `valid (${Object.keys(loadedSwarm.machines).length} machines, defaultAgent=${loadedSwarm.workerDefaults.defaultAgent})`,
    });
  } catch (err) {
    results.push({
      name: "swarm config",
      status: "fail",
      detail: err instanceof Error ? err.message.replaceAll("\n", " | ") : String(err),
    });
  }
}

const projectsPath = process.env.PROJECTS_CONFIG_PATH ?? resolve(repoRoot, "config/projects.json");
if (!existsSync(projectsPath)) {
  results.push({
    name: "projects config",
    status: "warn",
    detail: "missing config/projects.json (copy from config/projects.example.json)",
  });
} else {
  try {
    loadedProjects = loadProjectsConfig(repoRoot, projectsPath);
    results.push({
      name: "projects config",
      status: "ok",
      detail: `valid (${Object.keys(loadedProjects.projects).length} projects)`,
    });
  } catch (err) {
    results.push({
      name: "projects config",
      status: "fail",
      detail: err instanceof Error ? err.message.replaceAll("\n", " | ") : String(err),
    });
  }
}

if (loadedSwarm && loadedProjects) {
  const warnings = validateSwarmAndProjects(loadedSwarm, loadedProjects);
  if (warnings.length > 0) {
    results.push({
      name: "config cross-check",
      status: "warn",
      detail: warnings.join(" ; "),
    });
  } else {
    results.push({
      name: "config cross-check",
      status: "ok",
      detail: "all project machines match swarm.json",
    });
  }
}

// Check Vercel Board auth
const boardWhoami = runCommand("vercel", ["board", "whoami"]);
results.push(
  boardWhoami.ok
    ? {
        name: "vercel board whoami",
        status: "ok",
        detail: boardWhoami.output.split("\n").slice(0, 2).join(" | "),
      }
    : {
        name: "vercel board whoami",
        status: "warn",
        detail: boardWhoami.output.split("\n")[0] ?? "not authenticated",
      },
);

// Check Herdr server status
const herdrStatus = runCommand("herdr", ["status", "server"]);
results.push(
  herdrStatus.ok
    ? { name: "herdr server", status: "ok", detail: herdrStatus.output.split("\n")[0] ?? "running" }
    : {
        name: "herdr server",
        status: "warn",
        detail: herdrStatus.output.split("\n")[0] ?? "unreachable",
      },
);

const icons: Record<CheckStatus, string> = {
  ok: "[OK]  ",
  warn: "[WARN]",
  fail: "[FAIL]",
};

let hasFailure = false;
for (const r of results) {
  if (r.status === "fail") hasFailure = true;
  console.log(`${icons[r.status]} ${r.name.padEnd(22)} ${r.detail}`);
}

process.exit(hasFailure ? 1 : 0);
