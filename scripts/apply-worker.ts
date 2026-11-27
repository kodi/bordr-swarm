import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadProjectsConfigOptional,
  loadSwarmConfig,
  resolveCurrentMachineName,
  resolveMachineRuntime,
} from "../src/lib/config.ts";
import { runQuickCommand } from "../src/lib/host-env.ts";

interface WorkerApplyFlags {
  dryRun: boolean;
  noLoad: boolean;
  unload: boolean;
  /** Leave an already-running dispatcher alone when its service file is unchanged. */
  keepRunning: boolean;
  machine?: string;
}

function parseFlags(argv: string[]): WorkerApplyFlags {
  let dryRun = false;
  let noLoad = false;
  let unload = false;
  let keepRunning = false;
  let machine: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-load") noLoad = true;
    else if (arg === "--unload") unload = true;
    else if (arg === "--keep-running") keepRunning = true;
    else if (arg === "--machine" && argv[i + 1]) {
      machine = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--machine=")) {
      machine = arg.slice("--machine=".length);
    }
  }
  return { dryRun, noLoad, unload, keepRunning, machine };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function resolveNodeExecutable(home: string): string {
  const miseShim = resolve(home, ".local/share/mise/shims/node");
  if (existsSync(miseShim)) {
    return miseShim;
  }
  return process.execPath;
}

function renderLaunchdPlist(params: {
  label: string;
  repoRoot: string;
  home: string;
  machine: string;
  nodeBin: string;
  vercelScope: string;
  boardName: string;
}): string {
  const pathEnv = [
    `${params.home}/.local/share/mise/shims`,
    `${params.home}/.local/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");

  const envEntries: Array<[string, string]> = [
    ["PATH", pathEnv],
    ["SWARM_MACHINE", params.machine],
    ["NODE_NO_WARNINGS", "1"],
  ];
  if (params.vercelScope) envEntries.push(["VERCEL_SCOPE", params.vercelScope]);
  if (params.boardName) envEntries.push(["VERCEL_BOARD_NAME", params.boardName]);

  const envXml = envEntries
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join("\n");

  const outLog = resolve(params.home, "Library/Logs/swarm-dispatcher.out.log");
  const errLog = resolve(params.home, "Library/Logs/swarm-dispatcher.err.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(params.label)}</string>

  <key>WorkingDirectory</key>
  <string>${xmlEscape(params.repoRoot)}</string>

  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>

  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(params.nodeBin)}</string>
    <string>${xmlEscape(resolve(params.repoRoot, "src/dispatcher.ts"))}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${xmlEscape(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLog)}</string>
</dict>
</plist>
`;
}

function renderSystemdWorkerUnit(params: {
  repoRoot: string;
  machine: string;
  vercelScope: string;
  boardName: string;
  runtimeKind?: "herdr" | "rex";
}): string {
  const envLines = [
    "Environment=PATH=%h/.local/share/mise/shims:%h/.local/bin:/usr/local/bin:/usr/bin:/bin",
    `Environment=SWARM_MACHINE=${params.machine}`,
    "Environment=NODE_NO_WARNINGS=1",
  ];
  if (params.vercelScope) envLines.push(`Environment=VERCEL_SCOPE=${params.vercelScope}`);
  if (params.boardName) envLines.push(`Environment=VERCEL_BOARD_NAME=${params.boardName}`);

  const afterLine =
    params.runtimeKind === "rex"
      ? "After=network-online.target rex.socket rex.service"
      : "After=network-online.target";

  return `[Unit]
Description=Swarm Worker Dispatcher (${params.machine})
${afterLine}
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${params.repoRoot}
${envLines.join("\n")}
ExecStart=%h/.local/share/mise/shims/node ${resolve(params.repoRoot, "src/dispatcher.ts")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function runLaunchctl(args: string[], dryRun: boolean, allowFail = false): void {
  if (dryRun) {
    console.log(`[dry-run] Would run: launchctl ${args.join(" ")}`);
    return;
  }
  try {
    execFileSync("launchctl", args, { stdio: allowFail ? "ignore" : "inherit" });
  } catch (err) {
    if (!allowFail) throw err;
  }
}

function isLaunchdLoaded(uid: number, label: string): boolean {
  try {
    execFileSync("launchctl", ["print", `gui/${uid}/${label}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function reloadLaunchdService(params: {
  uid: number;
  label: string;
  plistPath: string;
  changed: boolean;
  keepRunning: boolean;
  dryRun: boolean;
}): void {
  const { uid, label, plistPath, changed, keepRunning, dryRun } = params;
  const serviceTarget = `gui/${uid}/${label}`;

  if (dryRun) {
    console.log(`[dry-run] Would reload launchd service ${serviceTarget} (${plistPath})`);
    return;
  }

  const loaded = isLaunchdLoaded(uid, label);
  if (loaded && !changed && keepRunning) {
    console.log(`[apply:worker] ${label} already running with an unchanged plist; left as is.`);
    return;
  }
  if (loaded && !changed) {
    // Safe with tasks in flight: the dispatcher persists its state and adopts them on boot.
    runLaunchctl(["kickstart", "-k", serviceTarget], false, false);
    console.log(`[apply:worker] Restarted ${label} via launchctl kickstart.`);
    return;
  }

  if (loaded) {
    runLaunchctl(["bootout", serviceTarget], false, true);
    // launchctl bootout tears down asynchronously; wait briefly before bootstrap to avoid EIO (5)
    for (let i = 0; i < 25; i += 1) {
      if (!isLaunchdLoaded(uid, label)) break;
      sleepSync(200);
    }
  }

  runLaunchctl(["bootstrap", `gui/${uid}`, plistPath], false, false);
  console.log(`[apply:worker] Loaded ${label} via launchctl bootstrap.`);
}

function runSystemctlUser(args: string[], dryRun: boolean, allowFail = false): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
  };
  if (dryRun) {
    console.log(
      `[dry-run] Would run: XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR} systemctl --user ${args.join(" ")}`,
    );
    return;
  }
  try {
    execFileSync("systemctl", ["--user", ...args], { stdio: "inherit", env });
  } catch (err) {
    if (!allowFail) throw err;
  }
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const home = homedir();

  const swarm = loadSwarmConfig(repoRoot);
  const projects = loadProjectsConfigOptional(repoRoot);
  const machineName = resolveCurrentMachineName(swarm, flags.machine, "worker");
  const machineCfg = swarm.machines[machineName];
  if (!machineCfg) {
    throw new Error(`Machine "${machineName}" not found in config/swarm.json`);
  }

  const expectedPlatform = machineCfg.os === "macos" ? "darwin" : "linux";
  if (process.platform !== expectedPlatform && !flags.dryRun) {
    throw new Error(
      `Machine "${machineName}" is configured with os="${machineCfg.os}", but current platform is "${process.platform}". Pass --dry-run to preview.`,
    );
  }

  const machineRuntime = resolveMachineRuntime(machineCfg);

  if (machineCfg.os === "macos") {
    const label = "dev.swarm.dispatcher";
    const launchAgentsDir = resolve(home, "Library/LaunchAgents");
    const plistPath = resolve(launchAgentsDir, `${label}.plist`);
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;

    if (flags.unload) {
      console.log(`[apply:worker] Unloading ${label} on "${machineName}"...`);
      runLaunchctl(["bootout", `gui/${uid}/${label}`], flags.dryRun, true);
      if (!flags.dryRun && existsSync(plistPath)) {
        unlinkSync(plistPath);
        console.log(`[apply:worker] Removed ${plistPath}`);
      } else if (flags.dryRun) {
        console.log(`[dry-run] Would remove: ${plistPath}`);
      }
      return;
    }

    console.log(
      `[apply:worker] Verified configs: machine=${machineName}, os=macos, runtime=${machineRuntime.kind}, maxWorkers=${machineCfg.maxWorkers}, projects=${Object.keys(projects.projects).length}`,
    );

    if (machineRuntime.kind === "rex" && !flags.dryRun) {
      const rexBin = machineRuntime.binary ?? "rex";
      const check = runQuickCommand(rexBin, ["whoami", "--json"], 5_000);
      if (!check.ok) {
        console.warn(
          "[apply:worker] Rex server is not reachable yet. On macOS, the Rex app hosts the server — open Rex.app and keep a logged-in GUI session active.",
        );
      }
    }

    const plistContent = renderLaunchdPlist({
      label,
      repoRoot,
      home,
      machine: machineName,
      nodeBin: resolveNodeExecutable(home),
      vercelScope: swarm.board.scope,
      boardName: swarm.board.boardName,
    });

    const existing = existsSync(plistPath) ? readFileSync(plistPath, "utf8") : null;
    const changed = existing !== plistContent;

    if (flags.dryRun) {
      console.log(
        `[dry-run] Target plist: ${plistPath} (${changed ? "would update" : "unchanged"})`,
      );
      console.log(plistContent);
    } else {
      mkdirSync(launchAgentsDir, { recursive: true });
      mkdirSync(resolve(home, "Library/Logs"), { recursive: true });
      if (changed) {
        writeFileSync(plistPath, plistContent, "utf8");
        console.log(`[apply:worker] Wrote ${plistPath}`);
      } else {
        console.log(`[apply:worker] ${plistPath} already up to date.`);
      }
    }

    if (!flags.noLoad) {
      reloadLaunchdService({
        uid,
        label,
        plistPath,
        changed,
        keepRunning: flags.keepRunning,
        dryRun: flags.dryRun,
      });
    }

    console.log("[apply:worker] Logs:");
    console.log(`  stdout: ${resolve(home, "Library/Logs/swarm-dispatcher.out.log")}`);
    console.log(`  stderr: ${resolve(home, "Library/Logs/swarm-dispatcher.err.log")}`);
    if (Object.keys(projects.projects).length === 0) {
      console.log(
        "[apply:worker] No repos registered yet — add one anytime with: mise run project:add -- ~/path/to/your-repo",
      );
    }
    return;
  }

  // Linux systemd --user worker service
  const unitName = "swarm-dispatcher.service";
  const unitDir = resolve(home, ".config/systemd/user");
  const unitPath = resolve(unitDir, unitName);

  if (flags.unload) {
    console.log(`[apply:worker] Disabling ${unitName} on "${machineName}"...`);
    runSystemctlUser(["disable", "--now", unitName], flags.dryRun, true);
    if (!flags.dryRun && existsSync(unitPath)) {
      unlinkSync(unitPath);
      runSystemctlUser(["daemon-reload"], false, true);
      console.log(`[apply:worker] Removed ${unitPath}`);
    } else if (flags.dryRun) {
      console.log(`[dry-run] Would remove: ${unitPath}`);
    }
    return;
  }

  console.log(
    `[apply:worker] Verified configs: machine=${machineName}, os=linux, runtime=${machineRuntime.kind}, maxWorkers=${machineCfg.maxWorkers}, projects=${Object.keys(projects.projects).length}`,
  );

  if (machineRuntime.kind === "rex" && !flags.dryRun) {
    const rexBin = machineRuntime.binary ?? "rex";
    const whoami = runQuickCommand(rexBin, ["whoami", "--json"], 5_000);
    if (!whoami.ok) {
      console.log(
        "[apply:worker] Rex server not running; attempting `rex server install` (user systemd)...",
      );
      const install = runQuickCommand(rexBin, ["server", "install"], 15_000);
      if (!install.ok) {
        console.warn(
          `[apply:worker] Could not auto-install user Rex server (${install.output}). Run \`${rexBin} server install\` (or \`${rexBin} server start\`) manually.`,
        );
      }
    }
  }

  const unitContent = renderSystemdWorkerUnit({
    repoRoot,
    machine: machineName,
    vercelScope: swarm.board.scope,
    boardName: swarm.board.boardName,
    runtimeKind: machineRuntime.kind,
  });

  const existing = existsSync(unitPath) ? readFileSync(unitPath, "utf8") : null;
  const changed = existing !== unitContent;

  if (flags.dryRun) {
    console.log(`[dry-run] Target unit: ${unitPath} (${changed ? "would update" : "unchanged"})`);
    console.log(unitContent);
  } else {
    mkdirSync(unitDir, { recursive: true });
    if (changed) {
      writeFileSync(unitPath, unitContent, "utf8");
      console.log(`[apply:worker] Wrote ${unitPath}`);
    } else {
      console.log(`[apply:worker] ${unitPath} already up to date.`);
    }
  }

  if (!flags.noLoad) {
    runSystemctlUser(["daemon-reload"], flags.dryRun);
    if (flags.keepRunning && !changed) {
      // Starts it if stopped; leaves a running dispatcher alone.
      runSystemctlUser(["enable", "--now", unitName], flags.dryRun);
    } else {
      // `enable --now` alone never restarts a running unit, so new code would not load.
      // Restarting is safe with tasks in flight: the dispatcher persists and re-adopts them.
      runSystemctlUser(["enable", unitName], flags.dryRun);
      runSystemctlUser(["restart", unitName], flags.dryRun);
    }
  }
}

main();
