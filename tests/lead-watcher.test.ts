import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LeadWatcher } from "../src/lead-watcher.ts";
import { BoardClient, type ExecRunner } from "../src/lib/board.ts";
import type { SwarmConfig } from "../src/lib/config.ts";
import { HerdrClient, sanitizeHerdrAgentName, type HerdrAgentStatus } from "../src/lib/herdr.ts";
import {
  buildLeadWakePrompt,
  collectLeadEvents,
  createEmptyLeadState,
  enqueueLeadEvents,
  mentionsProfile,
  type LeadWakeEvent,
} from "../src/lib/lead-events.ts";
import {
  buildLeadAgentName,
  formatLeadTabLabel,
  isLeadSessionParked,
  stepLeadSession,
  type LeadSession,
} from "../src/lib/lead-fsm.ts";

function makeSwarm(leadOverrides: Partial<SwarmConfig["lead"]> = {}): SwarmConfig {
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
      maxConcurrentSessions: 1,
      idleCloseSeconds: 15,
      maxParkedTabs: 4,
      ...leadOverrides,
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

  it("preserves clean agent name when rawId is omitted and builds per-thread names", () => {
    assert.equal(sanitizeHerdrAgentName("lead"), "lead");
    assert.equal(sanitizeHerdrAgentName("lead", ""), "lead");
    assert.equal(
      buildLeadAgentName("lead", "msg_70b6fb31-6aea-4982-9f47-3c75ca272c90_1"),
      "lead-70b6fb31",
    );
    assert.equal(formatLeadTabLabel("msg_70b6fb31-6aea-4982-9f47-3c75ca272c90_1"), "lead-70b6fb31");
    assert.equal(
      formatLeadTabLabel("msg_70b6fb31-6aea-4982-9f47-3c75ca272c90_1", "BLOCKED"),
      "[BLOCKED] lead-70b6fb31",
    );
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

    // Grouping & deduplication by threadId
    const queued = enqueueLeadEvents({}, [...first.events, first.events[0]!]);
    assert.equal(queued.msg_1?.length, 1);
    assert.equal(queued.msg_3?.length, 1);
    assert.equal(queued["42"]?.length, 1);

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

function makePromptSentSession(overrides: Partial<LeadSession> = {}): LeadSession {
  return {
    threadId: "msg_aaa11111_1",
    agentName: "lead-aaa11111",
    tabId: "w1:t1",
    paneId: "w1:p1",
    startedAtMs: 1_000,
    phase: { kind: "prompt_sent", promptedAtMs: 1_000 },
    ...overrides,
  };
}

describe("stepLeadSession pure ephemeral FSM", () => {
  const sampleEvent: LeadWakeEvent = {
    kind: "inbox",
    channel: "inbox",
    threadId: "msg_aaa11111_1",
    latestMessageId: "msg_aaa11111_2",
    author: "owner",
    preview: "Also use Postgres",
  };

  it("transitions prompt_sent -> working -> idle_grace -> remove after idleCloseMs", () => {
    let s = makePromptSentSession();

    // Observes working -> transitions to working
    let out = stepLeadSession(s, {
      tabExists: true,
      agentStatus: "working",
      pendingEventsForThread: [],
      nowMs: 5_000,
      startupGraceMs: 20_000,
      idleCloseMs: 15_000,
    });
    assert.equal(out.status, "active");
    s = out.next;
    assert.equal(out.effects.length, 0);
    assert.equal(s.phase.kind, "working");

    // Transitions to idle at t=10s -> enters idle_grace(10_000), does not close yet
    out = stepLeadSession(s, {
      tabExists: true,
      agentStatus: "idle",
      pendingEventsForThread: [],
      nowMs: 10_000,
      startupGraceMs: 20_000,
      idleCloseMs: 15_000,
    });
    assert.equal(out.status, "active");
    s = out.next;
    assert.deepEqual(s.phase, { kind: "idle_grace", sinceMs: 10_000 });
    assert.equal(out.effects.length, 0);

    // Still idle at t=20s (10s < 15s) -> still open
    out = stepLeadSession(s, {
      tabExists: true,
      agentStatus: "idle",
      pendingEventsForThread: [],
      nowMs: 20_000,
      startupGraceMs: 20_000,
      idleCloseMs: 15_000,
    });
    assert.equal(out.status, "active");
    s = out.next;
    assert.equal(out.effects.length, 0);

    // Still idle at t=25s (15s >= 15s) -> closes tab and removes session!
    out = stepLeadSession(s, {
      tabExists: true,
      agentStatus: "idle",
      pendingEventsForThread: [],
      nowMs: 25_000,
      startupGraceMs: 20_000,
      idleCloseMs: 15_000,
    });
    assert.equal(out.status, "remove");
    assert.ok(out.effects.some((e) => e.type === "close_tab" && e.tabId === "w1:t1"));
  });

  it("delivers rapid same-thread follow-up during idle_grace instead of closing", () => {
    const s = makePromptSentSession({
      phase: { kind: "idle_grace", sinceMs: 10_000 },
    });

    const out = stepLeadSession(s, {
      tabExists: true,
      agentStatus: "idle",
      pendingEventsForThread: [sampleEvent],
      nowMs: 26_000,
      startupGraceMs: 20_000,
      idleCloseMs: 15_000,
    });

    assert.equal(out.status, "active");
    assert.deepEqual(out.next.phase, { kind: "prompt_sent", promptedAtMs: 26_000 });
    assert.ok(
      out.effects.some(
        (e) =>
          e.type === "deliver_prompt" && e.agentName === "lead-aaa11111" && e.events.length === 1,
      ),
    );
    assert.equal(
      out.effects.some((e) => e.type === "close_tab"),
      false,
    );
  });

  it("parks mid-turn blocked tab as ui_blocked ([BLOCKED]) and unparks/closes once resolved", () => {
    const s = makePromptSentSession({ phase: { kind: "working" } });

    const blocked = stepLeadSession(s, {
      tabExists: true,
      agentStatus: "blocked",
      pendingEventsForThread: [],
      nowMs: 5_000,
      startupGraceMs: 20_000,
      idleCloseMs: 15_000,
    });
    assert.equal(blocked.status, "active");
    assert.equal(blocked.next.phase.kind, "ui_blocked");
    assert.equal(isLeadSessionParked(blocked.next), true);
    assert.ok(
      blocked.effects.some((e) => e.type === "rename_tab" && e.label === "[BLOCKED] lead-aaa11111"),
    );

    // Human approves in Sheprd and Lead finishes -> idle_grace
    const unblocked = stepLeadSession(blocked.next, {
      tabExists: true,
      agentStatus: "idle",
      pendingEventsForThread: [],
      nowMs: 15_000,
      startupGraceMs: 20_000,
      idleCloseMs: 15_000,
    });
    assert.equal(unblocked.status, "active");
    assert.deepEqual(unblocked.next.phase, { kind: "idle_grace", sinceMs: 15_000 });
    assert.equal(isLeadSessionParked(unblocked.next), false);
    assert.ok(
      unblocked.effects.some((e) => e.type === "rename_tab" && e.label === "lead-aaa11111"),
    );

    // After idleCloseMs -> auto-closes!
    const closed = stepLeadSession(unblocked.next, {
      tabExists: true,
      agentStatus: "idle",
      pendingEventsForThread: [],
      nowMs: 30_000,
      startupGraceMs: 20_000,
      idleCloseMs: 15_000,
    });
    assert.equal(closed.status, "remove");
    assert.ok(closed.effects.some((e) => e.type === "close_tab"));
  });

  it("clears queued events if user manually closes a startup_blocked tab", () => {
    const s = makePromptSentSession({
      phase: { kind: "startup_blocked" },
    });

    const out = stepLeadSession(s, {
      tabExists: false,
      agentStatus: null,
      pendingEventsForThread: [sampleEvent],
      nowMs: 5_000,
      startupGraceMs: 20_000,
      idleCloseMs: 15_000,
    });
    assert.equal(out.status, "remove");
    assert.ok(
      out.effects.some((e) => e.type === "clear_queued_events" && e.threadId === "msg_aaa11111_1"),
    );
  });

  it("parks as [FAILED] if agent process crashes unexpectedly past startup grace", () => {
    const s = makePromptSentSession({ startedAtMs: 1_000 });

    const out = stepLeadSession(s, {
      tabExists: true,
      agentStatus: null,
      pendingEventsForThread: [],
      nowMs: 30_000,
      startupGraceMs: 20_000,
      idleCloseMs: 15_000,
    });
    assert.equal(out.status, "active");
    assert.equal(out.next.phase.kind, "failed");
    assert.equal(isLeadSessionParked(out.next), true);
    assert.ok(
      out.effects.some((e) => e.type === "rename_tab" && e.label === "[FAILED] lead-aaa11111"),
    );
  });
});

interface MockHerdrTabState {
  tabId: string;
  paneId: string;
  label: string;
  agentName: string | null;
  status: HerdrAgentStatus;
  closed: boolean;
}

function createMockHerdr(opts: { blockNextStart?: boolean } = {}) {
  let nextTabNum = 1;
  let blockNextStart = opts.blockNextStart ?? false;
  const tabs = new Map<string, MockHerdrTabState>();
  const prompted: Array<{ agentName: string; prompt: string }> = [];
  const closedTabs: string[] = [];
  const renamedTabs: Array<{ tabId: string; label: string }> = [];

  const runner: ExecRunner = async (_cmd, args) => {
    if (args[0] === "workspace" && args[1] === "list") {
      return {
        stdout: JSON.stringify({
          result: { workspaces: [{ workspace_id: "wHQ", label: "swarm-hq" }] },
        }),
        stderr: "",
      };
    }
    if (args[0] === "tab" && args[1] === "create") {
      const labelIdx = args.indexOf("--label");
      const label = labelIdx >= 0 ? (args[labelIdx + 1] ?? "lead") : "lead";
      const n = nextTabNum++;
      const tabId = `wHQ:t${n}`;
      const paneId = `wHQ:p${n}`;
      tabs.set(tabId, { tabId, paneId, label, agentName: null, status: "idle", closed: false });
      return {
        stdout: JSON.stringify({
          result: {
            tab: { tab_id: tabId, workspace_id: "wHQ", label },
            root_pane: { pane_id: paneId },
          },
        }),
        stderr: "",
      };
    }
    if (args[0] === "tab" && args[1] === "list") {
      const activeTabs = [...tabs.values()]
        .filter((t) => !t.closed)
        .map((t) => ({ tab_id: t.tabId, workspace_id: "wHQ", label: t.label }));
      return { stdout: JSON.stringify({ result: { tabs: activeTabs } }), stderr: "" };
    }
    if (args[0] === "tab" && args[1] === "rename") {
      const tabId = args[2]!;
      const label = args[3]!;
      const tab = tabs.get(tabId);
      if (tab) tab.label = label;
      renamedTabs.push({ tabId, label });
      return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
    }
    if (args[0] === "tab" && args[1] === "close") {
      const tabId = args[2]!;
      const tab = tabs.get(tabId);
      if (tab) tab.closed = true;
      closedTabs.push(tabId);
      return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "list") {
      const activeAgents = [...tabs.values()]
        .filter((t) => !t.closed && t.agentName)
        .map((t) => ({
          name: t.agentName!,
          pane_id: t.paneId,
          tab_id: t.tabId,
          workspace_id: "wHQ",
          agent_status: t.status,
        }));
      return { stdout: JSON.stringify({ result: { agents: activeAgents } }), stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "get") {
      const name = args[2]!;
      const tab = [...tabs.values()].find((t) => !t.closed && t.agentName === name);
      if (!tab) {
        throw new Error(`agent "${name}" not found`);
      }
      return {
        stdout: JSON.stringify({
          result: {
            agent: {
              name: tab.agentName,
              pane_id: tab.paneId,
              tab_id: tab.tabId,
              agent_status: tab.status,
            },
          },
        }),
        stderr: "",
      };
    }
    if (args[0] === "agent" && args[1] === "start") {
      const agentName = args[2]!;
      const paneIdx = args.indexOf("--pane");
      const paneId = paneIdx >= 0 ? args[paneIdx + 1]! : "";
      const tab = [...tabs.values()].find((t) => t.paneId === paneId);
      if (tab) {
        tab.agentName = agentName;
        if (blockNextStart) {
          blockNextStart = false;
          tab.status = "blocked";
          throw new Error("agent_not_ready: blocked waiting for confirmation");
        }
        tab.status = "idle";
      }
      return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
    }
    if (args[0] === "agent" && args[1] === "prompt") {
      const agentName = args[2]!;
      const prompt = args[3] ?? "";
      prompted.push({ agentName, prompt });
      const tab = [...tabs.values()].find((t) => !t.closed && t.agentName === agentName);
      if (tab) tab.status = "working";
      return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
    }
    return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
  };

  return {
    herdr: new HerdrClient({ target: "local" }, runner),
    tabs,
    prompted,
    closedTabs,
    renamedTabs,
    setAgentStatus(agentName: string, status: HerdrAgentStatus) {
      const tab = [...tabs.values()].find((t) => !t.closed && t.agentName === agentName);
      if (tab) tab.status = status;
    },
  };
}

const mockTwoBlockedInboxBoardRunner: ExecRunner = async (_cmd, args) => {
  if (args[1] === "read" && args[2] === "inbox") {
    return {
      stdout: JSON.stringify({
        threads: [
          {
            message: {
              id: "msg_ccc33333_1",
              text: "Thread one",
              by: { profile: null },
              author: { handle: "owner" },
            },
            replies: 0,
            last: null,
          },
          {
            message: {
              id: "msg_ddd44444_1",
              text: "Thread two",
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

describe("LeadWatcher ephemeral per-thread sessions", () => {
  it("serializes two inbox threads, handles same-thread follow-up in warm tab, and auto-closes tabs when idle", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lead-watcher-ephemeral-"));
    try {
      const statePath = join(tmp, "state.json");
      let clockMs = 1_000;
      let inboxThreads = [
        {
          message: {
            id: "msg_aaa11111_1",
            text: "Build status badge",
            by: { profile: null },
            author: { handle: "owner" },
          },
          replies: 0,
          last: null as Record<string, unknown> | null,
        },
        {
          message: {
            id: "msg_bbb22222_1",
            text: "Fix login redirect",
            by: { profile: null },
            author: { handle: "owner" },
          },
          replies: 0,
          last: null as Record<string, unknown> | null,
        },
      ];

      const boardRunner: ExecRunner = async (_cmd, args) => {
        if (args[1] === "read" && args[2] === "inbox") {
          return { stdout: JSON.stringify({ threads: inboxThreads, cursor: "c1" }), stderr: "" };
        }
        if (args[1] === "channels") {
          return { stdout: JSON.stringify({ channels: [] }), stderr: "" };
        }
        if (args[1] === "tasks") {
          return { stdout: JSON.stringify({ tasks: [] }), stderr: "" };
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      };

      const mock = createMockHerdr();
      const watcher = new LeadWatcher({
        swarm: makeSwarm({ maxConcurrentSessions: 1, idleCloseSeconds: 15 }),
        board: new BoardClient({}, boardRunner),
        herdr: mock.herdr,
        statePath,
        leadWorkspaceDir: tmp,
        dryRun: false,
        now: () => clockMs,
      });

      // Tick 1: Both threads arrive -> only Thread A spawns (maxConcurrentSessions=1); Thread B stays queued on disk
      await watcher.tick();
      assert.equal(mock.prompted.length, 1);
      assert.equal(mock.prompted[0]?.agentName, "lead-aaa11111");
      assert.match(mock.prompted[0]?.prompt ?? "", /msg_aaa11111_1/);
      const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
        pendingByThread: Record<string, unknown[]>;
      };
      assert.equal(persisted.pendingByThread.msg_aaa11111_1, undefined);
      assert.equal(persisted.pendingByThread.msg_bbb22222_1?.length, 1);

      // Tick 2 (t=10s): Thread A is still working AND user posts a rapid follow-up on Thread A
      clockMs = 10_000;
      inboxThreads[0] = {
        ...inboxThreads[0]!,
        replies: 1,
        last: {
          id: "msg_aaa11111_r1",
          text: "Actually make it blue",
          by: { profile: null },
          author: { handle: "owner" },
        },
      };
      await watcher.tick();
      // Still only 1 session; follow-up is queued while lead-aaa11111 is working
      assert.equal(mock.prompted.length, 1);
      assert.equal(watcher.getTrackedSessions().size, 1);

      // Tick 3 (t=20s): Thread A finishes first turn -> becomes idle -> rapid follow-up delivered to SAME warm tab!
      clockMs = 20_000;
      mock.setAgentStatus("lead-aaa11111", "idle");
      await watcher.tick();
      assert.equal(mock.prompted.length, 2);
      assert.equal(mock.prompted[1]?.agentName, "lead-aaa11111");
      assert.match(mock.prompted[1]?.prompt ?? "", /Actually make it blue/);
      assert.equal(mock.closedTabs.length, 0);

      // Tick 4 (t=30s): Thread A works then finishes -> becomes idle at t=30s (starts idle close grace)
      clockMs = 30_000;
      mock.setAgentStatus("lead-aaa11111", "idle");
      await watcher.tick();
      assert.equal(mock.closedTabs.length, 0);

      // Tick 5 (t=46s): Idle for 16s >= 15s -> Thread A auto-closes AND Thread B spawns fresh isolated session!
      clockMs = 46_000;
      await watcher.tick();
      assert.deepEqual(mock.closedTabs, ["wHQ:t1"]);
      assert.equal(mock.prompted.length, 3);
      assert.equal(mock.prompted[2]?.agentName, "lead-bbb22222");
      assert.match(mock.prompted[2]?.prompt ?? "", /msg_bbb22222_1/);

      // Tick 6 (t=55s): Thread B works -> idle -> auto-closes at t=71s
      clockMs = 55_000;
      mock.setAgentStatus("lead-bbb22222", "idle");
      await watcher.tick();
      assert.equal(mock.closedTabs.length, 1);

      clockMs = 71_000;
      await watcher.tick();
      assert.deepEqual(mock.closedTabs, ["wHQ:t1", "wHQ:t2"]);
      assert.equal(watcher.getTrackedSessions().size, 0);

      // Tick 7: Quiet -> 0 prompts, 0 tabs
      clockMs = 81_000;
      await watcher.tick();
      assert.equal(mock.prompted.length, 3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("parks startup-blocked Lead tab as [BLOCKED] without stalling other threads and delivers prompt once unblocked", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lead-watcher-blocked-"));
    try {
      const statePath = join(tmp, "state.json");
      let clockMs = 1_000;

      // First spawn hits startup folder-trust prompt (blocked); second spawn succeeds!
      const mock = createMockHerdr({ blockNextStart: true });
      const watcher = new LeadWatcher({
        swarm: makeSwarm({ maxConcurrentSessions: 1, idleCloseSeconds: 10 }),
        board: new BoardClient({}, mockTwoBlockedInboxBoardRunner),
        herdr: mock.herdr,
        statePath,
        leadWorkspaceDir: tmp,
        dryRun: false,
        now: () => clockMs,
      });

      // Tick 1: Thread 1 blocks on startup -> parked as [BLOCKED], freeing slot so Thread 2 spawns right away!
      await watcher.tick();
      assert.ok(
        mock.renamedTabs.some((r) => r.tabId === "wHQ:t1" && r.label === "[BLOCKED] lead-ccc33333"),
      );
      assert.equal(mock.prompted.length, 1);
      assert.equal(mock.prompted[0]?.agentName, "lead-ddd44444");

      // Tick 2: User approves startup prompt on Thread 1 -> strips [BLOCKED] and delivers queued Thread 1 event!
      clockMs = 12_000;
      mock.setAgentStatus("lead-ccc33333", "idle");
      mock.setAgentStatus("lead-ddd44444", "idle");
      await watcher.tick();
      assert.ok(mock.renamedTabs.some((r) => r.tabId === "wHQ:t1" && r.label === "lead-ccc33333"));
      assert.equal(mock.prompted.length, 2);
      assert.equal(mock.prompted[1]?.agentName, "lead-ccc33333");
      assert.match(mock.prompted[1]?.prompt ?? "", /msg_ccc33333_1/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
