import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSwarmConfig, resolveCurrentMachineName } from "../src/lib/config.ts";

interface UpdateFlags {
  dryRun: boolean;
  skipPull: boolean;
  restartLead: boolean;
  machine?: string;
}

function parseFlags(argv: string[]): UpdateFlags {
  let dryRun = false;
  let skipPull = false;
  let restartLead = false;
  let machine: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--skip-pull") skipPull = true;
    else if (arg === "--restart-lead") restartLead = true;
    else if (arg === "--machine" && argv[i + 1]) {
      machine = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--machine=")) {
      machine = arg.slice("--machine=".length);
    }
  }
  return { dryRun, skipPull, restartLead, machine };
}

function gitOutput(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runStep(cmd: string, args: string[], cwd: string, dryRun: boolean): void {
  if (dryRun) {
    console.log(`[dry-run] Would run: ${cmd} ${args.join(" ")}`);
    return;
  }
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");

  const beforeSha = gitOutput(["rev-parse", "HEAD"], repoRoot);

  // 1. Pull latest changes (fast-forward only so local edits are never clobbered)
  if (!flags.skipPull) {
    console.log("[update] Pulling latest bordr-swarm changes...");
    runStep("git", ["pull", "--ff-only"], repoRoot, flags.dryRun);
  }

  const afterSha = flags.dryRun ? beforeSha : gitOutput(["rev-parse", "HEAD"], repoRoot);
  const changedFiles =
    beforeSha === afterSha
      ? []
      : gitOutput(["diff", "--name-only", `${beforeSha}..${afterSha}`], repoRoot)
          .split("\n")
          .filter(Boolean);

  if (changedFiles.length > 0) {
    console.log(
      `[update] Updated ${beforeSha.slice(0, 7)} -> ${afterSha.slice(0, 7)} (${changedFiles.length} file(s))`,
    );
  } else if (!flags.dryRun) {
    console.log(`[update] Already at latest commit (${afterSha.slice(0, 7)}).`);
  }

  // 2. Sync mise toolchains & npm dependencies if their manifests changed
  if (changedFiles.includes("mise.toml")) {
    console.log("[update] mise.toml changed — running mise install...");
    runStep("mise", ["install"], repoRoot, flags.dryRun);
  }
  if (changedFiles.includes("package.json") || changedFiles.includes("package-lock.json")) {
    console.log("[update] Dependencies changed — running npm install...");
    runStep("npm", ["install"], repoRoot, flags.dryRun);
  }

  // 3. Re-apply services for this machine's configured role
  const configPath = process.env.SWARM_CONFIG_PATH ?? resolve(repoRoot, "config/swarm.json");
  if (!existsSync(configPath)) {
    console.log("[update] No config/swarm.json found yet — skipping service reload.");
    return;
  }

  const swarm = loadSwarmConfig(repoRoot, configPath);
  const machineName = resolveCurrentMachineName(swarm, flags.machine);
  const machine = swarm.machines[machineName]!;
  const isMain =
    machine.role === "main" || machine.role === "both" || swarm.lead.machine === machineName;
  const isWorker = machine.role === "worker" || machine.role === "both" || machine.maxWorkers > 0;
  const codeChanged = changedFiles.some(
    (f) => f.startsWith("src/") || f.startsWith("scripts/") || f.startsWith("prompts/"),
  );

  const nodeBin = process.execPath;

  if (isMain) {
    const mainArgs = [resolve(repoRoot, "scripts/apply-main.ts"), "--machine", machineName];
    if (flags.dryRun) mainArgs.push("--dry-run");
    if (codeChanged) mainArgs.push("--restart-watcher");
    if (flags.restartLead) mainArgs.push("--restart-lead");
    console.log(`[update] Applying main machine "${machineName}"...`);
    runStep(nodeBin, mainArgs, repoRoot, false);
  }

  if (isWorker) {
    const workerArgs = [resolve(repoRoot, "scripts/apply-worker.ts"), "--machine", machineName];
    if (flags.dryRun) workerArgs.push("--dry-run");
    console.log(`[update] Applying worker machine "${machineName}"...`);
    runStep(nodeBin, workerArgs, repoRoot, false);
  }

  // 4. Print current status
  if (!flags.dryRun) {
    console.log("");
    runStep(nodeBin, [resolve(repoRoot, "scripts/status.ts")], repoRoot, false);
  }
}

main();
