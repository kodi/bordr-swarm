import { execFileSync } from "node:child_process";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentPlatformOs } from "../src/lib/config.ts";
import { HerdrClient } from "../src/lib/herdr.ts";

interface StopFlags {
  dryRun: boolean;
  reset: boolean;
  keepLead: boolean;
}

function parseFlags(argv: string[]): StopFlags {
  return {
    dryRun: argv.includes("--dry-run"),
    reset: argv.includes("--reset"),
    keepLead: argv.includes("--keep-lead"),
  };
}

function systemdEnv(): NodeJS.ProcessEnv {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
  };
}

function runQuiet(cmd: string, args: string[], env?: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore", env, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function stopLinuxServices(home: string, dryRun: boolean): void {
  const env = systemdEnv();
  const unitDir = resolve(home, ".config/systemd/user");
  const units = [
    "bordr-lead-watcher.service",
    "vercel-board-ui.service",
    "swarm-dispatcher.service",
  ];

  let anyTouched = false;
  for (const unit of units) {
    const unitPath = resolve(unitDir, unit);
    const active = runQuiet("systemctl", ["--user", "is-active", unit], env);
    const enabled = runQuiet("systemctl", ["--user", "is-enabled", unit], env);
    const fileExists = existsSync(unitPath);

    if (!active && !enabled && !fileExists) {
      continue;
    }
    anyTouched = true;

    if (dryRun) {
      console.log(`[dry-run] Would disable/stop ${unit} and remove ${unitPath}`);
      continue;
    }

    runQuiet("systemctl", ["--user", "disable", "--now", unit], env);
    if (fileExists) {
      unlinkSync(unitPath);
    }
    console.log(`[stop] Stopped and removed ${unit}`);
  }

  const boardEnvPath = resolve(home, ".config/swarm/board.env");
  if (existsSync(boardEnvPath)) {
    anyTouched = true;
    if (dryRun) {
      console.log(`[dry-run] Would remove ${boardEnvPath}`);
    } else {
      unlinkSync(boardEnvPath);
      console.log(`[stop] Removed ${boardEnvPath}`);
    }
  }

  if (anyTouched && !dryRun) {
    runQuiet("systemctl", ["--user", "daemon-reload"], env);
  } else if (!anyTouched) {
    console.log("[stop] No systemd --user swarm services found.");
  }
}

function stopMacosServices(home: string, dryRun: boolean): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const launchAgentsDir = resolve(home, "Library/LaunchAgents");
  const labels = ["dev.swarm.lead-watcher", "dev.swarm.board-ui", "dev.swarm.dispatcher"];

  let anyTouched = false;
  for (const label of labels) {
    const plistPath = resolve(launchAgentsDir, `${label}.plist`);
    const loaded = runQuiet("launchctl", ["print", `gui/${uid}/${label}`]);
    const fileExists = existsSync(plistPath);

    if (!loaded && !fileExists) {
      continue;
    }
    anyTouched = true;

    if (dryRun) {
      console.log(`[dry-run] Would bootout gui/${uid}/${label} and remove ${plistPath}`);
      continue;
    }

    if (loaded) {
      runQuiet("launchctl", ["bootout", `gui/${uid}/${label}`]);
    }
    if (fileExists) {
      unlinkSync(plistPath);
    }
    console.log(`[stop] Unloaded and removed ${label}`);
  }

  if (!anyTouched) {
    console.log("[stop] No launchd swarm services found.");
  }
}

async function stopLeadAgents(dryRun: boolean): Promise<void> {
  const herdr = new HerdrClient({ target: "local" });
  try {
    const agents = await herdr.listAgents();
    const leadTabIds = new Set<string>();
    for (const agent of agents) {
      if (!agent.tab_id) continue;
      if (
        agent.name === "lead" ||
        agent.name?.startsWith("lead-") ||
        agent.cwd?.endsWith("/swarm-hq")
      ) {
        leadTabIds.add(agent.tab_id);
      }
    }
    for (const tabId of leadTabIds) {
      if (dryRun) {
        console.log(`[dry-run] Would close Lead agent tab ${tabId} in Herdr`);
        continue;
      }
      await herdr.closeTab(tabId);
      console.log(`[stop] Closed Lead agent tab ${tabId} in Herdr.`);
    }
  } catch {
    // Herdr server may not be running; ignore gracefully
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const home = homedir();
  const os = currentPlatformOs();

  if (os === "linux") {
    stopLinuxServices(home, flags.dryRun);
  } else {
    stopMacosServices(home, flags.dryRun);
  }

  if (!flags.keepLead) {
    await stopLeadAgents(flags.dryRun);
  }

  if (flags.reset) {
    const pathsToRemove = [
      resolve(home, "swarm-hq"),
      resolve(home, ".local/state/bordr-swarm"),
      resolve(repoRoot, "config/swarm.json"),
      resolve(repoRoot, "config/projects.json"),
      // State files relocated by env overrides live outside ~/.local/state/bordr-swarm
      ...[process.env.DISPATCHER_STATE_PATH, process.env.LEAD_WATCHER_STATE_PATH]
        .map((p) => p?.trim())
        .filter((p): p is string => Boolean(p))
        .map((p) => resolve(p)),
    ];
    for (const target of pathsToRemove) {
      if (!existsSync(target)) continue;
      if (flags.dryRun) {
        console.log(`[dry-run] Would remove ${target}`);
      } else {
        rmSync(target, { recursive: true, force: true });
        console.log(`[stop] Removed ${target}`);
      }
    }
  }

  console.log(
    flags.reset
      ? "[stop] Swarm stopped and local config/state reset. Re-run `mise run init` when ready."
      : "[stop] Swarm services stopped. Re-run `mise run apply` to start again (or pass `--reset` to wipe local config/state).",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
