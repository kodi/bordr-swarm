import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadProjectsConfig,
  loadSwarmConfig,
  resolveCurrentMachineName,
  validateSwarmAndProjects,
  type ProjectsConfig,
  type SwarmConfig,
} from "../src/lib/config.ts";
import {
  detectLinuxLinger,
  detectTailscaleInfo,
  detectVercelBoardIdentity,
  firstMeaningfulLine,
  runQuickCommand,
} from "../src/lib/host-env.ts";

type CheckStatus = "ok" | "warn" | "fail";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

function checkVersion(
  name: string,
  cmd: string,
  args: string[],
  options: { optional?: boolean; fixHint?: string } = {},
): CheckResult {
  const res = runQuickCommand(cmd, args);
  if (!res.ok) {
    const hint = options.fixHint ? ` — ${options.fixHint}` : "";
    return {
      name,
      status: options.optional ? "warn" : "fail",
      detail: `${options.optional ? "optional — " : ""}not found or failed (${firstMeaningfulLine(res.output)})${hint}`,
    };
  }
  return { name, status: "ok", detail: firstMeaningfulLine(res.output) || "installed" };
}

const repoRoot = process.cwd();
const results: CheckResult[] = [
  checkVersion("node", "node", ["--version"], { fixHint: "run: mise install" }),
  checkVersion("mise", "mise", ["--version"], { fixHint: "run: ./scripts/bootstrap.sh" }),
  checkVersion("vercel", "vercel", ["--version"], { fixHint: "run: mise install" }),
  checkVersion("board (@vercel/board)", "board", ["--help"], {
    optional: true,
    fixHint: "run: mise install",
  }),
  checkVersion("herdr", "herdr", ["--version"], {
    fixHint: "install Herdr / Sheprd and ensure `herdr` is in PATH",
  }),
  checkVersion("claude", "claude", ["--version"], {
    fixHint: "install Claude Code CLI (`claude`)",
  }),
  checkVersion("agy", "agy", ["--help"], { optional: true }),
];

// Validate swarm.json and projects.json via Zod schemas
let loadedSwarm: SwarmConfig | null = null;
let loadedProjects: ProjectsConfig | null = null;
let currentMachineName: string | null = null;

const swarmPath = process.env.SWARM_CONFIG_PATH ?? resolve(repoRoot, "config/swarm.json");
if (!existsSync(swarmPath)) {
  results.push({
    name: "swarm config",
    status: "warn",
    detail: "missing config/swarm.json (run: mise run init)",
  });
} else {
  try {
    loadedSwarm = loadSwarmConfig(repoRoot, swarmPath);
    currentMachineName = resolveCurrentMachineName(loadedSwarm);
    const machineCfg = loadedSwarm.machines[currentMachineName]!;
    results.push({
      name: "swarm config",
      status: "ok",
      detail: `valid (this host="${currentMachineName}", role=${machineCfg.role}, os=${machineCfg.os}, maxWorkers=${machineCfg.maxWorkers})`,
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
  const machineCfg =
    loadedSwarm && currentMachineName ? loadedSwarm.machines[currentMachineName] : null;
  const isMainOnly = machineCfg?.role === "main" && machineCfg.maxWorkers === 0;
  results.push({
    name: "projects config",
    status: "ok",
    detail: isMainOnly
      ? "optional on main-only host (Lead auto-syncs from #swarm/registry)"
      : "none registered yet (run: mise run project:add -- ~/path/to/your-repo)",
  });
} else {
  try {
    loadedProjects = loadProjectsConfig(repoRoot, projectsPath);
    results.push({
      name: "projects config",
      status: "ok",
      detail: `valid (${Object.keys(loadedProjects.projects).length} project(s))`,
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
const boardId = detectVercelBoardIdentity();
results.push(
  boardId.ok
    ? {
        name: "vercel board whoami",
        status: "ok",
        detail: boardId.rawSummary || "authenticated",
      }
    : {
        name: "vercel board whoami",
        status: "warn",
        detail: `${boardId.error} (run: mise exec -- vercel login)`,
      },
);

// Check Herdr server status
const herdrStatus = runQuickCommand("herdr", ["status", "server"]);
results.push(
  herdrStatus.ok
    ? {
        name: "herdr server",
        status: "ok",
        detail: firstMeaningfulLine(herdrStatus.output) || "running",
      }
    : {
        name: "herdr server",
        status: "warn",
        detail: `${firstMeaningfulLine(herdrStatus.output) || "unreachable"} (run: herdr server start, or open Sheprd)`,
      },
);

// Linux systemd linger check (prevents user services from stopping on SSH logout)
const linger = detectLinuxLinger();
if (linger.supported) {
  results.push(
    linger.enabled
      ? {
          name: "systemd linger",
          status: "ok",
          detail: `enabled for ${linger.user} (services persist after logout)`,
        }
      : {
          name: "systemd linger",
          status: "warn",
          detail: `disabled for ${linger.user} — services stop on logout (fix: sudo loginctl enable-linger ${linger.user})`,
        },
  );
}

// Tailscale MagicDNS check (helpful for HTTPS Board UI on headless main hosts)
const tailscale = detectTailscaleInfo();
const currentRole =
  loadedSwarm && currentMachineName ? loadedSwarm.machines[currentMachineName]?.role : null;
if (tailscale.ok) {
  results.push({
    name: "tailscale",
    status: "ok",
    detail: `${tailscale.dnsName}${tailscale.online ? "" : " (offline)"}`,
  });
} else if (currentRole === "main") {
  results.push({
    name: "tailscale",
    status: "warn",
    detail:
      "not detected — Board UI works on localhost:4747; for remote HTTPS use Tailscale Serve or a TLS reverse proxy",
  });
}

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
