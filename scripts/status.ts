import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentPlatformOs,
  loadSwarmConfig,
  resolveCurrentMachineName,
  type MachineOs,
} from "../src/lib/config.ts";
import { HerdrClient } from "../src/lib/herdr.ts";

function systemdEnv(): NodeJS.ProcessEnv {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
  };
}

function checkSystemdUnit(unit: string): string {
  try {
    const out = execFileSync("systemctl", ["--user", "is-active", unit], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: systemdEnv(),
      timeout: 5_000,
    }).trim();
    return out || "unknown";
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const status = (e.stdout || e.stderr || "").trim().split("\n")[0];
    return status || "inactive";
  }
}

function checkLaunchdService(label: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  try {
    const out = execFileSync("launchctl", ["print", `gui/${uid}/${label}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    const stateMatch = /state\s*=\s*(\S+)/.exec(out);
    const pidMatch = /pid\s*=\s*(\d+)/.exec(out);
    if (stateMatch) {
      return pidMatch ? `${stateMatch[1]} (pid ${pidMatch[1]})` : stateMatch[1]!;
    }
    return "loaded";
  } catch {
    return "not loaded";
  }
}

async function checkHttpHealth(url: string): Promise<string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return `HTTP ${res.status}`;
  } catch (err) {
    return `unreachable (${err instanceof Error ? err.message : String(err)})`;
  }
}

function checkService(os: MachineOs, systemdUnit: string, launchdLabel: string): string {
  return os === "linux" ? checkSystemdUnit(systemdUnit) : checkLaunchdService(launchdLabel);
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const configPath = process.env.SWARM_CONFIG_PATH ?? resolve(repoRoot, "config/swarm.json");

  if (!existsSync(configPath)) {
    console.log("[status] config/swarm.json not found — run `mise run doctor` first.");
    process.exit(1);
  }

  const swarm = loadSwarmConfig(repoRoot, configPath);
  const machineName = resolveCurrentMachineName(swarm);
  const machine = swarm.machines[machineName]!;
  const localOs = currentPlatformOs();

  console.log(
    `Machine: ${machineName} (role=${machine.role}, os=${localOs}, maxWorkers=${machine.maxWorkers})`,
  );
  console.log("");

  const isMain =
    machine.role === "main" || machine.role === "both" || swarm.lead.machine === machineName;
  const isWorker = machine.role === "worker" || machine.role === "both" || machine.maxWorkers > 0;

  if (isMain) {
    const uiSvc = checkService(localOs, "vercel-board-ui.service", "dev.swarm.board-ui");
    const watcherSvc = checkService(
      localOs,
      "bordr-lead-watcher.service",
      "dev.swarm.lead-watcher",
    );
    const http = await checkHttpHealth(`http://127.0.0.1:${swarm.board.viewerPort}`);
    console.log(
      `Board UI service:      ${uiSvc} (http://127.0.0.1:${swarm.board.viewerPort} -> ${http})`,
    );
    console.log(`Lead Watcher service:  ${watcherSvc}`);
  }

  if (isWorker) {
    const dispSvc = checkService(localOs, "swarm-dispatcher.service", "dev.swarm.dispatcher");
    console.log(`Worker Dispatcher:     ${dispSvc}`);
  }

  // Show Herdr live agents
  const herdr = new HerdrClient({ target: machine.herdrTarget });
  try {
    const agents = await herdr.listAgents();
    const leadPrefix = swarm.lead.boardProfile.toLowerCase();
    const swarmAgents = agents.filter(
      (a) =>
        a.name === leadPrefix ||
        Boolean(a.name?.startsWith(`${leadPrefix}-`)) ||
        Boolean(a.name?.startsWith("w-")) ||
        Boolean(a.name?.startsWith("r-")) ||
        a.cwd?.endsWith("/swarm-hq"),
    );
    console.log("");
    if (swarmAgents.length === 0) {
      console.log("Swarm Herdr agents:    none currently active");
    } else {
      console.log("Swarm Herdr agents:");
      for (const a of swarmAgents) {
        console.log(
          `  - ${a.name ?? a.agent ?? "agent"} (${a.agent ?? "?"}) status=${a.agent_status} pane=${a.pane_id} cwd=${a.cwd ?? ""}`,
        );
      }
    }
  } catch (err) {
    console.log(
      `\nSwarm Herdr agents:    unavailable (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (localOs === "macos") {
    console.log(`\nLogs directory:        ${resolve(homedir(), "Library/Logs")}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
