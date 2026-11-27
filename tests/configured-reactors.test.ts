import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseBoardTailLine, type SwarmEvent } from "../src/bus/events.ts";
import { executeEffects, ReactorRegistry } from "../src/bus/reactor.ts";
import { parseSwarmConfig } from "../src/lib/config.ts";
import { ConfiguredReactorSchema, type ConfiguredReactor } from "../src/lib/schemas.ts";
import {
  CooldownGate,
  createConfiguredEffectHandlers,
  createConfiguredReactor,
  createConfiguredReactors,
  defaultCommandRunner,
  renderTemplate,
  validateConfiguredReactors,
  type CommandRunner,
} from "../src/reactors/configured.ts";

function tail(obj: Record<string, unknown>): SwarmEvent {
  const res = parseBoardTailLine(JSON.stringify({ cursor: "c", payload: {}, ...obj }));
  assert.equal(res.kind, "event");
  return (res as { event: SwarmEvent }).event;
}

const blockedTask = (channel = "projects/app", labels: Record<string, string> = {}) =>
  tail({
    type: "task.blocked",
    message: {
      id: "msg_task_1",
      channel,
      text: "Need the API key",
      labels,
      task: { state: "blocked", claim: null },
    },
  });

const reactor = (raw: Record<string, unknown>): ConfiguredReactor =>
  ConfiguredReactorSchema.parse({ name: "notify", on: "task.blocked", ...raw });

describe("configured reactor schema", () => {
  it("applies defaults and accepts both run shapes", () => {
    const cmd = reactor({ run: { command: ["/usr/bin/true"] } });
    assert.equal(cmd.runOn, "lead");
    assert.equal(cmd.enabled, true);
    assert.equal(cmd.cooldownSeconds, 30);
    assert.deepEqual(cmd.run, { command: ["/usr/bin/true"], timeoutSeconds: 30 });
    const post = reactor({
      on: ["task.*", "message.posted"],
      run: { post: { channel: "inbox", text: "hi" } },
    });
    assert.deepEqual(post.on, ["task.*", "message.posted"]);
  });

  it("rejects unknown selectors, bad names, shell strings, and duplicate names", () => {
    assert.throws(() => reactor({ on: "task.exploded", run: { command: ["x"] } }));
    assert.throws(() => reactor({ name: "Bad Name", run: { command: ["x"] } }));
    assert.throws(() => reactor({ run: { command: "rm -rf /" } }));
    assert.throws(() => reactor({ run: { command: ["x"] }, extra: true }));
    assert.throws(
      () =>
        parseSwarmConfig({
          machines: { m: { role: "worker" } },
          reactors: [
            { name: "a", on: "task.blocked", run: { command: ["x"] } },
            { name: "a", on: "task.failed", run: { command: ["y"] } },
          ],
        }),
      /Duplicate reactor name "a"/,
    );
    const ok = parseSwarmConfig({
      machines: { m: { role: "worker" } },
      reactors: [{ name: "a", on: "task.blocked", run: { command: ["x"] } }],
    });
    assert.equal(ok.reactors?.length, 1);
  });
});

describe("configured reactor matching and effects", () => {
  it("matches selector, channel prefix, and labels", () => {
    const r = createConfiguredReactor(
      reactor({
        match: { channel: "projects/", labels: { review: "skip" } },
        run: { command: ["x"] },
      }),
    );
    assert.equal(r.matches(blockedTask("projects/app", { review: "skip" })), true);
    assert.equal(r.matches(blockedTask("projects/app")), false, "label missing");
    assert.equal(r.matches(blockedTask("inbox", { review: "skip" })), false, "channel");
    assert.equal(
      r.matches(
        tail({
          type: "task.failed",
          message: { id: "t", channel: "projects/a", text: "", labels: { review: "skip" } },
        }),
      ),
      false,
    );
    const wildcard = createConfiguredReactor(reactor({ on: "task.*", run: { command: ["x"] } }));
    assert.equal(
      wildcard.matches(
        tail({ type: "task.claimed", message: { id: "t", channel: "p", text: "" } }),
      ),
      true,
    );
    assert.equal(wildcard.matches({ kind: "herdr.tab_closed", tabId: "t" }), false);
    const disabled = createConfiguredReactor(reactor({ enabled: false, run: { command: ["x"] } }));
    assert.equal(disabled.matches(blockedTask()), false);
  });

  it("passes the event as JSON on stdin and never puts event data in argv", () => {
    const r = createConfiguredReactor(
      reactor({ run: { command: ["notify-send", "--urgent"], timeoutSeconds: 5 } }),
    );
    const [effect] = r.react(blockedTask(), {});
    assert.equal(effect?.type, "run_command");
    if (effect?.type !== "run_command") return;
    assert.deepEqual(effect.command, ["notify-send", "--urgent"]);
    assert.equal(effect.timeoutMs, 5_000);
    const parsed = JSON.parse(effect.stdin) as { kind: string; task: { id: string } };
    assert.equal(parsed.kind, "board.task");
    assert.equal(parsed.task.id, "msg_task_1");
  });

  it("renders post placeholders from the event; channel comes from config", () => {
    const r = createConfiguredReactor(
      reactor({
        run: {
          post: { channel: "#ops", text: "Blocked {id} in #{channel} ({state}): {text} {unknown}" },
        },
      }),
    );
    const [effect] = r.react(blockedTask(), {});
    assert.deepEqual(effect, {
      type: "post",
      channel: "ops",
      text: "Blocked msg_task_1 in #projects/app (blocked): Need the API key {unknown}",
      asProfile: "reactor-notify",
      cooldownMs: 30_000,
    });
    assert.equal(renderTemplate("{a}{b}", { a: "1" }), "1{b}");
  });

  it("filters by runOn", () => {
    const configs = [
      reactor({ name: "l", run: { command: ["x"] } }),
      reactor({ name: "d", runOn: "dispatcher", run: { command: ["x"] } }),
      reactor({ name: "off", enabled: false, run: { command: ["x"] } }),
    ];
    assert.deepEqual(
      createConfiguredReactors(configs, "lead").map((r) => r.name),
      ["config:l"],
    );
    assert.deepEqual(
      createConfiguredReactors(configs, "dispatcher").map((r) => r.name),
      ["config:d"],
    );
  });
});

describe("loop prevention", () => {
  it("a post reactor never fires on its own posts and is rate limited by its cooldown", async () => {
    // "When anything is posted in #ops, post in #ops" would loop forever without the guards.
    const cfg = reactor({
      name: "echo",
      on: "message.posted",
      match: { channel: "ops" },
      cooldownSeconds: 60,
      run: { post: { channel: "ops", text: "echo {text}" } },
    });
    const registry = new ReactorRegistry([createConfiguredReactor(cfg)]);
    let clock = 0;
    const posts: Array<{ channel: string; text: string; as: string }> = [];
    const handlers = createConfiguredEffectHandlers({
      board: {
        postMessage: async (channel, text, opts) => {
          posts.push({ channel, text, as: opts.asProfile });
          return `msg_echo_${posts.length}`;
        },
      },
      log: () => {},
      cooldown: new CooldownGate(() => clock),
    });

    const human = tail({
      type: "message.posted",
      message: { id: "h1", channel: "ops", text: "deploy?", by: { profile: null } },
    });
    await executeEffects(registry.collect(human, {}), handlers, () => {});
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.as, "reactor-echo");

    // Its own post comes back through the tail: ignored.
    const own = tail({
      type: "message.posted",
      message: {
        id: "msg_echo_1",
        channel: "ops",
        text: "echo deploy?",
        by: { profile: "reactor-echo" },
      },
    });
    assert.deepEqual(registry.collect(own, {}), []);

    // Another human post inside the cooldown: skipped; after it: runs.
    clock = 30_000;
    await executeEffects(registry.collect(human, {}), handlers, () => {});
    assert.equal(posts.length, 1);
    clock = 61_000;
    await executeEffects(registry.collect(human, {}), handlers, () => {});
    assert.equal(posts.length, 2);
  });
});

describe("command execution", () => {
  it("runs through the injected runner, logs failures, and honours dry-run", async () => {
    const calls: Array<{ argv: readonly string[]; stdin: string }> = [];
    const runner: CommandRunner = async (argv, opts) => {
      calls.push({ argv, stdin: opts.stdin });
      return { code: argv[0] === "fail" ? 3 : 0, stdout: "", stderr: "bad thing", timedOut: false };
    };
    const logs: string[] = [];
    const handlers = createConfiguredEffectHandlers({
      board: { postMessage: async () => "" },
      log: (_l, m) => logs.push(m),
      runner,
    });
    const effect = (cmd: string) => ({
      reactor: `config:${cmd}`,
      effect: {
        type: "run_command" as const,
        command: [cmd],
        timeoutMs: 1_000,
        stdin: "{}\n",
        cooldownMs: 0,
      },
    });
    await executeEffects([effect("ok"), effect("fail")], handlers, () => {});
    assert.deepEqual(
      calls.map((c) => c.argv[0]),
      ["ok", "fail"],
    );
    assert.match(logs.join("\n"), /"fail" exited 3: bad thing/);

    const dry = createConfiguredEffectHandlers({
      board: { postMessage: async () => assert.fail("no post in dry-run") },
      log: (_l, m) => logs.push(m),
      runner: async () => assert.fail("no command in dry-run"),
      dryRun: true,
    });
    await executeEffects([effect("x")], dry, () => {});
    assert.match(logs.at(-1) ?? "", /\[dry-run\]/);
  });

  it("the default runner appends the event to a file via stdin (no shell)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "reactor-cmd-"));
    try {
      const script = join(tmp, "append.sh");
      const out = join(tmp, "events.log");
      writeFileSync(script, `#!/bin/sh\ncat >> "$1"\n`);
      chmodSync(script, 0o755);
      const res = await defaultCommandRunner([script, out], {
        stdin: '{"kind":"board.task"}\n',
        timeoutMs: 5_000,
      });
      assert.equal(res.code, 0);
      assert.equal(readFileSync(out, "utf8"), '{"kind":"board.task"}\n');

      const slow = join(tmp, "slow.sh");
      writeFileSync(slow, "#!/bin/sh\nsleep 5\n");
      chmodSync(slow, 0o755);
      const timed = await defaultCommandRunner([slow], { stdin: "", timeoutMs: 100 });
      assert.equal(timed.timedOut, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("validateConfiguredReactors (doctor)", () => {
  it("reports missing commands and unreachable dispatcher channels", () => {
    const res = validateConfiguredReactors(
      [
        reactor({ name: "a", run: { command: ["definitely-not-a-real-binary-xyz"] } }),
        reactor({
          name: "b",
          runOn: "dispatcher",
          match: { channel: "inbox" },
          run: { command: ["/bin/sh"] },
        }),
        reactor({ name: "c", cooldownSeconds: 0, run: { post: { channel: "ops", text: "x" } } }),
      ],
      { projectChannelPrefix: "projects/", env: { PATH: "/bin:/usr/bin" } },
    );
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0]!, /definitely-not-a-real-binary-xyz/);
    assert.equal(res.warnings.length, 2);
    assert.equal(res.summary.length, 3);

    const disabled = validateConfiguredReactors(
      [
        reactor({
          name: "off",
          enabled: false,
          run: { command: ["definitely-not-a-real-binary-xyz"] },
        }),
      ],
      { projectChannelPrefix: "projects/", env: { PATH: "/bin" } },
    );
    assert.deepEqual(disabled.errors, [], "a disabled reactor's command is not required");
  });
});
