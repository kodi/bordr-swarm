import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgentCliArgs,
  loadProjectsConfig,
  loadSwarmConfig,
  resolveCurrentMachineName,
} from "../src/lib/config.ts";
import { HerdrClient } from "../src/lib/herdr.ts";

interface MainApplyFlags {
  dryRun: boolean;
  noReload: boolean;
  startLead: boolean;
  machine?: string;
}

function parseFlags(argv: string[]): MainApplyFlags {
  let dryRun = false;
  let noReload = false;
  let startLead = false;
  let machine: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-reload") noReload = true;
    else if (arg === "--start-lead") startLead = true;
    else if (arg === "--machine" && argv[i + 1]) {
      machine = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--machine=")) {
      machine = arg.slice("--machine=".length);
    }
  }
  return { dryRun, noReload, startLead, machine };
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
    execFileSync("launchctl", args, { stdio: "inherit" });
  } catch (err) {
    if (!allowFail) throw err;
  }
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

function detectDefaultBoardUrl(): string {
  try {
    const out = execFileSync("vercel", ["board", "whoami", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    const startIdx = out.indexOf("{");
    if (startIdx === -1) return "";
    const parsed = JSON.parse(out.slice(startIdx)) as { board?: unknown };
    return typeof parsed.board === "string" ? parsed.board.trim() : "";
  } catch {
    return "";
  }
}

async function ensureLeadRunning(params: {
  workspaceDir: string;
  boardProfile: string;
  vercelScope: string;
  boardName: string;
  leadArgs: string[];
  dryRun: boolean;
}): Promise<void> {
  if (params.dryRun) {
    console.log(
      `[dry-run] Would ensure Herdr workspace "swarm-hq" and Lead agent "lead" (claude ${params.leadArgs.join(" ")})`,
    );
    return;
  }

  const herdr = new HerdrClient({ target: "local" });
  const existingLead = await herdr.getAgent("lead");
  if (existingLead) {
    console.log(
      `[apply:main] Lead agent "lead" is already running in pane ${existingLead.pane_id} (status=${existingLead.agent_status}).`,
    );
    return;
  }

  const env: Record<string, string> = {
    BOARD_PROFILE: params.boardProfile,
  };
  if (params.vercelScope) env.VERCEL_SCOPE = params.vercelScope;
  if (params.boardName) env.VERCEL_BOARD_NAME = params.boardName;

  const pane = await herdr.findOrCreateProjectTab({
    workspaceLabel: "swarm-hq",
    cwd: params.workspaceDir,
    tabLabel: "lead",
    env,
  });

  const startRes = await herdr.startAgent({
    name: "lead",
    kind: "claude",
    paneId: pane.paneId,
    args: params.leadArgs,
    timeoutMs: 60_000,
  });

  if (startRes.blockedOnStartup) {
    console.log(
      `[apply:main] Lead agent started in ${pane.tabId} but is waiting on a startup prompt in Sheprd.`,
    );
  } else {
    console.log(`[apply:main] Started Lead agent "lead" in ${pane.tabId} (${pane.paneId}).`);
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const home = homedir();

  const swarm = loadSwarmConfig(repoRoot);
  loadProjectsConfig(repoRoot);

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

  const allowHosts = [
    ...new Set(
      machineCfg.allowedHosts.length > 0
        ? machineCfg.allowedHosts
        : machineCfg.hostname
          ? [machineCfg.hostname]
          : [],
    ),
  ];

  const resolvedBoardUrl = swarm.board.scope ? "" : detectDefaultBoardUrl();
  if (!swarm.board.scope && !resolvedBoardUrl) {
    console.warn(
      "[apply:main] Warning: board.scope is empty and `vercel board whoami --json` did not return a board URL; `board inspect` may need --scope or --url.",
    );
  }

  console.log(
    `[apply:main] Configuring main machine "${machineName}" (os=${machineCfg.os}, hostname=${machineCfg.hostname}, viewerPort=${swarm.board.viewerPort})`,
  );

  // 1. Install Board Inspector UI background service for Linux (systemd --user) or macOS (launchd)
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
    writeFileIfChanged(
      resolve(home, ".config/systemd/user/vercel-board-ui.service"),
      unitContent,
      flags.dryRun,
    );

    if (!flags.noReload) {
      runSystemctlUser(["daemon-reload"], flags.dryRun);
      runSystemctlUser(["enable", "--now", "vercel-board-ui.service"], flags.dryRun);
      runSystemctlUser(["restart", "vercel-board-ui.service"], flags.dryRun);
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
    writeFileIfChanged(plistPath, plistContent, flags.dryRun);

    if (!flags.noReload) {
      runLaunchctl(["bootout", `gui/${uid}/dev.swarm.board-ui`], flags.dryRun, true);
      runLaunchctl(["bootstrap", `gui/${uid}`, plistPath], flags.dryRun, false);
    }
  }

  // 2. Prepare Lead HQ workspace (e.g. ~/swarm-hq) with rendered CLAUDE.md + projects.json symlink
  const leadWorkspaceDir = swarm.lead.workspaceDir.startsWith("~/")
    ? resolve(home, swarm.lead.workspaceDir.slice(2))
    : swarm.lead.workspaceDir;

  const defaultWorkerMachine =
    Object.entries(swarm.machines).find(
      ([name, m]) => name !== machineName && (m.role === "worker" || m.maxWorkers > 0),
    )?.[0] ?? machineName;

  const leadPromptTemplate = readFileSync(resolve(repoRoot, "prompts/lead-CLAUDE.md"), "utf8");
  const renderedLeadPrompt = leadPromptTemplate
    .replaceAll("{{MAIN_MACHINE}}", machineName)
    .replaceAll("{{DEFAULT_WORKER_MACHINE}}", defaultWorkerMachine)
    .replaceAll("{{HUMAN_HANDLE}}", swarm.board.humanHandle);

  const leadPromptDest = resolve(leadWorkspaceDir, "CLAUDE.md");
  const projectsConfigSrc = resolve(repoRoot, "config/projects.json");
  const projectsLinkDest = resolve(leadWorkspaceDir, "projects.json");

  writeFileIfChanged(leadPromptDest, renderedLeadPrompt, flags.dryRun);

  if (flags.dryRun) {
    console.log(`[dry-run] Would symlink ${projectsConfigSrc} -> ${projectsLinkDest}`);
  } else if (existsSync(projectsConfigSrc)) {
    mkdirSync(leadWorkspaceDir, { recursive: true });
    let linkExists = false;
    try {
      lstatSync(projectsLinkDest);
      linkExists = true;
    } catch {
      linkExists = false;
    }
    if (linkExists) unlinkSync(projectsLinkDest);
    symlinkSync(projectsConfigSrc, projectsLinkDest);
    console.log(`[apply:main] Linked ${projectsLinkDest} -> ${projectsConfigSrc}`);
  }

  // 3. Optionally start the Lead agent in Herdr
  const leadArgs = buildAgentCliArgs({
    kind: "claude",
    model: swarm.lead.model,
    effort: swarm.lead.effort,
    permissionMode: swarm.lead.permissionMode,
    extraArgs: [],
  });

  if (flags.startLead) {
    await ensureLeadRunning({
      workspaceDir: leadWorkspaceDir,
      boardProfile: swarm.lead.boardProfile,
      vercelScope: swarm.board.scope,
      boardName: swarm.board.boardName,
      leadArgs,
      dryRun: flags.dryRun,
    });
  } else {
    console.log("[apply:main] To start the Lead agent in Herdr, re-run with --start-lead.");
  }

  console.log("\n[apply:main] Optional reverse-proxy reminder:");
  console.log(
    `  Board UI listens on 127.0.0.1:${swarm.board.viewerPort}. To expose over your tailnet/LAN, reverse-proxy it (see infra/caddy/board-snippet.Caddyfile) and restrict access to your private network interface.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
