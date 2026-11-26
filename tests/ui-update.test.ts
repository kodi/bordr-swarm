import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LAUNCHD_UI_LABEL,
  parseUiUpdateFlags,
  runUiUpdate,
  SYSTEMD_UI_UNIT,
  UI_UPGRADE_TOOLS,
  type UiUpdateDeps,
} from "../scripts/ui-update.ts";

function makeMockDeps(overrides: Partial<UiUpdateDeps> = {}) {
  const execCalls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const logs: string[] = [];

  const deps: UiUpdateDeps = {
    exec(cmd, args, opts) {
      execCalls.push({ cmd, args, env: opts.env });
    },
    execCapture() {
      return { ok: true, stdout: "" };
    },
    exists() {
      return true;
    },
    async checkHttp() {
      return { ok: true, status: 200, detail: "HTTP 200" };
    },
    async sleep() {},
    log(line) {
      logs.push(line);
    },
    detectTailscaleDns() {
      return "";
    },
    ...overrides,
  };

  return { deps, execCalls, logs };
}

describe("parseUiUpdateFlags", () => {
  it("parses defaults and supported flags", () => {
    assert.deepEqual(parseUiUpdateFlags([]), {
      dryRun: false,
      restartOnly: false,
      noRestart: false,
      help: false,
      machine: undefined,
    });

    assert.deepEqual(
      parseUiUpdateFlags(["--dry-run", "--restart-only", "--machine", "main-machine"]),
      {
        dryRun: true,
        restartOnly: true,
        noRestart: false,
        help: false,
        machine: "main-machine",
      },
    );

    assert.deepEqual(parseUiUpdateFlags(["--no-upgrade", "--no-restart", "--machine=hub"]), {
      dryRun: false,
      restartOnly: true,
      noRestart: true,
      help: false,
      machine: "hub",
    });

    assert.throws(() => parseUiUpdateFlags(["--unknown-flag"]), /Unknown option/);
  });
});

describe("runUiUpdate", () => {
  it("upgrades @vercel/board & vercel, restarts systemd unit on Linux, and verifies HTTP health", async () => {
    let versionCalls = 0;
    let healthChecks = 0;
    const { deps, execCalls, logs } = makeMockDeps({
      execCapture(cmd, args) {
        if (cmd === "mise" && args[0] === "current") {
          versionCalls += 1;
          return { ok: true, stdout: versionCalls === 1 ? "0.4.0" : "0.5.0" };
        }
        return { ok: true, stdout: "" };
      },
      async checkHttp() {
        healthChecks += 1;
        return healthChecks < 2
          ? { ok: false, detail: "unreachable (ECONNREFUSED)" }
          : { ok: true, status: 200, detail: "HTTP 200" };
      },
      detectTailscaleDns() {
        return "main-machine.tailnet.ts.net";
      },
    });

    const result = await runUiUpdate({
      flags: parseUiUpdateFlags([]),
      repoRoot: "/repo",
      home: "/home/agent",
      os: "linux",
      uid: 1001,
      viewerPort: 4747,
      isMainHost: true,
      machineLabel: "main-machine",
      env: {},
      deps,
    });

    assert.equal(result.beforeVersion, "0.4.0");
    assert.equal(result.afterVersion, "0.5.0");
    assert.equal(result.upgraded, true);
    assert.equal(result.restarted, true);
    assert.equal(result.health?.status, 200);

    assert.equal(execCalls.length, 2);
    assert.deepEqual(execCalls[0]?.cmd, "mise");
    assert.deepEqual(execCalls[0]?.args, ["upgrade", ...UI_UPGRADE_TOOLS]);
    assert.deepEqual(execCalls[1]?.cmd, "systemctl");
    assert.deepEqual(execCalls[1]?.args, ["--user", "restart", SYSTEMD_UI_UNIT]);
    assert.equal(execCalls[1]?.env?.XDG_RUNTIME_DIR, "/run/user/1001");
    assert.ok(logs.some((l) => l.includes("0.4.0 -> 0.5.0")));
    assert.ok(logs.some((l) => l.includes("https://main-machine.tailnet.ts.net:4748")));
  });

  it("restarts loaded launchd service via kickstart -k on macOS with --restart-only", async () => {
    const { deps, execCalls } = makeMockDeps({
      execCapture(cmd, args) {
        if (cmd === "launchctl" && args[0] === "print") {
          return { ok: true, stdout: "state = running" };
        }
        return { ok: false, stdout: "" };
      },
    });

    const result = await runUiUpdate({
      flags: parseUiUpdateFlags(["--restart-only"]),
      repoRoot: "/repo",
      home: "/Users/dev",
      os: "macos",
      uid: 501,
      viewerPort: 4747,
      isMainHost: true,
      machineLabel: "mac-studio",
      deps,
    });

    assert.equal(result.upgraded, false);
    assert.equal(result.restarted, true);
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0]?.cmd, "launchctl");
    assert.deepEqual(execCalls[0]?.args, ["kickstart", "-k", `gui/501/${LAUNCHD_UI_LABEL}`]);
  });

  it("bootstraps unloaded launchd plist on macOS", async () => {
    const { deps, execCalls } = makeMockDeps({
      execCapture() {
        return { ok: false, stdout: "" };
      },
      exists(p) {
        return p.endsWith(`${LAUNCHD_UI_LABEL}.plist`);
      },
    });

    await runUiUpdate({
      flags: parseUiUpdateFlags(["--restart-only"]),
      repoRoot: "/repo",
      home: "/Users/dev",
      os: "macos",
      uid: 501,
      viewerPort: 4747,
      isMainHost: true,
      machineLabel: "mac-studio",
      deps,
    });

    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0]?.cmd, "launchctl");
    assert.deepEqual(execCalls[0]?.args, [
      "bootstrap",
      "gui/501",
      `/Users/dev/Library/LaunchAgents/${LAUNCHD_UI_LABEL}.plist`,
    ]);
  });

  it("skips service restart cleanly on worker-only hosts", async () => {
    const { deps, execCalls, logs } = makeMockDeps({
      exists() {
        return false;
      },
    });

    const result = await runUiUpdate({
      flags: parseUiUpdateFlags([]),
      repoRoot: "/repo",
      home: "/Users/worker",
      os: "macos",
      uid: 501,
      viewerPort: 4747,
      isMainHost: false,
      machineLabel: "worker-machine",
      deps,
    });

    assert.equal(result.restarted, false);
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0]?.cmd, "mise");
    assert.ok(logs.some((l) => l.includes('Machine "worker-machine" does not host')));
  });

  it("fails with actionable guidance when Board UI service is not installed on a main host", async () => {
    const { deps } = makeMockDeps({
      exists() {
        return false;
      },
      execCapture() {
        return { ok: false, stdout: "" };
      },
    });

    await assert.rejects(
      () =>
        runUiUpdate({
          flags: parseUiUpdateFlags(["--restart-only"]),
          repoRoot: "/repo",
          home: "/home/agent",
          os: "linux",
          uid: 1000,
          viewerPort: 4747,
          isMainHost: true,
          machineLabel: "main-machine",
          deps,
        }),
      /mise run apply:main/,
    );
  });

  it("supports --dry-run and --no-restart without executing side effects", async () => {
    const { deps, execCalls, logs } = makeMockDeps();

    const dry = await runUiUpdate({
      flags: parseUiUpdateFlags(["--dry-run"]),
      repoRoot: "/repo",
      home: "/home/agent",
      os: "linux",
      uid: 1000,
      viewerPort: 4747,
      isMainHost: true,
      machineLabel: "main-machine",
      env: {},
      deps,
    });

    assert.equal(dry.restarted, false);
    assert.equal(execCalls.length, 0);
    assert.ok(logs.some((l) => l.includes("[dry-run] Would run: mise upgrade")));
    assert.ok(logs.some((l) => l.includes("systemctl --user restart vercel-board-ui.service")));

    const noRestart = await runUiUpdate({
      flags: parseUiUpdateFlags(["--no-restart"]),
      repoRoot: "/repo",
      home: "/home/agent",
      os: "linux",
      uid: 1000,
      viewerPort: 4747,
      isMainHost: true,
      machineLabel: "main-machine",
      deps,
    });

    assert.equal(noRestart.restarted, false);
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0]?.cmd, "mise");
  });
});
