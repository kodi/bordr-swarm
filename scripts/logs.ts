import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentPlatformOs,
  loadSwarmConfig,
  resolveCurrentMachineName,
} from "../src/lib/config.ts";

function main(): void {
  const args = process.argv.slice(2);
  const follow = args.includes("-f") || args.includes("--follow");
  const targetArg = args.find((a) => !a.startsWith("-"));

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const localOs = currentPlatformOs();

  let defaultTarget = "lead-watcher";
  const configPath = process.env.SWARM_CONFIG_PATH ?? resolve(repoRoot, "config/swarm.json");
  if (existsSync(configPath)) {
    const swarm = loadSwarmConfig(repoRoot, configPath);
    const machineName = resolveCurrentMachineName(swarm);
    const machine = swarm.machines[machineName];
    if (machine && machine.role === "worker") {
      defaultTarget = "dispatcher";
    }
  }

  const target = targetArg ?? defaultTarget;

  if (localOs === "linux") {
    const unitMap: Record<string, string> = {
      "lead-watcher": "bordr-lead-watcher.service",
      lead: "bordr-lead-watcher.service",
      ui: "vercel-board-ui.service",
      board: "vercel-board-ui.service",
      dispatcher: "swarm-dispatcher.service",
      worker: "swarm-dispatcher.service",
    };
    const unit = unitMap[target] ?? target;
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    };
    const jArgs = ["--user", "-u", unit, "-n", "50", "--no-pager"];
    if (follow) jArgs.push("-f");
    spawnSync("journalctl", jArgs, { stdio: "inherit", env });
    return;
  }

  const home = homedir();
  const logMap: Record<string, string[]> = {
    dispatcher: [
      resolve(home, "Library/Logs/swarm-dispatcher.out.log"),
      resolve(home, "Library/Logs/swarm-dispatcher.err.log"),
    ],
    worker: [
      resolve(home, "Library/Logs/swarm-dispatcher.out.log"),
      resolve(home, "Library/Logs/swarm-dispatcher.err.log"),
    ],
    "lead-watcher": [
      resolve(home, "Library/Logs/swarm-lead-watcher.out.log"),
      resolve(home, "Library/Logs/swarm-lead-watcher.err.log"),
    ],
    ui: [
      resolve(home, "Library/Logs/swarm-board-ui.out.log"),
      resolve(home, "Library/Logs/swarm-board-ui.err.log"),
    ],
  };

  const files = (logMap[target] ?? []).filter((f) => existsSync(f));
  if (files.length === 0) {
    console.log(`[logs] No log files found yet for "${target}".`);
    return;
  }
  const tailArgs = ["-n", "50"];
  if (follow) tailArgs.push("-f");
  tailArgs.push(...files);
  spawnSync("tail", tailArgs, { stdio: "inherit" });
}

main();
