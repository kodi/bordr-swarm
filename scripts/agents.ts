/**
 * `mise run agents` — list every worker agent profile, whether its CLI is installed on this
 * machine, default model/effort, accepted model IDs (dynamic where the CLI can list them,
 * curated static fallback otherwise), and a ready-to-copy label line per agent.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgentCatalog,
  formatAgentCatalog,
  type CatalogWorkerDefaults,
} from "../src/lib/agent-catalog.ts";
import { BUILTIN_AGENT_PROFILES, loadSwarmConfig } from "../src/lib/config.ts";
import { WorkerDefaultsConfigSchema } from "../src/lib/schemas.ts";

export interface AgentsCliOptions {
  help: boolean;
  json: boolean;
  discover: boolean;
  agent?: string;
  maxModels: number;
  timeoutMs: number;
}

const DEFAULT_MAX_MODELS = 25;

export function parseAgentsCliArgs(argv: string[]): AgentsCliOptions {
  const opts: AgentsCliOptions = {
    help: false,
    json: false,
    discover: true,
    maxModels: DEFAULT_MAX_MODELS,
    timeoutMs: 20_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === "--help" || flag === "-h") opts.help = true;
    else if (flag === "--json") opts.json = true;
    else if (flag === "--static") opts.discover = false;
    else if (flag === "--all-models") opts.maxModels = 0;
    else if ((flag === "--agent" || flag === "-a") && argv[i + 1]) {
      opts.agent = argv[i + 1]!;
      i += 1;
    } else if (flag.startsWith("--agent=")) opts.agent = flag.slice("--agent=".length);
    else if (flag.startsWith("--timeout=")) {
      const secs = Number(flag.slice("--timeout=".length));
      if (!Number.isFinite(secs) || secs <= 0) throw new Error(`Invalid ${flag}`);
      opts.timeoutMs = secs * 1000;
    } else if (!flag.startsWith("-") && !opts.agent) opts.agent = flag;
    else throw new Error(`Unknown argument "${flag}". Run with --help for usage.`);
  }
  return opts;
}

const HELP = `Usage: mise run agents [-- [agent] [options]]

List supported worker agents, install status, default model/effort, accepted
model IDs for model=/reviewer_model= labels, and example label lines.

Options:
  -a, --agent <name>  Only show one agent profile (claude, agy, codex, pi, or custom)
  --json              Machine-readable JSON output (always includes every model)
  --static            Skip dynamic CLI discovery; show curated static lists only
  --all-models        Do not truncate model lists in text output (default: ${DEFAULT_MAX_MODELS})
  --timeout=<secs>    Per-CLI discovery timeout (default 20)
  -h, --help          Show this help
`;

function loadWorkerDefaults(repoRoot: string): {
  workerDefaults: CatalogWorkerDefaults;
  source: string;
} {
  const configPath = process.env.SWARM_CONFIG_PATH ?? resolve(repoRoot, "config/swarm.json");
  if (existsSync(configPath)) {
    return {
      workerDefaults: loadSwarmConfig(repoRoot, configPath).workerDefaults,
      source: configPath,
    };
  }
  return {
    workerDefaults: WorkerDefaultsConfigSchema.parse({}),
    source: "built-in defaults (config/swarm.json not found)",
  };
}

function main(): void {
  let opts: AgentsCliOptions;
  try {
    opts = parseAgentsCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { workerDefaults, source } = loadWorkerDefaults(repoRoot);
  const catalog = buildAgentCatalog({
    workerDefaults,
    configSource: source,
    builtinProfiles: BUILTIN_AGENT_PROFILES,
    discover: opts.discover,
    timeoutMs: opts.timeoutMs,
    only: opts.agent,
  });

  if (opts.json) {
    console.log(JSON.stringify(catalog, null, 2));
  } else {
    console.log(formatAgentCatalog(catalog, { maxModels: opts.maxModels }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
