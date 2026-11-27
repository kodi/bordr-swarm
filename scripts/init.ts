import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { currentPlatformOs, type MachineRole } from "../src/lib/config.ts";
import {
  defaultWorkerRuntimeKind,
  detectInstalledAgentKinds,
  detectInstalledRuntimes,
  detectLocalHostnames,
  detectTailscaleInfo,
  detectVercelBoardIdentity,
} from "../src/lib/host-env.ts";
import type { RuntimeKind } from "../src/lib/runtime.ts";

export interface InitFlags {
  role?: MachineRole;
  runtime?: RuntimeKind;
  name?: string;
  maxWorkers?: number;
  handle?: string;
  projects: string[];
  yes: boolean;
  force: boolean;
  noApply: boolean;
}

export function parseInitFlags(argv: string[]): InitFlags {
  const flags: InitFlags = {
    projects: [],
    yes: false,
    force: false,
    noApply: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--force" || arg === "-f") flags.force = true;
    else if (arg === "--no-apply") flags.noApply = true;
    else if (arg === "--role" && argv[i + 1]) {
      const val = argv[i + 1]!;
      if (val === "both" || val === "main" || val === "worker") flags.role = val;
      else throw new Error(`Invalid --role "${val}". Expected "both", "main", or "worker".`);
      i += 1;
    } else if (arg?.startsWith("--role=")) {
      const val = arg.slice("--role=".length);
      if (val === "both" || val === "main" || val === "worker") flags.role = val;
      else throw new Error(`Invalid --role "${val}". Expected "both", "main", or "worker".`);
    } else if (arg === "--runtime" && argv[i + 1]) {
      const val = argv[i + 1]!;
      if (val === "herdr" || val === "rex") flags.runtime = val;
      else throw new Error(`Invalid --runtime "${val}". Expected "herdr" or "rex".`);
      i += 1;
    } else if (arg?.startsWith("--runtime=")) {
      const val = arg.slice("--runtime=".length);
      if (val === "herdr" || val === "rex") flags.runtime = val;
      else throw new Error(`Invalid --runtime "${val}". Expected "herdr" or "rex".`);
    } else if (arg === "--name" && argv[i + 1]) {
      flags.name = argv[i + 1]!;
      i += 1;
    } else if (arg?.startsWith("--name=")) {
      flags.name = arg.slice("--name=".length);
    } else if (arg === "--max-workers" && argv[i + 1]) {
      flags.maxWorkers = Number(argv[i + 1]!);
      i += 1;
    } else if (arg?.startsWith("--max-workers=")) {
      flags.maxWorkers = Number(arg.slice("--max-workers=".length));
    } else if (arg === "--handle" && argv[i + 1]) {
      flags.handle = argv[i + 1]!;
      i += 1;
    } else if (arg?.startsWith("--handle=")) {
      flags.handle = arg.slice("--handle=".length);
    } else if (arg === "--project" && argv[i + 1]) {
      flags.projects.push(argv[i + 1]!);
      i += 1;
    } else if (arg?.startsWith("--project=")) {
      flags.projects.push(arg.slice("--project=".length));
    }
  }

  return flags;
}

export function normalizeRoleAnswer(raw: string): MachineRole | null {
  const val = raw.trim().toLowerCase();
  if (!val || val === "1" || val === "both") return "both";
  if (val === "2" || val === "main") return "main";
  if (val === "3" || val === "worker") return "worker";
  return null;
}

export function normalizeRuntimeAnswer(
  raw: string,
  defaultRuntime: RuntimeKind = "herdr",
): RuntimeKind | null {
  const val = raw.trim().toLowerCase();
  if (!val) return defaultRuntime;
  if (val === "1" || val === "herdr") return "herdr";
  if (val === "2" || val === "rex") return "rex";
  return null;
}

function parseYesNo(raw: string, defaultYes: boolean): boolean {
  const val = raw.trim().toLowerCase();
  if (!val) return defaultYes;
  return val === "y" || val === "yes";
}

async function main(): Promise<void> {
  const flags = parseInitFlags(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const configPath = process.env.SWARM_CONFIG_PATH ?? resolve(repoRoot, "config/swarm.json");

  const interactive = !flags.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  try {
    console.log("bordr-swarm interactive setup\n");

    const os = currentPlatformOs();
    const hostInfo = detectLocalHostnames();
    const tailscale = detectTailscaleInfo();
    const installedAgents = detectInstalledAgentKinds();
    const installedRuntimes = detectInstalledRuntimes();
    const detectedRuntimesList = [
      installedRuntimes.herdr ? "herdr" : null,
      installedRuntimes.rex ? "rex" : null,
    ].filter((v): v is string => Boolean(v));
    let boardId = detectVercelBoardIdentity();

    console.log("Detected environment:");
    console.log(`  OS:            ${os}`);
    console.log(`  Hostname:      ${hostInfo.short}`);
    console.log(
      `  Tailscale:     ${tailscale.ok ? `${tailscale.dnsName}${tailscale.online ? "" : " (offline)"}` : "not detected"}`,
    );
    console.log(
      `  Runtimes:      ${detectedRuntimesList.length > 0 ? detectedRuntimesList.join(", ") : "none found (install herdr or rex)"}`,
    );
    console.log(
      `  Agent CLIs:    ${installedAgents.length > 0 ? installedAgents.join(", ") : "none found (install claude, agy, codex, or pi)"}`,
    );
    console.log(
      `  Vercel Board:  ${boardId.ok ? boardId.rawSummary || "authenticated" : `not authenticated (${boardId.error})`}`,
    );
    console.log("");

    // Offer to authenticate Vercel CLI right away if missing
    if (!boardId.ok && rl) {
      const answer = await rl.question(
        "Vercel CLI is not logged in. Run `vercel login` now? [Y/n] ",
      );
      if (parseYesNo(answer, true)) {
        try {
          execFileSync("vercel", ["login"], { stdio: "inherit" });
          boardId = detectVercelBoardIdentity();
          console.log("");
        } catch {
          console.warn("[init] `vercel login` did not complete; you can run it later.\n");
        }
      }
    }

    if (existsSync(configPath) && !flags.force) {
      if (!rl) {
        console.log(`[init] ${configPath} already exists. Pass --force to overwrite.`);
        return;
      }
      const overwrite = await rl.question(
        `${configPath} already exists. Overwrite it with a fresh minimal config? [y/N] `,
      );
      if (!parseYesNo(overwrite, false)) {
        console.log("[init] Keeping existing config/swarm.json.");
        return;
      }
    }

    // 1. Machine role
    let role: MachineRole = flags.role ?? "both";
    if (!flags.role && rl) {
      console.log("Choose this machine's role:");
      console.log("  1) both   — Board UI + Lead + Worker on this machine (fastest quickstart)");
      console.log("  2) main   — Board UI + Lead only (headless server / always-on hub)");
      console.log("  3) worker — Worker Dispatcher only (joins an existing swarm)");
      while (true) {
        const ans = await rl.question("Role [1]: ");
        const parsed = normalizeRoleAnswer(ans);
        if (parsed) {
          role = parsed;
          break;
        }
        console.log("  Please enter 1 (both), 2 (main), or 3 (worker).");
      }
    }

    // 1b. Worker terminal runtime (for worker/both)
    const defaultRuntime = defaultWorkerRuntimeKind(installedRuntimes);
    let workerRuntime: RuntimeKind = flags.runtime ?? defaultRuntime;
    if (role !== "main" && !flags.runtime && rl) {
      const defaultIdx = defaultRuntime === "rex" ? "2" : "1";
      console.log("\nWhere should worker agents run?");
      console.log(
        `  1) Herdr — tabs you watch in Sheprd${defaultRuntime === "herdr" ? " (default)" : ""}`,
      );
      console.log(
        `  2) Rex   — tabs you watch in the Rex app${defaultRuntime === "rex" ? " (default)" : ""}`,
      );
      while (true) {
        const ans = await rl.question(`Runtime [${defaultIdx}]: `);
        const parsed = normalizeRuntimeAnswer(ans, defaultRuntime);
        if (parsed) {
          workerRuntime = parsed;
          break;
        }
        console.log("  Please enter 1 (herdr) or 2 (rex).");
      }
    }
    if (role === "both" && workerRuntime === "rex") {
      console.log(
        "[init] Note: the Lead agent still runs in Herdr (watched in Sheprd); only worker agents will use Rex.",
      );
    }

    // 2. Machine name
    let machineName = flags.name?.trim() || hostInfo.sanitizedName;
    if (!flags.name && rl) {
      const ans = await rl.question(`Machine name [${machineName}]: `);
      if (ans.trim()) {
        machineName = ans.trim();
      }
    }

    // 3. Human handle (for escalations on main/both)
    const detectedHandle = flags.handle?.trim() || boardId.handle || "@owner";
    let humanHandle = detectedHandle;
    if (!flags.handle && rl && (role === "main" || role === "both") && !boardId.handle) {
      const ans = await rl.question(`Your Board handle for escalations [${detectedHandle}]: `);
      if (ans.trim()) {
        humanHandle = ans.trim().startsWith("@") ? ans.trim() : `@${ans.trim()}`;
      }
    }

    // 4. Max concurrent workers (for worker/both)
    let maxWorkers = role === "main" ? 0 : (flags.maxWorkers ?? 2);
    if (role !== "main" && flags.maxWorkers === undefined && rl) {
      const ans = await rl.question(`Max concurrent workers [${maxWorkers}]: `);
      if (ans.trim()) {
        const parsed = Number(ans.trim());
        if (Number.isInteger(parsed) && parsed >= 0) {
          maxWorkers = parsed;
        }
      }
    }

    // 5. Optional first repo to register (for worker/both)
    const projectsToAdd = [...flags.projects];
    if (role !== "main" && projectsToAdd.length === 0 && rl) {
      const ans = await rl.question(
        "Optional: path to a local Git repo to register now (Enter to skip): ",
      );
      if (ans.trim()) {
        projectsToAdd.push(ans.trim());
      }
    }

    // Build minimal per-host config/swarm.json
    const allowedHosts: string[] = [];
    if (role === "main" || role === "both") {
      allowedHosts.push(hostInfo.short);
      if (tailscale.ok) {
        allowedHosts.push(tailscale.dnsName, `${tailscale.dnsName}:4748`);
      }
    }
    const dedupedAllowedHosts = [...new Set(allowedHosts.filter(Boolean))];

    const boardSection: Record<string, unknown> = {};
    if (humanHandle && humanHandle !== "@owner") {
      boardSection.humanHandle = humanHandle;
    }
    if (role === "main" && tailscale.ok) {
      boardSection.viewerUrl = `https://${tailscale.dnsName}:4748`;
    }

    const machineEntry: Record<string, unknown> = {
      role,
      os,
      hostname: hostInfo.short,
    };
    if (dedupedAllowedHosts.length > 0) {
      machineEntry.allowedHosts = dedupedAllowedHosts;
    }
    if (role !== "main") {
      machineEntry.maxWorkers = maxWorkers;
      machineEntry.runtime =
        workerRuntime === "rex" ? { kind: "rex" } : { kind: "herdr", target: "local" };
    }

    const configObj: Record<string, unknown> = {
      $schema: "./swarm.schema.json",
    };
    if (Object.keys(boardSection).length > 0) {
      configObj.board = boardSection;
    }
    configObj.machines = {
      [machineName]: machineEntry,
    };

    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(configObj, null, 2)}\n`, "utf8");
    console.log(`\n[init] Wrote minimal config to ${configPath}`);

    // Register any requested projects
    const nodeBin = process.execPath;
    for (const repoPath of projectsToAdd) {
      console.log(`\n[init] Registering project ${repoPath}...`);
      const projectArgs = [resolve(repoRoot, "scripts/project.ts"), "add", repoPath];
      if (!boardId.ok) {
        projectArgs.push("--no-publish");
      }
      try {
        execFileSync(nodeBin, projectArgs, { cwd: repoRoot, stdio: "inherit" });
      } catch (err) {
        console.warn(
          `[init] Could not register ${repoPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Offer to apply services immediately
    let shouldApply = !flags.noApply;
    if (shouldApply && rl) {
      const ans = await rl.question(
        "\nApply & start swarm services now (`mise run apply`)? [Y/n] ",
      );
      shouldApply = parseYesNo(ans, true);
    }

    if (shouldApply) {
      console.log("");
      execFileSync(nodeBin, [resolve(repoRoot, "scripts/apply.ts"), "--machine", machineName], {
        cwd: repoRoot,
        stdio: "inherit",
      });
    } else {
      console.log("\nNext steps:");
      if (!boardId.ok) {
        console.log("  1. mise exec -- vercel login");
      }
      console.log("  - mise run doctor");
      console.log("  - mise run apply");
    }
  } finally {
    rl?.close();
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
