import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parseAgentsCliArgs } from "../scripts/agents.ts";
import {
  buildAgentCatalog,
  buildExampleLabels,
  formatAgentCatalog,
  parseAgyModelList,
  parseCodexModelCatalog,
  parsePiModelList,
  shouldUseColor,
  type CommandRunner,
} from "../src/lib/agent-catalog.ts";
import { BUILTIN_AGENT_PROFILES } from "../src/lib/config.ts";
import { WorkerDefaultsConfigSchema } from "../src/lib/schemas.ts";

const PI_OUTPUT = `provider      model                 context  max-out  thinking  images
anthropic     claude-opus-5-5       1M       128K     yes       yes
google        gemini-3.5-flash      1.0M     65.5K    yes       yes
openai-codex  gpt-5.4               400K     128K     no        yes
`;

const CODEX_OUTPUT = JSON.stringify({
  models: [
    {
      slug: "gpt-6.2-sol",
      display_name: "GPT-6.2-Sol",
      visibility: "list",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
    },
    { slug: "internal-review", visibility: "hide" },
    { slug: "gpt-5.5", visibility: "list" },
  ],
});

const AGY_OUTPUT = `Fetching available models...
gemini-4-neon-high\tGemini 4 Neon (High)
claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)
`;

function fakeRunner(responses: Record<string, { ok: boolean; stdout?: string; error?: string }>): {
  run: CommandRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const run: CommandRunner = (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    const r = responses[key];
    if (!r) return { ok: false, stdout: "", error: "not found" };
    return { ok: r.ok, stdout: r.stdout ?? "", error: r.error };
  };
  return { run, calls };
}

const defaults = WorkerDefaultsConfigSchema.parse({});

// oxlint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[/;

describe("agent catalog parsers", () => {
  it("parses pi --list-models into provider/model IDs", () => {
    const models = parsePiModelList(PI_OUTPUT);
    assert.deepEqual(
      models.map((m) => m.id),
      ["anthropic/claude-opus-5-5", "google/gemini-3.5-flash", "openai-codex/gpt-5.4"],
    );
    assert.ok(models.every((m) => m.labelSafe));
    assert.equal(models[2]?.description, "no thinking support");
  });

  it("parses codex catalog, skipping hidden models by default", () => {
    const models = parseCodexModelCatalog(CODEX_OUTPUT);
    assert.deepEqual(
      models.map((m) => m.id),
      ["gpt-6.2-sol", "gpt-5.5"],
    );
    assert.deepEqual(models[0]?.efforts, ["low", "high"]);
    assert.equal(parseCodexModelCatalog(CODEX_OUTPUT, true).length, 3);
    assert.throws(() => parseCodexModelCatalog("{}"), /models/);
    assert.throws(() => parseCodexModelCatalog("not json"));
  });

  it("parses agy models and ignores progress lines", () => {
    const models = parseAgyModelList(AGY_OUTPUT);
    assert.deepEqual(
      models.map((m) => m.id),
      ["gemini-4-neon-high", "claude-opus-5-5-medium"],
    );
    assert.equal(models[0]?.description, "Gemini 4 Neon (High)");
  });

  it("builds example label lines", () => {
    assert.equal(
      buildExampleLabels("pi", "openai-codex/gpt-5.4", "high"),
      "--label agent=pi --label model=openai-codex/gpt-5.4 --label effort=high",
    );
    assert.equal(buildExampleLabels("codex", undefined, ""), "--label agent=codex");
  });
});

describe("buildAgentCatalog", () => {
  it("uses dynamic lists for installed CLIs and static fallback otherwise", () => {
    const { run } = fakeRunner({
      "which claude": { ok: true },
      "which pi": { ok: true },
      "which codex": { ok: true },
      "pi --list-models": { ok: true, stdout: PI_OUTPUT },
      "codex debug models": { ok: false, error: "exited with 1: boom" },
      // agy is not installed
    });
    const catalog = buildAgentCatalog({
      workerDefaults: defaults,
      configSource: "test",
      builtinProfiles: BUILTIN_AGENT_PROFILES,
      run,
    });
    const byName = Object.fromEntries(catalog.agents.map((a) => [a.profile, a]));

    assert.equal(byName.claude?.installed, true);
    assert.equal(byName.claude?.isDefault, true);
    assert.equal(byName.claude?.defaultModel, "opus");
    assert.equal(byName.claude?.models.source, "static");
    assert.match(byName.claude?.exampleLabels ?? "", /agent=claude --label model=opus/);

    assert.equal(byName.pi?.models.source, "dynamic");
    assert.equal(byName.pi?.models.models.length, 3);
    assert.deepEqual(byName.pi?.effortLabels, ["low", "medium", "high", "xhigh", "max"]);
    assert.ok(byName.pi?.cliEfforts.includes("minimal"));

    assert.equal(byName.codex?.models.source, "static");
    assert.match(byName.codex?.models.note ?? "", /failed.*boom/);

    assert.equal(byName.agy?.installed, false);
    assert.equal(byName.agy?.models.source, "static");
    assert.match(byName.agy?.models.note ?? "", /not installed/);
    assert.ok((byName.agy?.models.models.length ?? 0) > 0);

    const text = formatAgentCatalog(catalog, { maxModels: 1 });
    assert.match(text, /━━ agy  ❌ NOT INSTALLED/);
    assert.match(text, /━━ claude  ✅ installed  \[default\]/);
    assert.match(text, /4 profiles · 3 installed · 1 missing · default claude/);
    assert.doesNotMatch(text, ANSI_RE);
    assert.match(formatAgentCatalog(catalog, { maxModels: 1, color: true }), ANSI_RE);
    assert.match(text, /dynamic, via `pi --list-models`/);
    assert.match(
      text,
      /… 2 more \(run `mise run agents --agent pi --all-models` for the full list\)/,
    );
  });

  it("falls back when a CLI returns unparseable or empty output", () => {
    const { run } = fakeRunner({
      "which codex": { ok: true },
      "which agy": { ok: true },
      "codex debug models": { ok: true, stdout: "garbage" },
      "agy models": { ok: true, stdout: "Fetching available models...\n" },
    });
    const catalog = buildAgentCatalog({
      workerDefaults: defaults,
      configSource: "test",
      builtinProfiles: BUILTIN_AGENT_PROFILES,
      run,
    });
    const byName = Object.fromEntries(catalog.agents.map((a) => [a.profile, a]));
    assert.match(byName.codex?.models.note ?? "", /Could not parse/);
    assert.match(byName.agy?.models.note ?? "", /returned no models/);
  });

  it("skips discovery with discover=false and supports custom profiles + filtering", () => {
    const { run, calls } = fakeRunner({ "which pi": { ok: true } });
    const workerDefaults = WorkerDefaultsConfigSchema.parse({
      agents: {
        "pi-gpt": {
          kind: "pi",
          model: "openai-codex/gpt-5.4",
          effort: "high",
          permissionMode: "auto",
          extraArgs: [],
        },
      },
    });
    const catalog = buildAgentCatalog({
      workerDefaults,
      configSource: "test",
      builtinProfiles: BUILTIN_AGENT_PROFILES,
      run,
      discover: false,
      only: "pi-gpt",
    });
    assert.equal(catalog.agents.length, 1);
    const entry = catalog.agents[0]!;
    assert.equal(entry.kind, "pi");
    assert.equal(entry.models.source, "static");
    assert.equal(
      entry.exampleLabels,
      "--label agent=pi-gpt --label model=openai-codex/gpt-5.4 --label effort=high",
    );
    assert.ok(!calls.includes("pi --list-models"));

    assert.throws(
      () =>
        buildAgentCatalog({
          workerDefaults,
          configSource: "test",
          builtinProfiles: BUILTIN_AGENT_PROFILES,
          run,
          only: "nope",
        }),
      /Unknown agent profile/,
    );
  });
});

describe("parseAgentsCliArgs", () => {
  it("parses flags", () => {
    const opts = parseAgentsCliArgs(["--json", "--static", "--agent", "pi", "--timeout=5"]);
    assert.equal(opts.json, true);
    assert.equal(opts.discover, false);
    assert.equal(opts.agent, "pi");
    assert.equal(opts.timeoutMs, 5000);
    assert.equal(parseAgentsCliArgs(["codex"]).agent, "codex");
    assert.equal(parseAgentsCliArgs(["--all-models"]).maxModels, 0);
    assert.equal(parseAgentsCliArgs(["--timeout", "7"]).timeoutMs, 7000);
    assert.throws(() => parseAgentsCliArgs(["--timeout"]), /Invalid --timeout/);
    assert.throws(() => parseAgentsCliArgs(["--timeout=abc"]), /Invalid --timeout/);
    assert.throws(() => parseAgentsCliArgs(["--bogus"]), /Unknown argument/);
  });
});

describe("agents CLI color handling", () => {
  it("decides color from FORCE_COLOR, NO_COLOR and TTY", () => {
    assert.equal(shouldUseColor({}, true), true);
    assert.equal(shouldUseColor({}, false), false);
    assert.equal(shouldUseColor({}, undefined), false);
    assert.equal(shouldUseColor({ NO_COLOR: "1" }, true), false);
    assert.equal(shouldUseColor({ NO_COLOR: "" }, true), true);
    assert.equal(shouldUseColor({ FORCE_COLOR: "1" }, false), true);
    assert.equal(shouldUseColor({ FORCE_COLOR: "" }, false), true);
    assert.equal(shouldUseColor({ FORCE_COLOR: "0" }, true), false);
    assert.equal(shouldUseColor({ FORCE_COLOR: "false" }, true), false);
    assert.equal(shouldUseColor({ FORCE_COLOR: "1", NO_COLOR: "1" }, false), true);
  });

  const script = fileURLToPath(new URL("../scripts/agents.ts", import.meta.url));
  const runCli = (args: string[], env: Record<string, string>) => {
    const baseEnv: Record<string, string | undefined> = { ...process.env };
    delete baseEnv.FORCE_COLOR;
    delete baseEnv.NO_COLOR;
    const res = spawnSync(process.execPath, [script, "--static", ...args], {
      encoding: "utf8",
      env: { ...baseEnv, SWARM_CONFIG_PATH: "/nonexistent/swarm.json", ...env },
    });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };

  it("emits no ANSI codes when stdout is not a TTY or NO_COLOR is set", () => {
    const piped = runCli([], {});
    assert.match(piped, /━━ claude/);
    assert.doesNotMatch(piped, ANSI_RE);
    assert.doesNotMatch(runCli([], { NO_COLOR: "1" }), ANSI_RE);
    assert.match(runCli([], { FORCE_COLOR: "1" }), ANSI_RE);
  });

  it("keeps --json free of ANSI codes even with FORCE_COLOR", () => {
    const out = runCli(["--json", "--agent", "claude"], { FORCE_COLOR: "1" });
    assert.doesNotMatch(out, ANSI_RE);
    const parsed = JSON.parse(out) as { defaultAgent: string; agents: { profile: string }[] };
    assert.equal(parsed.agents[0]?.profile, "claude");
  });
});
