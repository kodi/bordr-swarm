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
import { detectTailscaleInfo } from "../src/lib/host-env.ts";

export const UI_UPGRADE_TOOLS = ["npm:@vercel/board", "npm:vercel"] as const;
export const SYSTEMD_UI_UNIT = "vercel-board-ui.service";
export const LAUNCHD_UI_LABEL = "dev.swarm.board-ui";

export interface UiUpdateFlags {
  dryRun: boolean;
  restartOnly: boolean;
  noRestart: boolean;
  help: boolean;
  machine?: string;
}

export interface UiUpdateDeps {
  exec: (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => void;
  execCapture: (
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => { ok: boolean; stdout: string };
  exists: (targetPath: string) => boolean;
  checkHttp: (url: string) => Promise<{ ok: boolean; status?: number; detail: string }>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  detectTailscaleDns: () => string;
}

export interface UiUpdateOptions {
  flags: UiUpdateFlags;
  repoRoot: string;
  home: string;
  os: MachineOs;
  uid: number;
  viewerPort: number;
  isMainHost: boolean;
  machineLabel: string;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<UiUpdateDeps>;
}

export interface UiUpdateResult {
  beforeVersion: string | null;
  afterVersion: string | null;
  upgraded: boolean;
  restarted: boolean;
  health?: { ok: boolean; status?: number; detail: string };
}

export function parseUiUpdateFlags(argv: string[]): UiUpdateFlags {
  let dryRun = false;
  let restartOnly = false;
  let noRestart = false;
  let help = false;
  let machine: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--restart-only" || arg === "--no-upgrade") restartOnly = true;
    else if (arg === "--no-restart") noRestart = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--machine" && argv[i + 1]) {
      machine = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--machine=")) {
      machine = arg.slice("--machine=".length);
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown option: ${arg} (pass --help to see usage)`);
    }
  }

  return { dryRun, restartOnly, noRestart, help, machine };
}

export function printUiUpdateHelp(log: (line: string) => void = console.log): void {
  log(`Usage: mise run ui:update [-- [options]]

Upgrades @vercel/board & Vercel CLI via \`mise upgrade\` and restarts the
Board Inspector UI background service (${SYSTEMD_UI_UNIT} on Linux,
${LAUNCHD_UI_LABEL} on macOS).

Options:
  --restart-only, --no-upgrade  Skip \`mise upgrade\`; only restart the Board UI service
  --no-restart                  Upgrade tools without restarting the Board UI service
  --machine <name>              Override machine key from config/swarm.json
  --dry-run                     Show commands that would run without executing them
  -h, --help                    Show this help message`);
}

function buildSystemdEnv(baseEnv: NodeJS.ProcessEnv, uid: number): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    XDG_RUNTIME_DIR: baseEnv.XDG_RUNTIME_DIR || `/run/user/${uid}`,
  };
}

function defaultDeps(): UiUpdateDeps {
  return {
    exec(cmd, args, opts) {
      execFileSync(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: "inherit",
      });
    },
    execCapture(cmd, args, opts) {
      try {
        const stdout = execFileSync(cmd, args, {
          cwd: opts?.cwd,
          env: opts?.env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
        }).trim();
        return { ok: true, stdout };
      } catch {
        return { ok: false, stdout: "" };
      }
    },
    exists(targetPath) {
      return existsSync(targetPath);
    },
    async checkHttp(url) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2_500) });
        return {
          ok: res.status >= 200 && res.status < 400,
          status: res.status,
          detail: `HTTP ${res.status}`,
        };
      } catch (err) {
        return {
          ok: false,
          detail: `unreachable (${err instanceof Error ? err.message : String(err)})`,
        };
      }
    },
    async sleep(ms) {
      await new Promise((r) => setTimeout(r, ms));
    },
    log(line) {
      console.log(line);
    },
    detectTailscaleDns() {
      const ts = detectTailscaleInfo();
      return ts.ok ? ts.dnsName : "";
    },
  };
}

function readToolVersion(deps: UiUpdateDeps, repoRoot: string): string | null {
  const res = deps.execCapture("mise", ["current", "npm:@vercel/board"], { cwd: repoRoot });
  if (!res.ok) return null;
  const ver = res.stdout.split("\n")[0]?.trim() ?? "";
  return ver || null;
}

async function waitForUiHealth(
  url: string,
  deps: UiUpdateDeps,
  maxAttempts = 20,
  delayMs = 400,
): Promise<{ ok: boolean; status?: number; detail: string }> {
  let last: { ok: boolean; status?: number; detail: string } = {
    ok: false,
    detail: "unreachable",
  };
  for (let i = 0; i < maxAttempts; i += 1) {
    last = await deps.checkHttp(url);
    if (last.ok) return last;
    if (i + 1 < maxAttempts) {
      await deps.sleep(delayMs);
    }
  }
  return last;
}

export async function runUiUpdate(options: UiUpdateOptions): Promise<UiUpdateResult> {
  const deps: UiUpdateDeps = { ...defaultDeps(), ...options.deps };
  const { flags, repoRoot, home, os, uid, viewerPort, isMainHost, machineLabel } = options;
  const baseEnv = options.env ?? process.env;

  if (flags.help) {
    printUiUpdateHelp(deps.log);
    return { beforeVersion: null, afterVersion: null, upgraded: false, restarted: false };
  }

  let beforeVersion: string | null = null;
  let afterVersion: string | null = null;
  let upgraded = false;

  if (!flags.restartOnly) {
    beforeVersion = readToolVersion(deps, repoRoot);
    const upgradeArgs = ["upgrade", ...UI_UPGRADE_TOOLS];
    if (flags.dryRun) {
      deps.log(`[dry-run] Would run: mise ${upgradeArgs.join(" ")}`);
    } else {
      deps.log(`[ui:update] Upgrading ${UI_UPGRADE_TOOLS.join(" & ")} via mise...`);
      deps.exec("mise", upgradeArgs, { cwd: repoRoot });
      afterVersion = readToolVersion(deps, repoRoot);
      upgraded = Boolean(beforeVersion && afterVersion && beforeVersion !== afterVersion);
      if (beforeVersion && afterVersion) {
        if (beforeVersion !== afterVersion) {
          deps.log(`[ui:update] @vercel/board: ${beforeVersion} -> ${afterVersion}`);
        } else {
          deps.log(`[ui:update] @vercel/board: ${afterVersion} (already latest)`);
        }
      } else if (afterVersion) {
        deps.log(`[ui:update] @vercel/board: ${afterVersion}`);
      }
    }
  }

  if (flags.noRestart) {
    deps.log("[ui:update] Skipping Board UI service restart (--no-restart).");
    return { beforeVersion, afterVersion, upgraded, restarted: false };
  }

  const systemdUnitPath = resolve(home, `.config/systemd/user/${SYSTEMD_UI_UNIT}`);
  const launchdPlistPath = resolve(home, `Library/LaunchAgents/${LAUNCHD_UI_LABEL}.plist`);
  const serviceFileExists =
    os === "linux" ? deps.exists(systemdUnitPath) : deps.exists(launchdPlistPath);

  if (!isMainHost && !serviceFileExists) {
    deps.log(
      `[ui:update] Machine "${machineLabel}" does not host the Board UI service — skipping restart.`,
    );
    return { beforeVersion, afterVersion, upgraded, restarted: false };
  }

  if (os === "linux") {
    const env = buildSystemdEnv(baseEnv, uid);
    const unitLoaded =
      serviceFileExists ||
      deps.execCapture("systemctl", ["--user", "cat", SYSTEMD_UI_UNIT], { env }).ok;

    if (!unitLoaded && !flags.dryRun) {
      throw new Error(
        `Board UI service (${SYSTEMD_UI_UNIT}) is not installed on this machine. Run \`mise run apply:main\` first.`,
      );
    }

    if (flags.dryRun) {
      deps.log(
        `[dry-run] Would run: XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR} systemctl --user restart ${SYSTEMD_UI_UNIT}`,
      );
    } else {
      deps.log(`[ui:update] Restarting ${SYSTEMD_UI_UNIT}...`);
      deps.exec("systemctl", ["--user", "restart", SYSTEMD_UI_UNIT], { env });
    }
  } else {
    const serviceTarget = `gui/${uid}/${LAUNCHD_UI_LABEL}`;
    const loaded = deps.execCapture("launchctl", ["print", serviceTarget]).ok;

    if (!loaded && !serviceFileExists && !flags.dryRun) {
      throw new Error(
        `Board UI service (${LAUNCHD_UI_LABEL}) is not installed on this machine. Run \`mise run apply:main\` first.`,
      );
    }

    if (flags.dryRun) {
      deps.log(
        loaded
          ? `[dry-run] Would run: launchctl kickstart -k ${serviceTarget}`
          : `[dry-run] Would run: launchctl bootstrap gui/${uid} ${launchdPlistPath}`,
      );
    } else if (loaded) {
      deps.log(`[ui:update] Restarting ${LAUNCHD_UI_LABEL}...`);
      deps.exec("launchctl", ["kickstart", "-k", serviceTarget], {});
    } else {
      deps.log(`[ui:update] Starting ${LAUNCHD_UI_LABEL}...`);
      deps.exec("launchctl", ["bootstrap", `gui/${uid}`, launchdPlistPath], {});
    }
  }

  if (flags.dryRun) {
    return { beforeVersion, afterVersion, upgraded, restarted: false };
  }

  const localUrl = `http://127.0.0.1:${viewerPort}`;
  const health = await waitForUiHealth(localUrl, deps);
  deps.log(`[ui:update] Board UI health: ${localUrl} -> ${health.detail}`);

  const tsDns = deps.detectTailscaleDns();
  if (tsDns) {
    deps.log(`[ui:update] Tailscale URL:   https://${tsDns}:4748`);
  }

  if (!health.ok) {
    deps.log("[ui:update] Hint: inspect logs with `mise run logs ui`.");
  }

  return { beforeVersion, afterVersion, upgraded, restarted: true, health };
}

async function main(): Promise<void> {
  const flags = parseUiUpdateFlags(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const home = homedir();
  const localOs = currentPlatformOs();
  const uid =
    typeof process.getuid === "function" ? process.getuid() : localOs === "linux" ? 1000 : 501;

  let viewerPort = 4747;
  let isMainHost = true;
  let machineLabel = "local";

  const configPath = process.env.SWARM_CONFIG_PATH ?? resolve(repoRoot, "config/swarm.json");
  if (existsSync(configPath)) {
    const swarm = loadSwarmConfig(repoRoot, configPath);
    const machineName = resolveCurrentMachineName(swarm, flags.machine);
    const machine = swarm.machines[machineName];
    viewerPort = swarm.board.viewerPort;
    machineLabel = machineName;
    if (machine) {
      isMainHost =
        machine.role === "main" || machine.role === "both" || swarm.lead.machine === machineName;
    }
  }

  await runUiUpdate({
    flags,
    repoRoot,
    home,
    os: localOs,
    uid,
    viewerPort,
    isMainHost,
    machineLabel,
  });
}

const isEntrypoint =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  main().catch((err) => {
    console.error(`[ui:update] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
