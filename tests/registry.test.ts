import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BoardClient, type ExecRunner } from "../src/lib/board.ts";
import type { ProjectsConfig, SwarmConfig } from "../src/lib/config.ts";
import {
  buildMachineRegistryEntry,
  formatRegistryCardMarkdown,
  mergeRegistryIntoLeadCatalog,
  parseRegistryCardMarkdown,
  publishMachineRegistry,
} from "../src/lib/registry.ts";

function makeSwarm(): SwarmConfig {
  return {
    board: {
      scope: "",
      boardName: "",
      inboxChannel: "inbox",
      projectChannelPrefix: "projects/",
      registryChannel: "swarm/registry",
      humanHandle: "@owner",
      viewerPort: 4747,
      viewerUrl: "http://main-machine:4748",
      leaseDuration: "15m",
      leaseRenewIntervalSeconds: 300,
    },
    lead: {
      machine: "main-machine",
      boardProfile: "lead",
      model: "opus",
      effort: "high",
      permissionMode: "auto",
      workspaceDir: "~/swarm-hq",
      pollIntervalSeconds: 10,
    },
    workerDefaults: {
      defaultAgent: "claude",
      agents: {
        claude: {
          kind: "claude",
          model: "opus",
          effort: "medium",
          permissionMode: "auto",
          extraArgs: [],
        },
        agy: {
          kind: "agy",
          model: "",
          effort: "medium",
          permissionMode: "auto",
          extraArgs: [],
        },
      },
      reviewer: {
        enabled: false,
        agent: "codex",
        model: "",
        maxRounds: 2,
        skipIfNoDiff: true,
      },
      useWorktree: false,
      closeTabOnComplete: true,
      keepTabOnBlockedOrFailed: true,
      maxParkedTabs: 4,
      pollIntervalSeconds: 15,
      idleTimeoutSeconds: 30,
      claimWaitSeconds: 30,
    },
    machines: {
      "main-machine": {
        role: "both",
        os: "linux",
        hostname: "main-machine",
        allowedHosts: [],
        herdrTarget: "local",
        maxWorkers: 1,
        labels: ["machine=main-machine", "os=linux"],
      },
      "worker-machine": {
        role: "worker",
        os: "macos",
        hostname: "worker-machine",
        allowedHosts: [],
        herdrTarget: "local",
        maxWorkers: 2,
        labels: ["machine=worker-machine", "os=macos"],
      },
    },
  };
}

describe("swarm registry channel (#swarm/registry)", () => {
  it("formats, round-trips, and strips private filesystem paths from registry cards", () => {
    const swarm = makeSwarm();
    const projects: ProjectsConfig = {
      projects: {
        "repo-a": {
          defaultMachine: "worker-machine",
          baseBranch: "main",
          useWorktree: false,
          paths: { "worker-machine": "/Users/secret/private/repo-a" },
        },
      },
    };

    const entry = buildMachineRegistryEntry({
      swarm,
      projects,
      machineName: "worker-machine",
      availableAgentKinds: new Set(["claude", "agy"]),
      nowIso: "2026-11-26T12:00:00.000Z",
    });

    const md = formatRegistryCardMarkdown(entry);
    assert.ok(!md.includes("/Users/secret"), "local filesystem paths must never be published");

    const parsed = parseRegistryCardMarkdown(md);
    assert.deepEqual(parsed, entry);
  });

  it("merges multi-machine projects into defaultMachine='any' for Lead catalog", () => {
    const swarm = makeSwarm();
    const workerEntry = buildMachineRegistryEntry({
      swarm,
      projects: {
        projects: {
          "repo-shared": {
            defaultMachine: "worker-machine",
            baseBranch: "main",
            paths: { "worker-machine": "/Users/a/repo-shared" },
          },
          "repo-mac-only": {
            defaultMachine: "worker-machine",
            baseBranch: "develop",
            paths: { "worker-machine": "/Users/a/repo-mac-only" },
          },
        },
      },
      machineName: "worker-machine",
      availableAgentKinds: new Set(["claude", "agy"]),
    });

    const linuxEntry = buildMachineRegistryEntry({
      swarm,
      projects: {
        projects: {
          "repo-shared": {
            defaultMachine: "main-machine",
            baseBranch: "main",
            paths: { "main-machine": "/home/agent/repo-shared" },
          },
        },
      },
      machineName: "main-machine",
      availableAgentKinds: new Set(["claude"]),
    });

    const catalog = mergeRegistryIntoLeadCatalog({ entries: [workerEntry, linuxEntry] });
    assert.equal(catalog.projects["repo-shared"]?.defaultMachine, "any");
    assert.deepEqual(catalog.projects["repo-shared"]?.machines, ["main-machine", "worker-machine"]);
    assert.equal(catalog.projects["repo-mac-only"]?.defaultMachine, "worker-machine");
    assert.deepEqual(catalog.projects["repo-mac-only"]?.machines, ["worker-machine"]);
    assert.deepEqual(catalog.machines["worker-machine"]?.agents, ["agy", "claude"]);
  });

  it("creates, deduplicates unchanged, and edits in-place when machine projects change", async () => {
    const swarm = makeSwarm();
    let storedText = "";
    const calls: string[] = [];

    const runner: ExecRunner = async (_cmd, args) => {
      const sub = args[1];
      calls.push(`${sub}:${args[2] ?? ""}`);
      if (sub === "channels" && args[2] === "create") {
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (sub === "read") {
        return {
          stdout: JSON.stringify({
            threads: storedText
              ? [{ message: { id: "msg_reg_1", text: storedText }, replies: 0, last: null }]
              : [],
            cursor: "c1",
          }),
          stderr: "",
        };
      }
      if (sub === "post") {
        storedText = args[3] ?? "";
        return { stdout: JSON.stringify({ message: { id: "msg_reg_1" } }), stderr: "" };
      }
      if (sub === "edit") {
        storedText = args[3] ?? "";
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    };

    const board = new BoardClient({}, runner);
    const entry1 = buildMachineRegistryEntry({
      swarm,
      projects: {
        projects: {
          "repo-a": {
            defaultMachine: "worker-machine",
            baseBranch: "main",
            paths: { "worker-machine": "/tmp/a" },
          },
        },
      },
      machineName: "worker-machine",
      availableAgentKinds: new Set(["claude"]),
    });

    const res1 = await publishMachineRegistry({
      board,
      registryChannel: "swarm/registry",
      entry: entry1,
    });
    assert.equal(res1.action, "created");

    // Same payload with newer timestamp -> unchanged (no edit call)
    const res2 = await publishMachineRegistry({
      board,
      registryChannel: "swarm/registry",
      entry: { ...entry1, updatedAt: "2026-11-26T12:05:00.000Z" },
    });
    assert.equal(res2.action, "unchanged");

    // Added project -> edited in place!
    const entry2 = buildMachineRegistryEntry({
      swarm,
      projects: {
        projects: {
          "repo-a": {
            defaultMachine: "worker-machine",
            baseBranch: "main",
            paths: { "worker-machine": "/tmp/a" },
          },
          "repo-b": {
            defaultMachine: "worker-machine",
            baseBranch: "main",
            paths: { "worker-machine": "/tmp/b" },
          },
        },
      },
      machineName: "worker-machine",
      availableAgentKinds: new Set(["claude", "agy"]),
    });

    const res3 = await publishMachineRegistry({
      board,
      registryChannel: "swarm/registry",
      entry: entry2,
    });
    assert.equal(res3.action, "updated");
    assert.ok(calls.some((c) => c.startsWith("edit:")));
  });
});
