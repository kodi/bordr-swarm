import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBoardTailLine, type SwarmEvent } from "../src/bus/events.ts";
import {
  executeEffects,
  ReactorRegistry,
  type CollectedEffect,
  type Reactor,
} from "../src/bus/reactor.ts";
import {
  createDispatcherWakeReactor,
  createProjectsReloadReactor,
} from "../src/reactors/dispatcher-wake.ts";
import {
  createBuiltinLeadReactors,
  createInboxAckReactor,
  createLeadSessionWakeReactor,
  createLeadWakeReactor,
  createRegistrySyncReactor,
} from "../src/reactors/lead.ts";

const LEAD_CFG = {
  inboxChannel: "inbox",
  projectChannelPrefix: "projects/",
  registryChannel: "swarm/registry",
  leadProfile: "lead",
};

function tail(obj: Record<string, unknown>): SwarmEvent {
  const res = parseBoardTailLine(JSON.stringify({ cursor: "c", payload: {}, ...obj }));
  assert.equal(res.kind, "event");
  return (res as { event: SwarmEvent }).event;
}

const post = (message: Record<string, unknown>): SwarmEvent =>
  tail({ type: "message.posted", message: { text: "", ...message } });

const humanInbox = (id: string, extra: Record<string, unknown> = {}) =>
  post({
    id,
    channel: "inbox",
    text: "hi",
    author: { kind: "person" },
    by: { profile: null },
    ...extra,
  });

const blocked = (channel: string) =>
  tail({
    type: "task.blocked",
    message: { id: "msg_b_1", channel, text: "Need key", task: { state: "blocked" } },
  });

describe("lead-wake reactor", () => {
  const r = createLeadWakeReactor(LEAD_CFG);

  it("matches inbox and project posts and blocked tasks only", () => {
    assert.equal(r.matches(humanInbox("m1")), true);
    assert.equal(r.matches(post({ id: "m2", channel: "projects/a" })), true);
    assert.equal(r.matches(post({ id: "m3", channel: "random" })), false);
    assert.equal(r.matches(blocked("projects/a")), true);
    assert.equal(r.matches({ kind: "herdr.tab_closed", tabId: "t" }), false);
  });

  it("emits inbox, mention, and blocked-task wake events", () => {
    assert.deepEqual(
      r
        .react(humanInbox("msg_x_2", { re: "msg_x_1", text: "follow-up" }), {})
        .map((e) =>
          e.type === "lead_event"
            ? [e.event.kind, e.event.threadId, e.event.latestMessageId]
            : null,
        ),
      [["inbox", "msg_x_1", "msg_x_2"]],
    );
    assert.equal(r.react(post({ id: "m", channel: "projects/a", text: "no ping" }), {}).length, 0);
    const mention = r.react(post({ id: "m", channel: "projects/a", text: "@lead help" }), {});
    assert.equal(mention[0]?.type === "lead_event" && mention[0].event.kind, "mention");
    const own = post({ id: "m", channel: "inbox", text: "@lead", by: { profile: "lead" } });
    assert.deepEqual(r.react(own, {}), []);
    const blockedFx = r.react(blocked("projects/a"), {});
    assert.equal(blockedFx[0]?.type === "lead_event" && blockedFx[0].event.kind, "blocked_task");
    assert.deepEqual(r.react(blocked("scratch/x"), {}), []);
  });
});

describe("inbox-ack reactor", () => {
  const r = createInboxAckReactor(LEAD_CFG);
  it("reacts 👀 only on human #inbox posts not yet acknowledged", () => {
    assert.deepEqual(r.react(humanInbox("msg_h_1"), {}), [
      { type: "react", messageId: "msg_h_1", emoji: "eyes", threadId: "msg_h_1" },
    ]);
    const agentPost = post({
      id: "a",
      channel: "inbox",
      author: { kind: "agent" },
      by: { profile: "w" },
    });
    assert.deepEqual(r.react(agentPost, {}), []);
    const acked = humanInbox("msg_h_2", { reactions: { eyes: ["vercel:user:u+lead"] } });
    assert.deepEqual(r.react(acked, {}), []);
    assert.equal(r.matches(post({ id: "p", channel: "projects/a" })), false);
  });
});

describe("registry-sync reactor", () => {
  const r = createRegistrySyncReactor(LEAD_CFG);
  it("fires on posts and edits in the registry channel", () => {
    const edit = tail({ type: "message.edited", message: { id: "r1", channel: "swarm/registry" } });
    assert.equal(r.matches(edit), true);
    assert.deepEqual(r.react(edit, {}), [{ type: "registry_sync" }]);
    assert.equal(r.matches(humanInbox("m")), false);
  });
});

describe("lead-session-wake reactor", () => {
  const r = createLeadSessionWakeReactor();
  const ctx = { sessionPaneIds: new Set(["wHQ:p1"]), sessionTabIds: new Set(["wHQ:t1"]) };
  it("wakes only for Lead's own panes and tabs", () => {
    const status = {
      kind: "herdr.agent_status",
      paneId: "wHQ:p1",
      status: "idle",
      agent: null,
    } as const;
    assert.deepEqual(r.react(status, ctx), [{ type: "wake", reason: "herdr.agent_status" }]);
    assert.deepEqual(r.react({ ...status, paneId: "w2:p9" }, ctx), []);
    assert.equal(r.react({ kind: "herdr.tab_closed", tabId: "wHQ:t1" }, ctx).length, 1);
    assert.equal(r.matches(humanInbox("m")), false);
  });
});

describe("dispatcher-wake and projects-reload reactors", () => {
  const wake = createDispatcherWakeReactor({ projectChannelPrefix: "projects/" });
  const ctx = {
    trackedTaskIds: new Set<string>(),
    trackedPaneIds: new Set<string>(),
    trackedTabIds: new Set<string>(),
  };
  it("wakes for claimable work and stays quiet otherwise", () => {
    const ready = tail({
      type: "task.created",
      message: { id: "msg_r_1", channel: "projects/a", text: "", task: { state: "ready" } },
    });
    assert.deepEqual(wake.react(ready, ctx), [{ type: "wake", reason: "board.task" }]);
    assert.deepEqual(wake.react(humanInbox("m"), ctx), []);
    assert.equal(wake.matches({ kind: "fs.changed", path: "/x" }), false);
  });

  it("projects-reload fires only for the configured projects.json", () => {
    const reload = createProjectsReloadReactor({ projectsConfigPath: "/cfg/projects.json" });
    assert.equal(reload.matches({ kind: "fs.changed", path: "/cfg/projects.json" }), true);
    assert.equal(reload.matches({ kind: "fs.changed", path: "/cfg/other.json" }), false);
    assert.deepEqual(reload.react({ kind: "fs.changed", path: "/cfg/projects.json" }, {}), [
      { type: "projects_reload" },
    ]);
    assert.equal(
      createProjectsReloadReactor({ projectsConfigPath: null }).matches({
        kind: "fs.changed",
        path: "/a",
      }),
      false,
    );
  });
});

describe("ReactorRegistry and executor", () => {
  it("lists built-in Lead reactors with 👀 first", () => {
    const reg = new ReactorRegistry(createBuiltinLeadReactors(LEAD_CFG));
    assert.deepEqual(reg.names, ["inbox-ack", "lead-wake", "registry-sync", "lead-session-wake"]);
    const fx = reg.collect(humanInbox("msg_q_1"), {
      sessionPaneIds: new Set(),
      sessionTabIds: new Set(),
    });
    assert.deepEqual(
      fx.map((f) => `${f.reactor}:${f.effect.type}`),
      ["inbox-ack:react", "lead-wake:lead_event"],
    );
  });

  it("isolates a throwing reactor and rejects duplicate names", () => {
    const logs: string[] = [];
    const boom: Reactor = {
      name: "boom",
      matches: () => true,
      react: () => {
        throw new Error("kaput");
      },
    };
    const fine: Reactor = {
      name: "fine",
      matches: () => true,
      react: () => [{ type: "registry_sync" }],
    };
    const reg = new ReactorRegistry([boom, fine], (_l, m) => logs.push(m));
    assert.deepEqual(reg.collect({ kind: "timer.reconcile" }, {}), [
      { reactor: "fine", effect: { type: "registry_sync" } },
    ]);
    assert.match(logs[0] ?? "", /Reactor "boom" failed/);
    assert.throws(() => new ReactorRegistry([fine, fine]), /Duplicate reactor name/);
  });

  it("runs handlers per effect type, isolating failures and logging unsupported effects", async () => {
    const logs: string[] = [];
    const ran: string[] = [];
    const effects: CollectedEffect[] = [
      { reactor: "a", effect: { type: "wake", reason: "x" } },
      { reactor: "b", effect: { type: "registry_sync" } },
      { reactor: "c", effect: { type: "projects_reload" } },
      { reactor: "d", effect: { type: "wake", reason: "y" } },
    ];
    await executeEffects(
      effects,
      {
        wake: (e) => {
          ran.push(e.reason);
        },
        registry_sync: () => {
          throw new Error("nope");
        },
      },
      (_l, m) => logs.push(m),
    );
    assert.deepEqual(ran, ["x", "y"]);
    assert.equal(logs.length, 2);
    assert.match(logs.join("\n"), /"registry_sync" failed/);
    assert.match(logs.join("\n"), /"projects_reload" effect this daemon does not run/);
  });
});
