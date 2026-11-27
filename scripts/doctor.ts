import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadProjectsConfig,
  loadSwarmConfig,
  resolveCurrentMachineName,
  resolveMachineRuntime,
  resolveReviewerConfig,
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
import { REX_VERIFIED_VERSION, RexWhoamiSchema } from "../src/lib/schemas.ts";
import { validateConfiguredReactors } from "../src/reactors/configured.ts";

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

// Validate swarm.json first so we know which terminal runtime(s) this host needs.
let loadedSwarm: SwarmConfig | null = null;
let loadedProjects: ProjectsConfig | null = null;
let currentMachineName: string | null = null;
let swarmConfigResult: CheckResult;

const swarmPath = process.env.SWARM_CONFIG_PATH ?? resolve(repoRoot, "config/swarm.json");
if (!existsSync(swarmPath)) {
  swarmConfigResult = {
    name: "swarm config",
    status: "warn",
    detail: "missing config/swarm.json (run: mise run init)",
  };
} else {
  try {
    loadedSwarm = loadSwarmConfig(repoRoot, swarmPath);
    currentMachineName = resolveCurrentMachineName(loadedSwarm);
    const machineCfg = loadedSwarm.machines[currentMachineName]!;
    const rt = resolveMachineRuntime(machineCfg);
    swarmConfigResult = {
      name: "swarm config",
      status: "ok",
      detail: `valid (this host="${currentMachineName}", role=${machineCfg.role}, os=${machineCfg.os}, runtime=${rt.kind}, maxWorkers=${machineCfg.maxWorkers})`,
    };
  } catch (err) {
    swarmConfigResult = {
      name: "swarm config",
      status: "fail",
      detail: err instanceof Error ? err.message.replaceAll("\n", " | ") : String(err),
    };
  }
}

const currentMachineCfg =
  loadedSwarm && currentMachineName ? (loadedSwarm.machines[currentMachineName] ?? null) : null;
const currentRuntime = currentMachineCfg ? resolveMachineRuntime(currentMachineCfg) : null;
const isWorkerRole = Boolean(
  currentMachineCfg &&
  (currentMachineCfg.role === "worker" ||
    currentMachineCfg.role === "both" ||
    currentMachineCfg.maxWorkers > 0),
);
const needsRex = Boolean(isWorkerRole && currentRuntime?.kind === "rex");
const needsHerdr =
  !currentMachineCfg ||
  currentMachineCfg.role === "main" ||
  currentMachineCfg.role === "both" ||
  currentRuntime?.kind === "herdr";
const rexBin = currentRuntime?.kind === "rex" ? (currentRuntime.binary ?? "rex") : "rex";

const results: CheckResult[] = [
  checkVersion("node", "node", ["--version"], { fixHint: "run: mise install" }),
  checkVersion("mise", "mise", ["--version"], { fixHint: "run: ./scripts/bootstrap.sh" }),
  checkVersion("vercel", "vercel", ["--version"], { fixHint: "run: mise install" }),
  checkVersion("board (@vercel/board)", "board", ["--help"], {
    optional: true,
    fixHint: "run: mise install",
  }),
  ...(needsHerdr
    ? [
        checkVersion("herdr", "herdr", ["--version"], {
          fixHint: "install Herdr / Sheprd and ensure `herdr` is in PATH",
        }),
      ]
    : []),
  ...(needsRex
    ? [
        checkVersion("rex", rexBin, ["version"], {
          fixHint: "install Rex and ensure `rex` is in PATH",
        }),
      ]
    : []),
  checkVersion("claude", "claude", ["--version"], {
    fixHint: "install Claude Code CLI (`claude`)",
  }),
  checkVersion("agy", "agy", ["--help"], { optional: true }),
  checkVersion("codex", "codex", ["--version"], { optional: true }),
  checkVersion("pi", "pi", ["--version"], { optional: true }),
  swarmConfigResult,
];

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

if (loadedSwarm) {
  const reactors = loadedSwarm.reactors ?? [];
  if (reactors.length === 0) {
    results.push({ name: "reactors", status: "ok", detail: "none configured (built-ins only)" });
  } else {
    // Selectors and shapes were already validated by the Zod schema while loading swarm.json.
    const check = validateConfiguredReactors(reactors, {
      projectChannelPrefix: loadedSwarm.board.projectChannelPrefix,
    });
    const problems = [...check.errors, ...check.warnings];
    results.push({
      name: "reactors",
      status: check.errors.length > 0 ? "fail" : check.warnings.length > 0 ? "warn" : "ok",
      detail:
        problems.length > 0
          ? problems.join(" ; ")
          : `${reactors.length} configured: ${check.summary.join(" ; ")}`,
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

// Validate configured reviewer binary availability on worker hosts
if (loadedSwarm && currentMachineName) {
  const machineCfg = loadedSwarm.machines[currentMachineName];
  if (
    machineCfg &&
    (machineCfg.role === "worker" || machineCfg.role === "both" || machineCfg.maxWorkers > 0)
  ) {
    const reviewerIssues: string[] = [];
    const activeReviewers = new Set<string>();

    const checkReviewer = (label: string, projectCfg?: ProjectsConfig["projects"][string]) => {
      try {
        const rev = resolveReviewerConfig(loadedSwarm!.workerDefaults, projectCfg);
        if (!rev.enabled || !rev.runtime) return;
        const binCheck = runQuickCommand("which", [rev.runtime.kind]);
        if (!binCheck.ok) {
          reviewerIssues.push(
            `${label} uses reviewer "${rev.runtime.profileName}" (binary "${rev.runtime.kind}" not in PATH)`,
          );
        } else {
          activeReviewers.add(
            rev.runtime.model
              ? `${rev.runtime.profileName}(${rev.runtime.model})`
              : rev.runtime.profileName,
          );
        }
      } catch (err) {
        reviewerIssues.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    checkReviewer("workerDefaults.reviewer");
    if (loadedProjects) {
      for (const [slug, proj] of Object.entries(loadedProjects.projects)) {
        if (proj.paths[currentMachineName]) {
          checkReviewer(`project "${slug}"`, proj);
        }
      }
    }

    if (reviewerIssues.length > 0) {
      results.push({
        name: "reviewer config",
        status: "warn",
        detail: reviewerIssues.join(" ; "),
      });
    } else if (activeReviewers.size > 0) {
      results.push({
        name: "reviewer config",
        status: "ok",
        detail: `enabled (${[...activeReviewers].join(", ")})`,
      });
    } else {
      results.push({
        name: "reviewer config",
        status: "ok",
        detail:
          "disabled (configure workerDefaults.reviewer or project reviewer override to enable)",
      });
    }
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

// Check Herdr server status (when Herdr is used by Lead or workers)
if (needsHerdr) {
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
}

// Check Rex server status and version (when worker runtime is Rex)
if (needsRex) {
  const rexWhoami = runQuickCommand(rexBin, ["whoami", "--json"]);
  if (!rexWhoami.ok) {
    const hint =
      process.platform === "darwin"
        ? "open the Rex app so the local server is running"
        : "run: rex server start (or rex server install)";
    results.push({
      name: "rex server",
      status: "warn",
      detail: `${firstMeaningfulLine(rexWhoami.output) || "unreachable"} (${hint})`,
    });
  } else {
    let detail = "running";
    let status: CheckStatus = "ok";
    try {
      const parsed = RexWhoamiSchema.parse(JSON.parse(rexWhoami.stdout));
      const ver = parsed.rex_version ?? "unknown";
      detail = `running (rex ${ver}, api rev ${parsed.api_revision ?? "?"}, ${parsed.session_count ?? 0} session(s))`;
      if (parsed.rex_version && parsed.rex_version !== REX_VERIFIED_VERSION) {
        status = "warn";
        detail += ` — verified against ${REX_VERIFIED_VERSION}`;
      }
    } catch {
      detail = firstMeaningfulLine(rexWhoami.output) || "running";
    }
    results.push({ name: "rex server", status, detail });
  }
}

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

// Optional GitHub CLI check on main/both hosts (lets Lead inspect repos read-only when clarifying tasks)
if (currentRole === "main" || currentRole === "both") {
  const ghVersion = runQuickCommand("gh", ["--version"]);
  if (!ghVersion.ok) {
    results.push({
      name: "gh (optional)",
      status: "warn",
      detail:
        "optional — install `gh` and run `gh auth login` so Lead can inspect GitHub repos read-only when clarifying ambiguous requests",
    });
  } else {
    const ghAuth = runQuickCommand("gh", ["auth", "status"]);
    results.push(
      ghAuth.ok
        ? {
            name: "gh (optional)",
            status: "ok",
            detail: `${firstMeaningfulLine(ghVersion.output) || "installed"} (authenticated for Lead read-only repo inspection)`,
          }
        : {
            name: "gh (optional)",
            status: "warn",
            detail:
              "optional — installed but not authenticated (run: gh auth login so Lead can inspect private GitHub repos read-only)",
          },
    );
  }
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
