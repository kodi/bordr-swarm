import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadProjectsConfigOptional,
  loadSwarmConfig,
  resolveCurrentMachineName,
} from "../src/lib/config.ts";
import { detectTailscaleInfo } from "../src/lib/host-env.ts";

interface ApplyFlags {
  dryRun: boolean;
  unload: boolean;
  machine?: string;
  passThrough: string[];
}

function parseFlags(argv: string[]): ApplyFlags {
  let dryRun = false;
  let unload = false;
  let machine: string | undefined;
  const passThrough: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run") {
      dryRun = true;
      passThrough.push(arg);
    } else if (arg === "--unload") {
      unload = true;
      passThrough.push(arg);
    } else if (arg === "--machine" && argv[i + 1]) {
      machine = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--machine=")) {
      machine = arg.slice("--machine=".length);
    } else {
      passThrough.push(arg);
    }
  }

  return { dryRun, unload, machine, passThrough };
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const configPath = process.env.SWARM_CONFIG_PATH ?? resolve(repoRoot, "config/swarm.json");

  if (!existsSync(configPath)) {
    console.error("[apply] No config/swarm.json found yet.");
    console.error("[apply] Run `mise run init` to generate one in seconds.");
    process.exit(1);
  }

  const swarm = loadSwarmConfig(repoRoot, configPath);
  const machineName = resolveCurrentMachineName(swarm, flags.machine);
  const machine = swarm.machines[machineName];
  if (!machine) {
    throw new Error(`Machine "${machineName}" not found in config/swarm.json`);
  }

  const isMain =
    machine.role === "main" || machine.role === "both" || swarm.lead.machine === machineName;
  const isWorker = machine.role === "worker" || machine.role === "both" || machine.maxWorkers > 0;
  const nodeBin = process.execPath;

  console.log(
    `[apply] Applying machine "${machineName}" (role=${machine.role}, os=${machine.os}, maxWorkers=${machine.maxWorkers})`,
  );

  if (isMain && !flags.unload) {
    console.log("");
    execFileSync(
      nodeBin,
      [
        resolve(repoRoot, "scripts/apply-main.ts"),
        "--machine",
        machineName,
        ...flags.passThrough.filter((a) => a !== "--no-load"),
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
  }

  if (isWorker) {
    console.log("");
    execFileSync(
      nodeBin,
      [
        resolve(repoRoot, "scripts/apply-worker.ts"),
        "--machine",
        machineName,
        ...flags.passThrough.filter(
          (a) =>
            a !== "--no-reload" &&
            a !== "--start-lead" &&
            a !== "--no-start-lead" &&
            a !== "--restart-watcher" &&
            a !== "--restart-lead",
        ),
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
  }

  if (flags.dryRun || flags.unload) {
    return;
  }

  // Print a crisp "Ready to go!" summary banner
  const projects = loadProjectsConfigOptional(repoRoot);
  const localProjects = Object.entries(projects.projects).filter(([, p]) =>
    Boolean(p.paths[machineName]),
  );
  const tailscale = detectTailscaleInfo();

  console.log("\n============================================================");
  console.log(`Swarm ready on "${machineName}" (role=${machine.role})`);
  console.log("============================================================");

  if (isMain) {
    const localUrl = `http://127.0.0.1:${swarm.board.viewerPort}`;
    if (machine.role === "both") {
      console.log(`Board UI (local):  ${localUrl}`);
      if (tailscale.ok) {
        console.log(
          `Remote HTTPS opt:  sudo tailscale serve --bg --https=4748 ${localUrl}  ->  https://${tailscale.dnsName}:4748`,
        );
      }
    } else if (tailscale.ok) {
      console.log(`Board UI (HTTPS):  https://${tailscale.dnsName}:4748`);
      console.log(`Expose once via:   sudo tailscale serve --bg --https=4748 ${localUrl}`);
    } else {
      console.log(`Board UI (local):  ${localUrl}`);
    }
  }

  if (isWorker) {
    if (localProjects.length === 0) {
      console.log("Projects:          none registered yet on this machine");
      console.log("Add a repo:        mise run project:add -- ~/path/to/your-repo");
    } else {
      console.log(
        `Projects (${localProjects.length}):      ${localProjects.map(([slug]) => slug).join(", ")}`,
      );
    }
  }

  const sampleProject = localProjects[0]?.[0] ?? "your-repo";
  console.log("");
  console.log("Next steps:");
  if (isMain) {
    console.log(
      `  1. Open Board UI and post in #${swarm.board.inboxChannel}, e.g.: "In ${sampleProject}, summarize README.md"`,
    );
    console.log(
      "  2. If this is your first run, open Sheprd once to approve Claude's folder-trust prompt.",
    );
  } else if (localProjects.length === 0) {
    console.log("  1. Register a repo: mise run project:add -- ~/path/to/your-repo");
    console.log("  2. Check health:    mise run status");
  } else {
    console.log("  1. Check health:    mise run status");
    console.log("  2. Tail logs:       mise run logs -- -f");
  }
}

main();
