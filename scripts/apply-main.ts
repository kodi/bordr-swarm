import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSwarmConfig, resolveCurrentMachineName } from "../src/lib/config.ts";
import { HerdrClient, sanitizeHerdrAgentName } from "../src/lib/herdr.ts";
import { detectTailscaleInfo, detectVercelBoardIdentity } from "../src/lib/host-env.ts";

interface MainApplyFlags {
  dryRun: boolean;
  noReload: boolean;
  startLead: boolean;
  restartWatcher: boolean;
  restartLead: boolean;
  restartUi: boolean;
  machine?: string;
}

function parseFlags(argv: string[]): MainApplyFlags {
  let dryRun = false;
  let noReload = false;
  let startLead = true;
  let restartWatcher = false;
  let restartLead = false;
  let restartUi = false;
  let machine: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-reload") noReload = true;
    else if (arg === "--start-lead") startLead = true;
    else if (arg === "--no-start-lead") startLead = false;
    else if (arg === "--restart-watcher") restartWatcher = true;
    else if (arg === "--restart-lead") restartLead = true;
    else if (arg === "--restart-ui") restartUi = true;
    else if (arg === "--machine" && argv[i + 1]) {
      machine = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--machine=")) {
      machine = arg.slice("--machine=".length);
    }
  }
  return { dryRun, noReload, startLead, restartWatcher, restartLead, restartUi, machine };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function writeFileIfChanged(targetPath: string, content: string, dryRun: boolean): boolean {
  const existing = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
  if (existing === content) {
    console.log(`[apply:main] Unchanged: ${targetPath}`);
    return false;
  }
  if (dryRun) {
    console.log(`[dry-run] Would write ${targetPath}`);
    return true;
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, "utf8");
  console.log(`[apply:main] Updated: ${targetPath}`);
  return true;
}

function runSystemctlUser(args: string[], dryRun: boolean): void {
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
  execFileSync("systemctl", ["--user", ...args], { stdio: "inherit", env });
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
  dryRun: boolean;
}): void {
  const { uid, label, plistPath, changed, dryRun } = params;
  const serviceTarget = `gui/${uid}/${label}`;
  if (dryRun) {
    console.log(`[dry-run] Would reload launchd service ${serviceTarget}`);
    return;
  }
  const loaded = isLaunchdLoaded(uid, label);
  if (loaded && !changed) {
    runLaunchctl(["kickstart", "-k", serviceTarget], false, false);
    return;
  }
  if (loaded) {
    runLaunchctl(["bootout", serviceTarget], false, true);
    for (let i = 0; i < 25; i += 1) {
      if (!isLaunchdLoaded(uid, label)) break;
      sleepSync(200);
    }
  }
  runLaunchctl(["bootstrap", `gui/${uid}`, plistPath], false, false);
}

function renderSystemdBoardUiUnit(params: {
  repoRoot: string;
  port: number;
  allowHosts: string[];
  scope: string;
  boardName: string;
  boardUrl: string;
}): string {
  const extraFlags: string[] = [];
  for (const h of params.allowHosts) {
    extraFlags.push("--allow-host", h);
  }
  if (params.scope) {
    extraFlags.push("--scope", params.scope);
  } else if (params.boardUrl) {
    extraFlags.push("--url", params.boardUrl);
  }
  if (params.boardName) {
    extraFlags.push("--name", params.boardName);
  }

  const execLine = [
    "%h/.local/share/mise/shims/board inspect",
    `--port ${params.port}`,
    "--no-open",
    ...extraFlags,
  ].join(" ");

  return `[Unit]
Description=Vercel Board Inspector UI (localhost only, optional reverse proxy)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${params.repoRoot}
EnvironmentFile=-%h/.config/swarm/board.env
Environment=PATH=%h/.local/share/mise/shims:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${execLine}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function renderSystemdLeadWatcherUnit(params: {
  repoRoot: string;
  machine: string;
  scope: string;
  boardName: string;
}): string {
  const envLines = [
    "Environment=PATH=%h/.local/share/mise/shims:%h/.local/bin:/usr/local/bin:/usr/bin:/bin",
    `Environment=SWARM_MACHINE=${params.machine}`,
    "Environment=NODE_NO_WARNINGS=1",
  ];
  if (params.scope) envLines.push(`Environment=VERCEL_SCOPE=${params.scope}`);
  if (params.boardName) envLines.push(`Environment=VERCEL_BOARD_NAME=${params.boardName}`);

  return `[Unit]
Description=bordr-swarm Lead Watcher (0-token event router for Lead agent)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${params.repoRoot}
EnvironmentFile=-%h/.config/swarm/board.env
${envLines.join("\n")}
ExecStart=%h/.local/share/mise/shims/node ${resolve(params.repoRoot, "src/lead-watcher.ts")} --machine ${params.machine}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function renderLaunchdLeadWatcherPlist(params: {
  home: string;
  repoRoot: string;
  machine: string;
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

  const miseNode = resolve(params.home, ".local/share/mise/shims/node");
  const nodeBin = existsSync(miseNode) ? miseNode : process.execPath;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.swarm.lead-watcher</string>

  <key>WorkingDirectory</key>
  <string>${xmlEscape(params.repoRoot)}</string>

  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>

  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(resolve(params.repoRoot, "src/lead-watcher.ts"))}</string>
    <string>--machine</string>
    <string>${xmlEscape(params.machine)}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${xmlEscape(resolve(params.home, "Library/Logs/swarm-lead-watcher.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(resolve(params.home, "Library/Logs/swarm-lead-watcher.err.log"))}</string>
</dict>
</plist>
`;
}

function renderLaunchdBoardUiPlist(params: {
  home: string;
  repoRoot: string;
  port: number;
  allowHosts: string[];
  vercelScope: string;
  boardName: string;
  boardUrl: string;
}): string {
  const pathEnv = [
    `${params.home}/.local/share/mise/shims`,
    `${params.home}/.local/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");

  const envEntries: Array<[string, string]> = [["PATH", pathEnv]];
  if (params.vercelScope) envEntries.push(["VERCEL_SCOPE", params.vercelScope]);
  if (params.boardName) envEntries.push(["VERCEL_BOARD_NAME", params.boardName]);

  const envXml = envEntries
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join("\n");

  const boardBin = resolve(params.home, ".local/share/mise/shims/board");
  const args = [
    boardBin,
    "inspect",
    "--port",
    String(params.port),
    "--no-open",
    ...params.allowHosts.flatMap((h) => ["--allow-host", h]),
  ];
  if (params.vercelScope) {
    args.push("--scope", params.vercelScope);
  } else if (params.boardUrl) {
    args.push("--url", params.boardUrl);
  }
  if (params.boardName) {
    args.push("--name", params.boardName);
  }
  const argsXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.swarm.board-ui</string>

  <key>WorkingDirectory</key>
  <string>${xmlEscape(params.repoRoot)}</string>

  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>

  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${xmlEscape(resolve(params.home, "Library/Logs/swarm-board-ui.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(resolve(params.home, "Library/Logs/swarm-board-ui.err.log"))}</string>
</dict>
</plist>
`;
}

async function reconcileLeadTabs(params: {
  boardProfile: string;
  restartLead: boolean;
  dryRun: boolean;
}): Promise<void> {
  const leadPrefix = sanitizeHerdrAgentName(params.boardProfile, "");
  if (params.dryRun) {
    console.log(
      `[dry-run] Lead runs ephemerally per thread via Lead Watcher (would close any legacy idle "${leadPrefix}" tab${params.restartLead ? ` and idle "${leadPrefix}-*" tabs` : ""}).`,
    );
    return;
  }

  const herdr = new HerdrClient({ target: "local" });
  let agents;
  try {
    agents = await herdr.listAgents();
  } catch {
    console.log(
      "[apply:main] Lead runs ephemerally per thread via Lead Watcher (Herdr not reachable right now; Lead Watcher will spawn tabs on demand).",
    );
    return;
  }

  const tabsToClose = new Set<string>();
  for (const agent of agents) {
    if (!agent.tab_id) continue;
    const isLegacyPersistent = agent.name === leadPrefix;
    const isEphemeralLead = Boolean(agent.name?.startsWith(`${leadPrefix}-`));
    const isIdle = agent.agent_status === "idle" || agent.agent_status === "done";

    if (isLegacyPersistent && (isIdle || params.restartLead)) {
      tabsToClose.add(agent.tab_id);
      console.log(
        `[apply:main] Closing legacy persistent Lead tab ${agent.tab_id} (Lead now runs ephemerally per thread via Lead Watcher).`,
      );
    } else if (isEphemeralLead && params.restartLead && isIdle) {
      tabsToClose.add(agent.tab_id);
      console.log(`[apply:main] Closing idle ephemeral Lead tab ${agent.tab_id} (--restart-lead).`);
    }
  }

  for (const tabId of tabsToClose) {
    await herdr.closeTab(tabId).catch(() => {});
  }

  console.log(
    "[apply:main] Lead runs ephemerally per thread via Lead Watcher (spawns fresh tabs on demand, auto-closes when idle, and picks up CLAUDE.md automatically).",
  );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const home = homedir();

  const swarm = loadSwarmConfig(repoRoot);

  const machineName = resolveCurrentMachineName(swarm, flags.machine ?? swarm.lead.machine, "main");
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

  const tailscale = detectTailscaleInfo();
  const allowHosts = [
    ...new Set([
      ...(machineCfg.allowedHosts.length > 0
        ? machineCfg.allowedHosts
        : machineCfg.hostname
          ? [machineCfg.hostname]
          : []),
      ...(tailscale.ok ? [tailscale.dnsName, `${tailscale.dnsName}:4748`] : []),
    ]),
  ];

  const resolvedBoardUrl = swarm.board.scope ? "" : detectVercelBoardIdentity().boardUrl;
  if (!swarm.board.scope && !resolvedBoardUrl) {
    console.warn(
      "[apply:main] Warning: board.scope is empty and `vercel board whoami --json` did not return a board URL; `board inspect` may need --scope or --url.",
    );
  }

  console.log(
    `[apply:main] Configuring main machine "${machineName}" (os=${machineCfg.os}, hostname=${machineCfg.hostname}, viewerPort=${swarm.board.viewerPort})`,
  );

  // 1. Prepare Lead HQ workspace (e.g. ~/swarm-hq) with rendered CLAUDE.md BEFORE starting Lead Watcher
  const leadWorkspaceDir = swarm.lead.workspaceDir.startsWith("~/")
    ? resolve(home, swarm.lead.workspaceDir.slice(2))
    : swarm.lead.workspaceDir;

  const defaultWorkerMachine =
    Object.entries(swarm.machines).find(
      ([name, m]) => name !== machineName && (m.role === "worker" || m.maxWorkers > 0),
    )?.[0] ?? "any";

  const leadPromptTemplate = readFileSync(resolve(repoRoot, "prompts/lead-CLAUDE.md"), "utf8");
  const renderedLeadPrompt = leadPromptTemplate
    .replaceAll("{{MAIN_MACHINE}}", machineName)
    .replaceAll("{{DEFAULT_WORKER_MACHINE}}", defaultWorkerMachine)
    .replaceAll("{{HUMAN_HANDLE}}", swarm.board.humanHandle);

  const leadPromptDest = resolve(leadWorkspaceDir, "CLAUDE.md");
  const projectsLinkDest = resolve(leadWorkspaceDir, "projects.json");

  writeFileIfChanged(leadPromptDest, renderedLeadPrompt, flags.dryRun);

  // Remove any legacy symlink so Lead Watcher can sync #swarm/registry into ~/swarm-hq/projects.json cleanly
  if (!flags.dryRun) {
    try {
      if (lstatSync(projectsLinkDest).isSymbolicLink()) {
        unlinkSync(projectsLinkDest);
        console.log(
          `[apply:main] Removed legacy symlink ${projectsLinkDest} (now auto-synced from #${swarm.board.registryChannel}).`,
        );
      }
    } catch {
      // Nothing to remove
    }
  }

  // 2. Install Board Inspector UI & Lead Watcher background services for Linux (systemd --user) or macOS (launchd)
  if (machineCfg.os === "linux") {
    const envLines: string[] = [];
    if (swarm.board.scope) envLines.push(`VERCEL_SCOPE=${swarm.board.scope}`);
    if (swarm.board.boardName) envLines.push(`VERCEL_BOARD_NAME=${swarm.board.boardName}`);
    writeFileIfChanged(
      resolve(home, ".config/swarm/board.env"),
      envLines.length > 0 ? `${envLines.join("\n")}\n` : "# Optional Vercel Board overrides\n",
      flags.dryRun,
    );

    const unitContent = renderSystemdBoardUiUnit({
      repoRoot,
      port: swarm.board.viewerPort,
      allowHosts,
      scope: swarm.board.scope,
      boardName: swarm.board.boardName,
      boardUrl: resolvedBoardUrl,
    });
    const uiUnitChanged = writeFileIfChanged(
      resolve(home, ".config/systemd/user/vercel-board-ui.service"),
      unitContent,
      flags.dryRun,
    );

    const leadWatcherUnit = renderSystemdLeadWatcherUnit({
      repoRoot,
      machine: machineName,
      scope: swarm.board.scope,
      boardName: swarm.board.boardName,
    });
    const watcherUnitChanged = writeFileIfChanged(
      resolve(home, ".config/systemd/user/bordr-lead-watcher.service"),
      leadWatcherUnit,
      flags.dryRun,
    );

    if (!flags.noReload) {
      runSystemctlUser(["daemon-reload"], flags.dryRun);
      runSystemctlUser(["enable", "--now", "vercel-board-ui.service"], flags.dryRun);
      if (uiUnitChanged || flags.restartUi) {
        runSystemctlUser(["restart", "vercel-board-ui.service"], flags.dryRun);
      }
      runSystemctlUser(["enable", "--now", "bordr-lead-watcher.service"], flags.dryRun);
      if (watcherUnitChanged || flags.restartWatcher) {
        runSystemctlUser(["restart", "bordr-lead-watcher.service"], flags.dryRun);
      }
    }
  } else {
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    const plistPath = resolve(home, "Library/LaunchAgents/dev.swarm.board-ui.plist");
    const plistContent = renderLaunchdBoardUiPlist({
      home,
      repoRoot,
      port: swarm.board.viewerPort,
      allowHosts,
      vercelScope: swarm.board.scope,
      boardName: swarm.board.boardName,
      boardUrl: resolvedBoardUrl,
    });
    const uiPlistChanged = writeFileIfChanged(plistPath, plistContent, flags.dryRun);

    const leadWatcherPlistPath = resolve(home, "Library/LaunchAgents/dev.swarm.lead-watcher.plist");
    const leadWatcherPlist = renderLaunchdLeadWatcherPlist({
      home,
      repoRoot,
      machine: machineName,
      vercelScope: swarm.board.scope,
      boardName: swarm.board.boardName,
    });
    const watcherPlistChanged = writeFileIfChanged(
      leadWatcherPlistPath,
      leadWatcherPlist,
      flags.dryRun,
    );

    if (!flags.noReload) {
      reloadLaunchdService({
        uid,
        label: "dev.swarm.board-ui",
        plistPath,
        changed: uiPlistChanged,
        dryRun: flags.dryRun,
      });
      reloadLaunchdService({
        uid,
        label: "dev.swarm.lead-watcher",
        plistPath: leadWatcherPlistPath,
        changed: watcherPlistChanged,
        dryRun: flags.dryRun,
      });
    }
  }

  // 3. Reconcile any legacy persistent Lead tab (Lead Watcher spawns ephemeral per-thread tabs on demand)
  if (flags.startLead || flags.restartLead) {
    await reconcileLeadTabs({
      boardProfile: swarm.lead.boardProfile,
      restartLead: flags.restartLead,
      dryRun: flags.dryRun,
    });
  }

  console.log("\n[apply:main] Board UI access:");
  if (machineCfg.role === "both") {
    console.log(
      `  Local: http://127.0.0.1:${swarm.board.viewerPort} (ready immediately — localhost is a Secure Context).`,
    );
    if (tailscale.ok) {
      console.log(
        `  Optional remote HTTPS: sudo tailscale serve --bg --https=4748 http://127.0.0.1:${swarm.board.viewerPort}  ->  https://${tailscale.dnsName}:4748`,
      );
    }
  } else if (tailscale.ok) {
    console.log(
      `  Board UI listens on 127.0.0.1:${swarm.board.viewerPort} (Tailscale FQDN "${tailscale.dnsName}" auto-added to --allow-host).`,
    );
    console.log(
      `  Expose privately over HTTPS (required for posting messages): sudo tailscale serve --bg --https=4748 http://127.0.0.1:${swarm.board.viewerPort}`,
    );
    console.log(`  Then open: https://${tailscale.dnsName}:4748`);
  } else {
    console.log(
      `  Board UI listens on 127.0.0.1:${swarm.board.viewerPort}. For remote access, expose over HTTPS (e.g. \`sudo tailscale serve --bg --https=4748 http://127.0.0.1:${swarm.board.viewerPort}\`).`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
