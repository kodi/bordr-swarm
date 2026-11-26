/**
 * Agent/model catalog: lists every worker agent profile the swarm supports, whether its
 * CLI is installed, and the exact model IDs usable in `model=` / `reviewer_model=` labels.
 *
 * Model lists are discovered dynamically from each CLI where possible and fall back to a
 * curated static list (marked `source: "static"`) when the CLI is missing or listing fails.
 * All parsing is pure and the command runner is injectable so it can be unit-tested.
 */
import { spawnSync } from "node:child_process";
import { styleText } from "node:util";
import { buildAgentCliArgs, type WorkerAgentProfile } from "./config.ts";

/** Effort values the Dispatcher accepts from the `effort=` / `reviewer_effort=` labels. */
export const SWARM_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Same character set as `LabelStringSchema` values — a model ID must match to be usable as a label. */
const LABEL_VALUE_RE = /^[a-zA-Z0-9_.:/-]+$/;

export type ModelSource = "dynamic" | "static";

export interface CatalogModel {
  id: string;
  description?: string;
  /** Per-model effort levels when the CLI reports them (codex). */
  efforts?: string[];
  /** False when the ID contains characters a Board label value cannot hold. */
  labelSafe: boolean;
}

export interface ModelListing {
  source: ModelSource;
  /** Command used for dynamic discovery (e.g. `pi --list-models`), or null for static-only agents. */
  command: string | null;
  models: CatalogModel[];
  /** Explanation when falling back to the static list or when IDs need special handling. */
  note?: string;
}

export interface AgentCatalogEntry {
  profile: string;
  kind: string;
  installed: boolean;
  isDefault: boolean;
  defaultModel: string;
  defaultEffort: string;
  permissionMode: string;
  /** Effort values the CLI supports natively. */
  cliEfforts: string[];
  /** Effort values usable in `effort=` labels for this agent (CLI ∩ swarm). */
  effortLabels: string[];
  /** Flags the swarm passes for this profile's defaults (from `buildAgentCliArgs`). */
  defaultCliArgs: string[];
  models: ModelListing;
  exampleLabels: string;
}

export interface AgentCatalog {
  defaultAgent: string;
  configSource: string;
  effortLabels: string[];
  agents: AgentCatalogEntry[];
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

export type CommandRunner = (cmd: string, args: string[], timeoutMs: number) => CommandResult;

export const defaultCommandRunner: CommandRunner = (cmd, args, timeoutMs) => {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (res.error) {
    return { ok: false, stdout: res.stdout ?? "", error: res.error.message };
  }
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").trim().split("\n").slice(-1)[0] ?? "";
    return {
      ok: false,
      stdout: res.stdout ?? "",
      error: `exited with ${res.status ?? res.signal}${stderr ? `: ${stderr}` : ""}`,
    };
  }
  return { ok: true, stdout: res.stdout ?? "" };
};

export function commandExists(run: CommandRunner, bin: string): boolean {
  return run("which", [bin], 5_000).ok;
}

function model(id: string, description?: string, efforts?: string[]): CatalogModel {
  const entry: CatalogModel = { id, labelSafe: LABEL_VALUE_RE.test(id) };
  if (description) entry.description = description;
  if (efforts && efforts.length > 0) entry.efforts = efforts;
  return entry;
}

// ---------------------------------------------------------------------------
// Static knowledge per built-in agent kind
// ---------------------------------------------------------------------------

interface KindInfo {
  cliEfforts: string[];
  /** Dynamic discovery command, or null when the CLI has no list command. */
  discover: { cmd: string; args: string[]; parse: (stdout: string) => CatalogModel[] } | null;
  staticModels: CatalogModel[];
  note?: string;
}

const STATIC_CLAUDE_MODELS: CatalogModel[] = [
  model("opus", "Alias for the latest Opus (swarm default)"),
  model("sonnet", "Alias for the latest Sonnet"),
  model("haiku", "Alias for the latest Haiku"),
  model("fable", "Alias for the latest Fable"),
  model("claude-opus-5-5", "Claude Opus 5.5"),
  model("claude-sonnet-5-5", "Claude Sonnet 5.5"),
  model("claude-haiku-5-5", "Claude Haiku 5.5"),
  model("claude-fable-5-2", "Claude Fable 5.2"),
];

const KIND_INFO: Record<string, KindInfo> = {
  claude: {
    cliEfforts: ["low", "medium", "high", "xhigh", "max"],
    discover: null,
    staticModels: STATIC_CLAUDE_MODELS,
    note: "claude has no model list command; curated aliases + full IDs (any full model name is accepted).",
  },
  agy: {
    cliEfforts: ["low", "medium", "high", "xhigh", "max"],
    discover: { cmd: "agy", args: ["models"], parse: parseAgyModelList },
    staticModels: [
      model("gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"),
      model("claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"),
      model("claude-sonnet-5-5-medium", "Claude Sonnet 5.5 (Medium)"),
    ],
    note: "agy model IDs embed a reasoning tier (e.g. -high); the swarm still passes --effort separately.",
  },
  codex: {
    cliEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    discover: { cmd: "codex", args: ["debug", "models"], parse: parseCodexModelCatalog },
    staticModels: [model("gpt-6.2-sol"), model("gpt-6-sol"), model("gpt-5.5")],
  },
  pi: {
    cliEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    discover: { cmd: "pi", args: ["--list-models"], parse: parsePiModelList },
    staticModels: [
      model("anthropic/claude-opus-5-5"),
      model("anthropic/claude-sonnet-5-5"),
      model("google/gemini-3.5-flash"),
    ],
    note: 'pi also accepts fuzzy patterns and a ":<thinking>" suffix (e.g. "sonnet:high").',
  },
};

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

/**
 * Parse `pi --list-models` table output:
 *   provider  model  context  max-out  thinking  images
 * Returns `provider/model` IDs (unambiguous for `--model`).
 */
export function parsePiModelList(stdout: string): CatalogModel[] {
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 2) continue;
    const [provider, id] = cols;
    if (!provider || !id || provider === "provider") continue;
    if (!/^[a-zA-Z0-9_.-]+$/.test(provider)) continue;
    const full = `${provider}/${id}`;
    if (seen.has(full)) continue;
    seen.add(full);
    const thinking = cols[4];
    models.push(model(full, thinking === "no" ? "no thinking support" : undefined));
  }
  return models;
}

/**
 * Parse `codex debug models` JSON catalog. Only models with `visibility: "list"` are
 * returned unless `includeHidden` is set.
 */
export function parseCodexModelCatalog(stdout: string, includeHidden = false): CatalogModel[] {
  const parsed: unknown = JSON.parse(stdout);
  const list =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
      ? ((parsed as { models: unknown[] }).models as unknown[])
      : Array.isArray(parsed)
        ? parsed
        : null;
  if (!list) {
    throw new Error('codex model catalog JSON has no "models" array');
  }
  const models: CatalogModel[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const slug = typeof m.slug === "string" ? m.slug : null;
    if (!slug) continue;
    if (!includeHidden && m.visibility !== undefined && m.visibility !== "list") continue;
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels
          .map((l) => (l && typeof l === "object" ? (l as { effort?: unknown }).effort : undefined))
          .filter((e): e is string => typeof e === "string")
      : undefined;
    const display = typeof m.display_name === "string" ? m.display_name : undefined;
    models.push(model(slug, display, efforts));
  }
  return models;
}

/**
 * Parse `agy models` output: `<id>\t<display name>` per line (ignores progress lines).
 */
export function parseAgyModelList(stdout: string): CatalogModel[] {
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    const id = (tab >= 0 ? line.slice(0, tab) : line).trim();
    if (!id || /\s/.test(id) || id.endsWith("...")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const description = tab >= 0 ? line.slice(tab + 1).trim() : undefined;
    models.push(model(id, description));
  }
  return models;
}

// ---------------------------------------------------------------------------
// Catalog assembly
// ---------------------------------------------------------------------------

export function listModelsForKind(
  kind: string,
  installed: boolean,
  run: CommandRunner,
  opts: { discover: boolean; timeoutMs: number },
): ModelListing {
  const info = KIND_INFO[kind];
  if (!info) {
    return {
      source: "static",
      command: null,
      models: [],
      note: `Custom agent kind "${kind}": no known model catalog; pass any ID the CLI accepts via --model.`,
    };
  }
  const staticListing = (note?: string): ModelListing => {
    const notes = [note, info.note].filter(Boolean).join(" ");
    const listing: ModelListing = {
      source: "static",
      command: info.discover ? `${info.discover.cmd} ${info.discover.args.join(" ")}` : null,
      models: info.staticModels,
    };
    if (notes) listing.note = notes;
    return listing;
  };

  if (!info.discover) return staticListing();
  const command = `${info.discover.cmd} ${info.discover.args.join(" ")}`;
  if (!opts.discover) return staticListing("Discovery skipped (--static); curated fallback list.");
  if (!installed) return staticListing(`${kind} is not installed; curated fallback list.`);

  const res = run(info.discover.cmd, info.discover.args, opts.timeoutMs);
  if (!res.ok) {
    return staticListing(
      `\`${command}\` failed (${res.error ?? "unknown error"}); curated fallback list.`,
    );
  }
  let models: CatalogModel[];
  try {
    models = info.discover.parse(res.stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return staticListing(`Could not parse \`${command}\` output (${msg}); curated fallback list.`);
  }
  if (models.length === 0) {
    return staticListing(`\`${command}\` returned no models; curated fallback list.`);
  }
  const listing: ModelListing = { source: "dynamic", command, models };
  if (info.note) listing.note = info.note;
  return listing;
}

export function buildExampleLabels(
  profile: string,
  modelId: string | undefined,
  effort: string,
): string {
  const parts = [`--label agent=${profile}`];
  if (modelId) parts.push(`--label model=${modelId}`);
  if (effort) parts.push(`--label effort=${effort}`);
  return parts.join(" ");
}

/** Profile as stored in config; `kind` may be omitted when the profile key is the kind. */
export type CatalogAgentProfile = Omit<WorkerAgentProfile, "kind"> & { kind?: string };

export interface CatalogWorkerDefaults {
  defaultAgent: string;
  agents: Record<string, CatalogAgentProfile>;
}

export function buildAgentCatalog(params: {
  workerDefaults: CatalogWorkerDefaults;
  configSource: string;
  builtinProfiles: Record<string, WorkerAgentProfile>;
  run?: CommandRunner;
  discover?: boolean;
  timeoutMs?: number;
  only?: string;
}): AgentCatalog {
  const run = params.run ?? defaultCommandRunner;
  const discover = params.discover ?? true;
  const timeoutMs = params.timeoutMs ?? 20_000;

  const profiles: Record<string, WorkerAgentProfile> = { ...params.builtinProfiles };
  for (const [name, p] of Object.entries(params.workerDefaults.agents)) {
    profiles[name] = { ...p, kind: p.kind ?? name };
  }
  const names = Object.keys(profiles).filter((n) => !params.only || n === params.only);
  if (params.only && names.length === 0) {
    throw new Error(
      `Unknown agent profile "${params.only}". Known profiles: ${Object.keys(profiles).join(", ")}`,
    );
  }

  const installedCache = new Map<string, boolean>();
  const listingCache = new Map<string, ModelListing>();
  const agents: AgentCatalogEntry[] = [];

  for (const name of names) {
    const profile = profiles[name]!;
    const kind = profile.kind.toLowerCase();
    let installed = installedCache.get(kind);
    if (installed === undefined) {
      installed = commandExists(run, profile.kind);
      installedCache.set(kind, installed);
    }
    let models = listingCache.get(kind);
    if (!models) {
      models = listModelsForKind(kind, installed, run, { discover, timeoutMs });
      listingCache.set(kind, models);
    }

    const cliEfforts = KIND_INFO[kind]?.cliEfforts ?? [...SWARM_EFFORT_LEVELS];
    const effortLabels = SWARM_EFFORT_LEVELS.filter((e) => cliEfforts.includes(e));
    const exampleModel = profile.model || models.models.find((m) => m.labelSafe)?.id || undefined;

    agents.push({
      profile: name,
      kind: profile.kind,
      installed,
      isDefault: name === params.workerDefaults.defaultAgent,
      defaultModel: profile.model,
      defaultEffort: profile.effort,
      permissionMode: profile.permissionMode,
      cliEfforts,
      effortLabels,
      defaultCliArgs: buildAgentCliArgs(profile),
      models,
      exampleLabels: buildExampleLabels(name, exampleModel, profile.effort || "medium"),
    });
  }

  return {
    defaultAgent: params.workerDefaults.defaultAgent,
    configSource: params.configSource,
    effortLabels: [...SWARM_EFFORT_LEVELS],
    agents,
  };
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

/** Decide whether to emit ANSI color. `FORCE_COLOR` wins (as in Node), then `NO_COLOR`, then TTY. */
export function shouldUseColor(
  env: Record<string, string | undefined>,
  isTTY: boolean | undefined,
): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force.toLowerCase() !== "false";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return isTTY === true;
}

type StyleFormat = Parameters<typeof styleText>[0];
type Paint = (format: StyleFormat, text: string) => string;

function painter(color: boolean): Paint {
  return color
    ? (format, text) => styleText(format, text, { validateStream: false })
    : (_format, text) => text;
}

export function formatAgentCatalog(
  catalog: AgentCatalog,
  opts: { maxModels?: number; color?: boolean } = {},
): string {
  const maxModels = opts.maxModels ?? 0;
  const c = painter(opts.color ?? false);
  const lines: string[] = [];
  const KEY_WIDTH = 16;
  const row = (key: string, value: string): string =>
    `   ${c("dim", key.padEnd(KEY_WIDTH))} ${value}`;
  const sep = c("dim", " · ");

  const installedCount = catalog.agents.filter((a) => a.installed).length;
  lines.push(
    `${c("bold", "Swarm worker agents")}${sep}${catalog.agents.length} profile${catalog.agents.length === 1 ? "" : "s"}` +
      `${sep}${c("green", `${installedCount} installed`)}` +
      (installedCount < catalog.agents.length
        ? `${sep}${c("red", `${catalog.agents.length - installedCount} missing`)}`
        : "") +
      `${sep}default ${c("bold", catalog.defaultAgent)}`,
  );
  lines.push(row("Config", c("dim", catalog.configSource)));
  lines.push(
    row(
      "Labels",
      `agent= model= effort= reviewer= reviewer_model= reviewer_effort= ${c("dim", "(reviewer_* use the same IDs)")}`,
    ),
  );

  for (const a of catalog.agents) {
    lines.push("");
    const status = a.installed ? c("green", "✅ installed") : c("red", "❌ NOT INSTALLED");
    const kindPart = a.kind !== a.profile ? c("dim", ` (kind: ${a.kind})`) : "";
    const defaultTag = a.isDefault ? `  ${c(["bold", "yellow"], "[default]")}` : "";
    lines.push(`${c(["bold", "cyan"], `━━ ${a.profile}`)}${kindPart}  ${status}${defaultTag}`);
    lines.push(row("Default model", a.defaultModel || c("dim", "(CLI default — --model omitted)")));
    lines.push(row("Default effort", a.defaultEffort || c("dim", "(CLI default)")));
    lines.push(row("Effort labels", a.effortLabels.join(", ")));
    const extra = a.cliEfforts.filter((e) => !a.effortLabels.includes(e));
    if (extra.length > 0) {
      lines.push(
        row("", c("dim", `(CLI also supports ${extra.join(", ")} — not accepted as swarm labels)`)),
      );
    }
    lines.push(row("Swarm CLI flags", a.defaultCliArgs.join(" ") || c("dim", "(none)")));

    const src =
      a.models.source === "dynamic"
        ? `dynamic, via \`${a.models.command}\``
        : "static fallback list";
    lines.push(
      row("Models", `${c("bold", String(a.models.models.length))} ${c("dim", `(${src})`)}`),
    );
    if (a.models.note) lines.push(`     ${c(["dim", "italic"], `note: ${a.models.note}`)}`);
    const shown = maxModels > 0 ? a.models.models.slice(0, maxModels) : a.models.models;
    const width = Math.min(48, Math.max(0, ...shown.map((m) => m.id.length)));
    for (const m of shown) {
      const details = [
        m.description ? c("dim", m.description) : "",
        m.efforts ? c("dim", `efforts: ${m.efforts.join("/")}`) : "",
        m.labelSafe ? "" : c("red", "NOT label-safe"),
      ]
        .filter(Boolean)
        .join(sep);
      lines.push(`     ${m.id.padEnd(width)}${details ? `  ${details}` : ""}`.trimEnd());
    }
    if (shown.length < a.models.models.length) {
      lines.push(
        `     ${c("dim", `… ${a.models.models.length - shown.length} more (run \`mise run agents --agent ${a.profile} --all-models\` for the full list)`)}`,
      );
    }
    lines.push(
      `   👉 ${c("cyan", `vercel board tasks create <channel> "<title>" ${a.exampleLabels}`)}`,
    );
  }
  return lines.join("\n");
}
