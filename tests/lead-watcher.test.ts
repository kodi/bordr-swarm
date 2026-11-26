import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LeadWatcher } from "../src/lead-watcher.ts";
import { BoardClient, type ExecRunner } from "../src/lib/board.ts";
import type { SwarmConfig } from "../src/lib/config.ts";
import { HerdrClient, sanitizeHerdrAgentName } from "../src/lib/herdr.ts";
import {
  buildLeadWakePrompt,
  collectLeadEvents,
  createEmptyLeadState,
  mentionsProfile,
} from "../src/lib/lead-events.ts";

function makeSwarm(): SwarmConfig {
  return {
    board: {
      scope: "",
      boardName: "",
      inboxChannel: "inbox",
      projectChannelPrefix: "projects/",
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
        role: "main",
        os: "linux",
        hostname: "main-machine",
        allowedHosts: [],
        herdrTarget: "local",
        maxWorkers: 0,
        labels: ["machine=main-machine", "os=linux"],
      },
    },
  };
}

describe("lead event detection & deduplication", () => {
  it("matches @lead mentions with word boundaries only", () => {
    assert.equal(mentionsProfile("Hey @lead can you split this?", "lead"), true);
    assert.equal(mentionsProfile("@LEAD please check", "lead"), true);
    assert.equal(mentionsProfile("email me at foo@leader.com", "lead"), false);
  });

  it("preserves clean agent name when rawId is omitted", () => {
    assert.equal(sanitizeHerdrAgentName("lead"), "lead");
    assert.equal(sanitizeHerdrAgentName("lead", ""), "lead");
  });

  it("detects #inbox, @lead mentions, and blocked tasks while ignoring Lead's own replies", () => {
    const first = collectLeadEvents({
      inboxChannel: "inbox",
      inboxThreads: [
        {
          message: {
            id: "msg_1",
            text: "Add dark mode to example-app",
            by: { profile: null },
            author: { handle: "alice" },
          },
          replies: 0,
          last: null,
        },
        {
          message: {
            id: "msg_2",
            text: "Old question",
            by: { profile: null },
            author: { handle: "alice" },
          },
          replies: 1,
          last: {
            id: "msg_2_r1",
            text: "Created task #99",
            by: { profile: "lead" },
          },
        },
      ],
      projectThreadsByChannel: {
        "projects/example-app": [
          {
            message: { id: "msg_3", text: "Worker task", by: { profile: "lead" } },
            replies: 1,
            last: {
              id: "msg_3_r1",
              text: "Hey @lead should we keep backwards compat?",
              by: { profile: "worker-1" },
            },
          },
        ],
      },
      blockedTasks: [
        {
          id: "42",
          channel: "projects/example-app",
          state: "blocked",
          text: "Need API key",
          labels: {},
          raw: {},
        },
      ],
      leadProfile: "lead",
      state: createEmptyLeadState(),
    });

    assert.equal(first.events.length, 3);
    assert.deepEqual(
      first.events.map((e) => e.kind),
      ["inbox", "mention", "blocked_task"],
    );

    const prompt = buildLeadWakePrompt(first.events);
    assert.match(prompt, /\[INBOX\].*msg_1/);
    assert.match(prompt, /\[MENTION\].*msg_3/);
    assert.match(prompt, /\[BLOCKED TASK\].*42/);

    // Second tick with same data emits 0 events (strictly 0 tokens!)
    const second = collectLeadEvents({
      inboxChannel: "inbox",
      inboxThreads: [
        {
          message: {
            id: "msg_1",
            text: "Add dark mode to example-app",
            by: { profile: null },
            author: { handle: "alice" },
          },
          replies: 0,
          last: null,
        },
      ],
      projectThreadsByChannel: {},
      blockedTasks: [
        {
          id: "42",
          channel: "projects/example-app",
          state: "blocked",
          text: "Need API key",
          labels: {},
          raw: {},
        },
      ],
      leadProfile: "lead",
      state: first.nextState,
    });
    assert.equal(second.events.length, 0);
  });
});

describe("LeadWatcher daemon mocked wake flow", () => {
  it("queues events while Lead is blocked/busy and wakes Lead once idle without spending tokens when quiet", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lead-watcher-test-"));
    try {
      const statePath = join(tmp, "state.json");
      let leadStatus: "blocked" | "idle" = "blocked";
      const prompted: string[] = [];

      const boardRunner: ExecRunner = async (_cmd, args) => {
        if (args[1] === "read" && args[2] === "inbox") {
          return {
            stdout: JSON.stringify({
              threads: [
                {
                  message: {
                    id: "msg_inbox_1",
                    text: "Build status badge",
                    by: { profile: null },
                    author: { handle: "owner" },
                  },
                  replies: 0,
                  last: null,
                },
              ],
              cursor: "c1",
            }),
            stderr: "",
          };
        }
        if (args[1] === "channels") {
          return { stdout: JSON.stringify({ channels: [] }), stderr: "" };
        }
        if (args[1] === "tasks") {
          return { stdout: JSON.stringify({ tasks: [] }), stderr: "" };
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      };

      const herdrRunner: ExecRunner = async (_cmd, args) => {
        if (args[0] === "agent" && args[1] === "get") {
          return {
            stdout: JSON.stringify({
              result: {
                agent: {
                  name: "lead",
                  pane_id: "wB:p1",
                  agent_status: leadStatus,
                },
              },
            }),
            stderr: "",
          };
        }
        if (args[0] === "agent" && args[1] === "prompt") {
          prompted.push(args[3] ?? "");
          return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
        }
        return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
      };

      const watcher = new LeadWatcher({
        swarm: makeSwarm(),
        board: new BoardClient({}, boardRunner),
        herdr: new HerdrClient({ target: "local" }, herdrRunner),
        statePath,
        leadWorkspaceDir: tmp,
        dryRun: false,
      });

      // Tick 1: Lead is blocked (e.g. folder trust dialog) -> event queued, not sent yet
      await watcher.tick();
      assert.equal(prompted.length, 0);

      // Tick 2: User trusts folder, Lead becomes idle -> queued event delivered!
      leadStatus = "idle";
      await watcher.tick();
      assert.equal(prompted.length, 1);
      assert.match(prompted[0] ?? "", /msg_inbox_1/);

      // Tick 3: Nothing new -> 0 prompts sent (0 LLM tokens!)
      await watcher.tick();
      assert.equal(prompted.length, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
