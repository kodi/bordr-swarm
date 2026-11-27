import { z } from "zod";

/**
 * Duration string accepted by Vercel Board leases (e.g., "30s", "15m", "1h").
 * Returns duration in seconds, or null if invalid.
 */
export function parseDurationToSeconds(duration: string): number | null {
  const match = /^(\d+)(s|m|h)$/.exec(duration.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (unit === "s") return amount;
  if (unit === "m") return amount * 60;
  if (unit === "h") return amount * 3600;
  return null;
}

export const MachineOsSchema = z
  .enum(["linux", "macos"])
  .describe(
    'Host operating system ("linux" uses systemd --user services; "macos" uses launchd LaunchAgents). Automatically adds an `os=<os>` routing label.',
  );

export const MachineRoleSchema = z
  .enum(["main", "worker", "both"])
  .describe(
    'Host role in the swarm: "main" runs the Board Inspector UI and Lead agent; "worker" runs the Worker Dispatcher daemon; "both" runs both on one machine.',
  );

export const EffortLevelSchema = z
  .enum(["", "low", "medium", "high", "xhigh", "max"])
  .describe(
    'Reasoning effort passed to the coding agent CLI (--effort). Use "" to omit the flag and rely on the CLI default.',
  );

export const PermissionModeSchema = z
  .enum(["", "auto", "acceptEdits", "bypassPermissions", "manual", "dontAsk", "plan"])
  .describe(
    'Permission/approval policy for autonomous agents. Recommended: "auto" (maps to `--permission-mode auto` for claude, `--mode auto` for agy, `-c sandbox_workspace_write.network_access=true --approve-for-me` for codex, and `--approve` for pi).',
  );

export const LabelStringSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9_.-]+=[a-zA-Z0-9_.:/-]+$/,
    'Labels must use "key=value" format (e.g. "machine=worker-machine", "os=macos", "agent=agy").',
  )
  .describe('Routing label in "key=value" format used to match Vercel Board task labels.');

export const LeaseDurationSchema = z
  .string()
  .refine((val) => {
    const secs = parseDurationToSeconds(val);
    return secs !== null && secs >= 30 && secs <= 3600;
  }, 'Must be a duration between "30s" and "1h" (Vercel Board lease limits), e.g. "15m".')
  .describe(
    'Vercel Board task claim lease duration ("30s" to "1h", default "15m"). The deterministic dispatcher renews active leases automatically.',
  );

export const WorkerAgentProfileSchema = z
  .object({
    kind: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Herdr agent kind & CLI binary name passed to `herdr agent start --kind <kind>` (e.g. "claude", "agy", "codex", "pi"). Optional when the profile key itself is a built-in kind.',
      ),
    model: z
      .string()
      .default("")
      .describe(
        'Model name, alias, or provider/id pattern passed via `--model` (e.g. "opus" for claude, "openai-codex/..." for pi). Leave empty ("") to omit `--model` and use the CLI\'s own default model (recommended for `agy`, `codex`, and `pi`).',
      ),
    effort: EffortLevelSchema.default("medium"),
    permissionMode: PermissionModeSchema.default("auto"),
    extraArgs: z
      .array(z.string().min(1))
      .default([])
      .describe("Additional raw CLI flags appended after `--` when launching this agent in Herdr."),
  })
  .strict()
  .describe(
    "Configuration profile for a selectable worker agent CLI, routed via task label `agent=<profileKey>`.",
  );

export const ReviewerConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe(
        "Enable automatic code review before completing tasks. Defaults to false when `reviewer` is omitted, or true when a `reviewer` block is explicitly configured.",
      ),
    agent: z
      .string()
      .min(1)
      .default("codex")
      .describe(
        'Reviewer agent profile key from `workerDefaults.agents` (e.g. "codex", "pi", "claude", "agy", or a custom profile).',
      ),
    model: z
      .string()
      .default("")
      .describe(
        'Optional model override for the reviewer (e.g. "openai-codex/gpt-5.4" for pi, "opus" for claude). Leave empty ("") to inherit the profile\'s default model.',
      ),
    effort: EffortLevelSchema.optional().describe(
      'Optional reasoning effort override for the reviewer (e.g. "high"). Omit to inherit the profile\'s default effort.',
    ),
    maxRounds: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2)
      .describe(
        "Maximum review/fix rounds before escalating the task to `blocked` for human or Lead inspection (default 2).",
      ),
    skipIfNoDiff: z
      .boolean()
      .default(true)
      .describe(
        "When true, automatically skips review if the task produced no local Git changes (e.g. research or Q&A tasks).",
      ),
  })
  .strict()
  .describe(
    "Default code-review gate configuration for workers on this machine. Can be overridden per project in `config/projects.json`.",
  );

export const ProjectReviewerOverrideSchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe(
        "Enable or disable automated code review for this project. Defaults to true when a project `reviewer` override block is specified without `enabled: false`.",
      ),
    agent: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Per-project reviewer agent profile override (e.g. "pi", "codex", "claude", "agy", or a custom profile key).',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Per-project reviewer model override (use "" to inherit the chosen agent profile\'s default model).',
      ),
    effort: EffortLevelSchema.optional().describe(
      "Per-project reviewer reasoning effort override.",
    ),
    maxRounds: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("Per-project maximum review/fix rounds override."),
    skipIfNoDiff: z
      .boolean()
      .optional()
      .describe("Per-project override for skipping review when there are no Git changes."),
  })
  .strict()
  .describe(
    "Optional per-project reviewer override. Omitted fields inherit `workerDefaults.reviewer` from `config/swarm.json`.",
  );

export const BoardConfigSchema = z
  .object({
    url: z
      .string()
      .optional()
      .describe(
        "Optional self-hosted or custom Board URL passed via `--url` / `BOARD_URL` (overridden by `BOARD_URL` env var). When set, `--scope` is omitted.",
      ),
    scope: z
      .string()
      .default("")
      .describe(
        'Optional Vercel team slug passed as `--scope` (or overridden by VERCEL_SCOPE env var). Leave empty ("") to use the default team from `vercel login`.',
      ),
    boardName: z
      .string()
      .default("")
      .describe(
        'Optional named board within the Vercel team (`--name`, or VERCEL_BOARD_NAME env var). Leave empty ("") to use the team\'s default board.',
      ),
    inboxChannel: z
      .string()
      .min(1)
      .default("inbox")
      .describe(
        'Board channel where humans post raw requests for the Lead agent to triage (without leading "#").',
      ),
    projectChannelPrefix: z
      .string()
      .min(1)
      .default("projects/")
      .transform((val) => (val.endsWith("/") ? val : `${val}/`))
      .describe(
        'Channel path prefix for project task queues (e.g. "projects/" matches `#projects/<slug>`). Trailing slash is normalized automatically.',
      ),
    registryChannel: z
      .string()
      .min(1)
      .default("swarm/registry")
      .describe(
        'Board channel where worker machines auto-publish their capabilities and local project slugs (without leading "#"). Lead Watcher syncs this channel into ~/swarm-hq/projects.json automatically.',
      ),
    humanHandle: z
      .string()
      .min(1)
      .default("@owner")
      .describe(
        'Human operator mention handle injected into Lead and Worker prompts for escalations (e.g. "@alice"). Find yours via `vercel board whoami --json` (field `handle`).',
      ),
    viewerPort: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(4747)
      .describe("Localhost port for `board inspect` (from @vercel/board) on the main machine."),
    viewerUrl: z
      .string()
      .url()
      .default("http://127.0.0.1:4747")
      .describe(
        "Client-facing URL where humans and Sheprd open the Board Inspector UI (defaults to local http://127.0.0.1:4747; set to your Tailscale HTTPS URL on a remote main machine).",
      ),
    leaseDuration: LeaseDurationSchema.default("15m"),
    leaseRenewIntervalSeconds: z
      .number()
      .int()
      .min(15)
      .max(3500)
      .default(300)
      .describe(
        "How often (in seconds) the dispatcher renews active task leases. Must be shorter than `leaseDuration`.",
      ),
  })
  .strict()
  .superRefine((board, ctx) => {
    const leaseSecs = parseDurationToSeconds(board.leaseDuration);
    if (leaseSecs !== null && board.leaseRenewIntervalSeconds >= leaseSecs) {
      ctx.addIssue({
        code: "custom",
        path: ["leaseRenewIntervalSeconds"],
        message: `leaseRenewIntervalSeconds (${board.leaseRenewIntervalSeconds}s) must be less than leaseDuration (${board.leaseDuration} = ${leaseSecs}s) so leases renew before expiring.`,
      });
    }
  })
  .describe("Vercel Board connection, channel conventions, UI port, and lease settings.");

export const LeadConfigSchema = z
  .object({
    machine: z
      .string()
      .default("")
      .describe(
        'Optional key in `machines` where the Lead agent and Board Inspector UI run (e.g. "main-machine"). Leave empty ("") to auto-select the machine with role "main" or "both".',
      ),
    boardProfile: z
      .string()
      .min(1)
      .default("lead")
      .describe("Vercel Board profile name (`BOARD_PROFILE`) used by the Lead agent."),
    model: z
      .string()
      .min(1)
      .default("opus")
      .describe('Claude CLI model or alias for the Lead agent (default "opus").'),
    effort: EffortLevelSchema.default("high"),
    permissionMode: PermissionModeSchema.default("auto"),
    workspaceDir: z
      .string()
      .min(1)
      .default("~/swarm-hq")
      .describe(
        "Directory on the main machine where `apply:main` writes rendered `CLAUDE.md` and Lead Watcher syncs `projects.json` from `#swarm/registry`.",
      ),
    pollIntervalSeconds: z
      .number()
      .int()
      .min(3)
      .default(10)
      .describe(
        "Seconds between deterministic Lead Watcher checks for new #inbox messages, @lead mentions, and blocked tasks (0 LLM tokens while idle). With live Board events healthy this is used only while Lead sessions are open (for idle-close timing); otherwise it is the polling fallback.",
      ),
    reconcileIntervalSeconds: z
      .number()
      .int()
      .min(5)
      .optional()
      .describe(
        "Seconds between full Lead Watcher reconciles (channel reads) while the live Board event stream is healthy. Events wake Lead immediately; this is the safety net. Default 60.",
      ),
    maxConcurrentSessions: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(1)
      .describe(
        "Maximum concurrent ephemeral Lead sessions (one isolated session per Board thread). Default 1 serializes threads to avoid cross-thread task-creation races.",
      ),
    idleCloseSeconds: z
      .number()
      .int()
      .min(0)
      .max(3600)
      .default(15)
      .describe(
        "Seconds an ephemeral Lead session must remain idle after its latest prompt before Lead Watcher automatically closes its Herdr tab.",
      ),
    maxParkedTabs: z
      .number()
      .int()
      .min(0)
      .default(4)
      .describe(
        "Maximum parked [BLOCKED]/[FAILED] Lead tabs allowed in Sheprd before pausing new Lead spawns. Set 0 for unlimited.",
      ),
  })
  .strict()
  .describe(
    "Configuration for the ephemeral per-thread Lead triage agent and Lead Watcher daemon.",
  );

export const WorkerDefaultsConfigSchema = z
  .object({
    defaultAgent: z
      .string()
      .min(1)
      .default("claude")
      .describe(
        'Default agent profile key from `agents` used when a task does not specify an `agent=<name>` label (default "claude").',
      ),
    agents: z
      .record(z.string().min(1), WorkerAgentProfileSchema)
      .default({
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
        codex: {
          kind: "codex",
          model: "",
          effort: "medium",
          permissionMode: "auto",
          extraArgs: [],
        },
        pi: {
          kind: "pi",
          model: "",
          effort: "medium",
          permissionMode: "auto",
          extraArgs: [],
        },
      })
      .describe(
        "Map of worker agent profile keys to CLI settings. Tasks can target any key here with `--label agent=<key>` (e.g. `agent=claude`, `agent=agy`, `agent=codex`, `agent=pi`).",
      ),
    reviewer: ReviewerConfigSchema.optional(),
    useWorktree: z
      .boolean()
      .default(false)
      .describe(
        "Default workspace isolation mode. `false` spawns plain Herdr tabs in existing repo checkouts (guarded by a per-repo lock); `true` creates a Git worktree per task via `herdr worktree create`.",
      ),
    closeTabOnComplete: z
      .boolean()
      .default(true)
      .describe(
        "When true, automatically closes a worker's Herdr tab (or removes its temporary worktree) once the Board task becomes `completed` or `canceled`, keeping Sheprd clean.",
      ),
    keepTabOnBlockedOrFailed: z
      .boolean()
      .default(true)
      .describe(
        "When true, leaves `blocked` or `failed` worker tabs open in Sheprd renamed with `[BLOCKED]` or `[FAILED]` for human inspection.",
      ),
    maxParkedTabs: z
      .number()
      .int()
      .min(0)
      .default(4)
      .describe(
        "Maximum number of parked `[BLOCKED]`/`[FAILED]` tabs allowed before the dispatcher pauses claiming new tasks. Set 0 for unlimited.",
      ),
    pollIntervalSeconds: z
      .number()
      .int()
      .min(3)
      .default(15)
      .describe(
        "Seconds between dispatcher reconciliation and task-discovery ticks when live Board/Herdr events are unavailable, and while workers are running (idle reminders and lease renewals are time-based).",
      ),
    reconcileIntervalSeconds: z
      .number()
      .int()
      .min(5)
      .optional()
      .describe(
        "Seconds between full dispatcher reconciles on an idle machine while live Board and Herdr events are healthy (events wake the dispatcher immediately; this is the safety net). Default 60.",
      ),
    idleTimeoutSeconds: z
      .number()
      .int()
      .min(5)
      .default(30)
      .describe(
        "Seconds a worker agent may sit idle while its task is still `claimed` before the dispatcher sends a completion/block reminder (and parks it if still idle after a second window).",
      ),
    startupTimeoutSeconds: z
      .number()
      .int()
      .min(5)
      .default(90)
      .describe(
        "Seconds a newly spawned worker has to reach its first idle/ready state before the dispatcher marks its tab `[BLOCKED]` and posts a terminal excerpt.",
      ),
    worktreeRoot: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional base directory for Dispatcher-managed Git worktrees on Rex machines (defaults to `<repo>/../.swarm-worktrees/<slug>/<shortId>`).",
      ),
    claimWaitSeconds: z
      .number()
      .int()
      .min(5)
      .default(30)
      .describe("Reserved wait window in seconds for blocking claim operations."),
  })
  .strict()
  .describe("Default behavior and selectable agent CLI profiles for ephemeral task workers.");

export const HerdrMachineRuntimeSchema = z
  .object({
    kind: z.literal("herdr"),
    target: z
      .string()
      .min(1)
      .default("local")
      .describe(
        'Herdr target for this dispatcher. Recommended: "local" (local `herdr server` socket) or a saved `herdr machine list` label.',
      ),
  })
  .strict()
  .describe("Run worker agents in Herdr tabs (watched in Sheprd).");

export const RexMachineRuntimeSchema = z
  .object({
    kind: z.literal("rex"),
    binary: z
      .string()
      .min(1)
      .optional()
      .describe('Optional path or executable name for the Rex CLI (defaults to "rex").'),
  })
  .strict()
  .describe("Run worker agents in Rex windows (watched in the Rex app).");

export const MachineRuntimeSchema = z
  .discriminatedUnion("kind", [HerdrMachineRuntimeSchema, RexMachineRuntimeSchema])
  .describe(
    'Terminal runtime hosting worker agents on this machine: `"herdr"` (watched in Sheprd) or `"rex"` (watched in the Rex app). Defaults to `{ "kind": "herdr", "target": "local" }`.',
  );

export const MachineConfigSchema = z
  .object({
    role: MachineRoleSchema.optional(),
    os: MachineOsSchema.optional(),
    hostname: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Actual network/Tailscale hostname used to auto-identify this host and populate `board inspect --allow-host` when `allowedHosts` is omitted.",
      ),
    allowedHosts: z
      .array(z.string().min(1))
      .default([])
      .describe(
        'Hostnames and host:port pairs passed to `board inspect --allow-host` on the main machine when served behind a reverse proxy (e.g. ["main-machine", "main-machine:4748"]). Detected Tailscale MagicDNS is also added automatically.',
      ),
    runtime: MachineRuntimeSchema.optional(),
    herdrTarget: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Legacy back-compat alias for `runtime: { "kind": "herdr", "target": "<value>" }`. Defaults to "local".',
      ),
    maxWorkers: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Maximum concurrent ephemeral worker sessions this machine will claim and run (defaults to 2 for "worker"/"both" roles and 0 for "main").',
      ),
    labels: z
      .array(LabelStringSchema)
      .default([])
      .describe(
        "Additional routing labels matched against task labels. `machine=<key>`, `os=<os>`, and `runtime=<kind>` are added automatically.",
      ),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.runtime && m.herdrTarget !== undefined) {
      if (m.runtime.kind === "rex") {
        ctx.addIssue({
          code: "custom",
          path: ["herdrTarget"],
          message:
            'Cannot set both `runtime: { "kind": "rex" }` and `herdrTarget`; remove `herdrTarget` for Rex machines.',
        });
      } else if (m.runtime.target !== m.herdrTarget) {
        ctx.addIssue({
          code: "custom",
          path: ["herdrTarget"],
          message: `Conflicting runtime.target ("${m.runtime.target}") and legacy herdrTarget ("${m.herdrTarget}").`,
        });
      }
    }
  })
  .describe("Configuration for a single physical or virtual machine in the swarm.");

export const EventsConfigSchema = z
  .object({
    boardTail: z
      .boolean()
      .default(true)
      .describe(
        "Follow `vercel board tail --json` so Board activity wakes the daemons immediately. `false` uses polling only.",
      ),
    herdr: z
      .boolean()
      .default(true)
      .describe(
        'Subscribe to the local Herdr socket for tab, pane, and agent-status events (only for `herdrTarget: "local"`). `false` uses CLI polling only.',
      ),
    rex: z
      .boolean()
      .default(true)
      .describe(
        "Follow `rex events -s <session> --json` on Rex worker machines so agent status changes and exits wake the dispatcher immediately. `false` uses CLI polling only.",
      ),
  })
  .strict()
  .describe(
    "Live event sources. Events are hints that trigger an immediate reconcile; periodic polling remains the safety net.",
  );

/** Event selectors a configured reactor can listen on (`vercel board tail` event types). */
export const REACTOR_EVENT_SELECTORS = [
  "message.posted",
  "message.edited",
  "message.deleted",
  "message.*",
  "reaction.added",
  "reaction.removed",
  "task.created",
  "task.ready",
  "task.claimed",
  "task.completed",
  "task.blocked",
  "task.unblocked",
  "task.failed",
  "task.canceled",
  "task.released",
  "task.expired",
  "task.renewed",
  "task.*",
] as const;

export const ReactorEventSelectorSchema = z
  .enum(REACTOR_EVENT_SELECTORS)
  .describe(
    "Board event type to react to (`message.posted`, `task.blocked`, ...); `message.*` and `task.*` match every message or task event.",
  );

export const ConfiguredReactorSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]{0,39}$/,
        "Reactor names are lowercase letters, digits, and hyphens (max 40), starting with a letter.",
      )
      .describe(
        "Unique reactor name, used in logs and as the default posting profile `reactor-<name>`.",
      ),
    enabled: z
      .boolean()
      .default(true)
      .describe("Set false to keep a reactor configured but inactive."),
    on: z
      .union([ReactorEventSelectorSchema, z.array(ReactorEventSelectorSchema).min(1)])
      .describe("Event selector, or a list of them."),
    runOn: z
      .enum(["lead", "dispatcher"])
      .default("lead")
      .describe(
        '"lead" (default): runs once, in the Lead Watcher on the main machine, which sees the whole board. "dispatcher": runs in every worker dispatcher, which only sees `board.projectChannelPrefix` (use for per-machine local commands).',
      ),
    match: z
      .object({
        channel: z
          .string()
          .min(1)
          .optional()
          .describe('Exact channel (`inbox`) or a prefix ending in "/" (`projects/`).'),
        labels: z
          .record(z.string().min(1), z.string())
          .optional()
          .describe(
            'Labels the event\'s message (or task root) must carry, e.g. `{ "review": "skip" }`.',
          ),
      })
      .strict()
      .optional()
      .describe("Optional filters; every given filter must match."),
    run: z
      .union([
        z
          .object({
            command: z
              .array(z.string().min(1))
              .min(1)
              .describe(
                "Local command as argv (no shell). The event is passed as JSON on stdin; nothing from the event is ever put in the command line.",
              ),
            timeoutSeconds: z.number().int().min(1).max(600).default(30),
          })
          .strict(),
        z
          .object({
            post: z
              .object({
                channel: z.string().min(1).describe("Channel to post in (from config only)."),
                text: z
                  .string()
                  .min(1)
                  .describe(
                    "Message text. Placeholders: {type} {channel} {id} {thread} {author} {state} {text} (event values, text truncated).",
                  ),
                profile: z
                  .string()
                  .min(1)
                  .optional()
                  .describe("Board profile to post as (default `reactor-<name>`)."),
              })
              .strict(),
          })
          .strict(),
      ])
      .describe("What to do: run a local command, or post a message."),
    cooldownSeconds: z
      .number()
      .int()
      .min(0)
      .default(30)
      .describe("Minimum seconds between two runs of this reactor (loop and burst protection)."),
  })
  .strict()
  .describe(
    'A user-defined "when X, do Y" rule. Runs local commands only from this local, gitignored config.',
  );

export const SwarmConfigSchema = z
  .object({
    $schema: z.string().optional().describe("Optional JSON Schema path for editor validation."),
    board: BoardConfigSchema.prefault({}),
    lead: LeadConfigSchema.prefault({}),
    workerDefaults: WorkerDefaultsConfigSchema.prefault({}),
    events: EventsConfigSchema.optional(),
    reactors: z
      .array(ConfiguredReactorSchema)
      .optional()
      .describe('User-defined reactors (for example "when a task blocks, notify me").'),
    machines: z
      .record(z.string().min(1), MachineConfigSchema)
      .refine(
        (m) => Object.keys(m).length > 0,
        "At least one machine must be defined in `machines`.",
      )
      .describe(
        "Map of logical machine keys (at minimum this host; other hosts are discovered automatically via `#swarm/registry`).",
      ),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.lead.machine && !cfg.machines[cfg.lead.machine]) {
      ctx.addIssue({
        code: "custom",
        path: ["lead", "machine"],
        message: `lead.machine "${cfg.lead.machine}" does not exist in machines (${Object.keys(cfg.machines).join(", ")}).`,
      });
    }
    const reactorNames = new Set<string>();
    for (const [i, r] of (cfg.reactors ?? []).entries()) {
      if (reactorNames.has(r.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["reactors", i, "name"],
          message: `Duplicate reactor name "${r.name}".`,
        });
      }
      reactorNames.add(r.name);
    }
    const builtinAgents = new Set(["claude", "agy", "codex", "pi"]);
    if (
      !cfg.workerDefaults.agents[cfg.workerDefaults.defaultAgent] &&
      !builtinAgents.has(cfg.workerDefaults.defaultAgent)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["workerDefaults", "defaultAgent"],
        message: `workerDefaults.defaultAgent "${cfg.workerDefaults.defaultAgent}" is not defined in workerDefaults.agents.`,
      });
    }
    for (const [profileKey, profile] of Object.entries(cfg.workerDefaults.agents)) {
      if (!profile.kind && !builtinAgents.has(profileKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["workerDefaults", "agents", profileKey, "kind"],
          message: `Custom agent profile "${profileKey}" must specify "kind" (e.g. "claude", "agy", "codex", "pi").`,
        });
      }
    }
    if (cfg.workerDefaults.reviewer) {
      const revAgent = cfg.workerDefaults.reviewer.agent;
      if (!cfg.workerDefaults.agents[revAgent] && !builtinAgents.has(revAgent)) {
        ctx.addIssue({
          code: "custom",
          path: ["workerDefaults", "reviewer", "agent"],
          message: `workerDefaults.reviewer.agent "${revAgent}" is not defined in workerDefaults.agents.`,
        });
      }
    }
  })
  .describe(
    "Top-level swarm configuration (generate with `mise run init` or copy `config/swarm.example.json` to gitignored `config/swarm.json`).",
  );

export const GitHubRepoSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/,
    'Must be a GitHub repository in "owner/repo" format (e.g. "kodi/bordr-swarm").',
  )
  .describe(
    'Optional GitHub repository in "owner/repo" format (auto-detected from `origin` remote and advertised in `#swarm/registry` so Lead can inspect it read-only via `gh` when clarifying ambiguous requests).',
  );

export const ProjectConfigSchema = z
  .object({
    defaultMachine: z
      .string()
      .min(1)
      .default("any")
      .describe(
        'Machine key from `swarm.json` that claims tasks for this project when no `machine=<name>` label is specified, or "any".',
      ),
    baseBranch: z
      .string()
      .min(1)
      .default("main")
      .describe("Default Git base branch used when creating task branches or worktrees."),
    repo: GitHubRepoSchema.optional(),
    useWorktree: z
      .boolean()
      .optional()
      .describe(
        "Optional per-project override for `workerDefaults.useWorktree`. Set `true` to allow multiple concurrent workers on this single repo via Git worktrees.",
      ),
    reviewer: ProjectReviewerOverrideSchema.optional(),
    paths: z
      .record(z.string().min(1), z.string().min(1))
      .refine(
        (p) => Object.keys(p).length > 0,
        "Each project must define at least one machine checkout path under `paths`.",
      )
      .describe("Map of machine keys from `swarm.json` to absolute local repository paths."),
  })
  .strict()
  .describe(
    "Repository metadata and per-machine checkout paths for a single `#projects/<slug>` queue.",
  );

export const ProjectsConfigSchema = z
  .object({
    $schema: z.string().optional().describe("Optional JSON Schema path for editor validation."),
    projects: z
      .record(
        z
          .string()
          .regex(
            /^[a-zA-Z0-9._-]+$/,
            "Project slug must contain only letters, numbers, dots, underscores, or hyphens.",
          ),
        ProjectConfigSchema,
      )
      .describe(
        "Registry mapping project slugs (matching `#projects/<slug>` Vercel Board channels) to local paths and defaults.",
      ),
  })
  .strict()
  .describe(
    "Cross-project registry (copy `config/projects.example.json` to gitignored `config/projects.json`).",
  );

// ---------------------------------------------------------------------------
// Vercel Board CLI JSON schemas
// ---------------------------------------------------------------------------

export const BoardTaskStateSchema = z
  .enum(["waiting", "ready", "claimed", "blocked", "completed", "failed", "canceled", "unknown"])
  .describe("Lifecycle state of a Vercel Board task.");

export const BoardRawLabelSchema = z.union([
  z.string(),
  z.object({
    key: z.string().optional(),
    name: z.string().optional(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  }),
]);

export const BoardTaskListEnvelopeSchema = z.union([
  z.array(z.record(z.string(), z.unknown())),
  z
    .object({
      tasks: z.array(z.record(z.string(), z.unknown())),
      cursor: z.union([z.string(), z.number()]).nullable().optional(),
    })
    .passthrough(),
]);

export const BoardChannelListEnvelopeSchema = z
  .object({
    channels: z
      .array(
        z
          .object({
            path: z.string().min(1),
          })
          .passthrough(),
      )
      .default([]),
    next: z.string().nullable().optional(),
  })
  .passthrough();

export const BoardMessageSchema = z
  .object({
    id: z.string().min(1),
    channel: z.string().optional(),
    text: z.string().default(""),
    createdAt: z.string().optional(),
    deleted: z.boolean().optional(),
    re: z
      .string()
      .nullable()
      .optional()
      .catch(undefined)
      .describe("Root message ID when this message is a reply; null/absent for a thread root."),
    thread: z.string().nullable().optional().catch(undefined),
    labels: z.unknown().optional(),
    by: z
      .object({
        actor: z.string().optional(),
        principal: z.string().optional(),
        profile: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    author: z
      .object({
        id: z.string().optional(),
        kind: z.string().optional(),
        handle: z.string().optional(),
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
    reactions: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .catch(undefined)
      .describe("Reactions keyed by emoji name (e.g. `eyes`), each listing reacting actor IDs."),
  })
  .passthrough();

export const BoardThreadSummarySchema = z
  .object({
    message: BoardMessageSchema,
    replies: z.number().int().min(0).default(0),
    last: BoardMessageSchema.nullable().optional(),
  })
  .passthrough();

export const BoardReadChannelEnvelopeSchema = z
  .object({
    threads: z.array(BoardThreadSummarySchema).default([]),
    cursor: z.string().nullable().optional(),
    older: z.string().nullable().optional(),
  })
  .passthrough();

export const BoardReadThreadEnvelopeSchema = z
  .object({
    message: BoardMessageSchema,
    replies: z.array(BoardMessageSchema).default([]),
    cursor: z.string().nullable().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Swarm Registry channel schemas (#swarm/registry)
// ---------------------------------------------------------------------------

export const MachineRegistryProjectSchema = z
  .object({
    slug: z.string().min(1).describe("Project slug matching `#projects/<slug>`."),
    baseBranch: z.string().min(1).default("main").describe("Default base branch for this repo."),
    repo: GitHubRepoSchema.optional(),
    useWorktree: z
      .boolean()
      .optional()
      .describe("Whether this machine uses isolated Git worktrees for this project."),
    reviewer: z
      .string()
      .optional()
      .describe(
        'Optional advertised reviewer profile/model summary for this project (e.g. "codex" or "pi (openai-codex/gpt-5.4)").',
      ),
  })
  .strict();

export const MachineRegistryEntrySchema = z
  .object({
    version: z.literal(1),
    machine: z.string().min(1).describe("Logical machine key from swarm.json."),
    os: MachineOsSchema,
    role: MachineRoleSchema,
    runtime: z
      .enum(["herdr", "rex"])
      .optional()
      .describe('Terminal runtime hosting worker agents on this machine ("herdr" or "rex").'),
    maxWorkers: z.number().int().min(0),
    agents: z
      .array(z.string().min(1))
      .describe(
        "Agent CLI profiles installed and available on this machine (e.g. claude, agy, codex, pi).",
      ),
    labels: z.array(z.string()).describe("Routing labels advertised by this machine."),
    projects: z
      .array(MachineRegistryProjectSchema)
      .describe("Projects checked out locally on this machine (paths stay private on-host)."),
    updatedAt: z.string().min(1),
  })
  .strict()
  .describe("Structured machine capability & project advertisement posted to `#swarm/registry`.");

export const MergedLeadProjectsCatalogSchema = z
  .object({
    source: z.literal("swarm-registry"),
    updatedAt: z.string(),
    machines: z.record(
      z.string(),
      z.object({
        os: MachineOsSchema,
        role: MachineRoleSchema,
        runtime: z.enum(["herdr", "rex"]).optional(),
        maxWorkers: z.number().int().min(0),
        agents: z.array(z.string()),
        labels: z.array(z.string()),
        updatedAt: z.string(),
      }),
    ),
    projects: z.record(
      z.string(),
      z.object({
        defaultMachine: z.string(),
        machines: z.array(z.string()),
        baseBranch: z.string(),
        repo: GitHubRepoSchema.optional(),
      }),
    ),
  })
  .describe(
    "Merged fleet catalog generated automatically by Lead Watcher from `#swarm/registry` for Lead (`~/swarm-hq/projects.json`).",
  );

// ---------------------------------------------------------------------------
// Runtime-neutral agent status & Herdr CLI JSON schemas (verified against herdr 0.9.3)
// ---------------------------------------------------------------------------

export const AgentStatusSchema = z
  .enum(["idle", "working", "blocked", "done", "unknown"])
  .describe(
    'Detected agent lifecycle state: "working" = active turn, "blocked" = approval/question/error prompt visible, "idle"/"done" = ready for input, "unknown" = alive but unclassified.',
  );

/** @deprecated Prefer `AgentStatusSchema`. Kept as an alias for one release. */
export const HerdrAgentStatusSchema = AgentStatusSchema;

export const HerdrWorkspaceSchema = z
  .object({
    workspace_id: z.string().min(1),
    label: z.string(),
    active_tab_id: z.string().optional(),
    agent_status: HerdrAgentStatusSchema.optional(),
    focused: z.boolean().optional(),
    pane_count: z.number().optional(),
    tab_count: z.number().optional(),
  })
  .passthrough();

export const HerdrTabSchema = z
  .object({
    tab_id: z.string().min(1),
    workspace_id: z.string().min(1),
    label: z.string(),
    agent_status: HerdrAgentStatusSchema.optional(),
    focused: z.boolean().optional(),
    pane_count: z.number().optional(),
  })
  .passthrough();

export const HerdrAgentSchema = z
  .object({
    agent: z.string().optional(),
    agent_status: HerdrAgentStatusSchema.catch("unknown"),
    pane_id: z.string().min(1),
    tab_id: z.string().optional(),
    workspace_id: z.string().optional(),
    cwd: z.string().optional(),
    foreground_cwd: z.string().optional(),
    terminal_title: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const HerdrEnvelopeSchema = z
  .object({
    id: z.string().optional(),
    result: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const HerdrWorkspaceListResultSchema = z
  .object({
    workspaces: z.array(HerdrWorkspaceSchema).default([]),
  })
  .passthrough();

export const HerdrTabListResultSchema = z
  .object({
    tabs: z.array(HerdrTabSchema).default([]),
  })
  .passthrough();

export const HerdrAgentListResultSchema = z
  .object({
    agents: z.array(HerdrAgentSchema).default([]),
  })
  .passthrough();

export const HerdrCreatedWorkspaceResultSchema = z
  .object({
    workspace: z
      .object({ workspace_id: z.string().min(1), active_tab_id: z.string().optional() })
      .passthrough(),
    tab: z
      .object({ tab_id: z.string().min(1) })
      .passthrough()
      .optional(),
    root_pane: z
      .object({ pane_id: z.string().min(1) })
      .passthrough()
      .optional(),
    pane: z
      .object({ pane_id: z.string().min(1) })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const HerdrCreatedTabResultSchema = z
  .object({
    tab: z.object({ tab_id: z.string().min(1), workspace_id: z.string().optional() }).passthrough(),
    root_pane: z
      .object({ pane_id: z.string().min(1) })
      .passthrough()
      .optional(),
    pane: z
      .object({ pane_id: z.string().min(1) })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Rex CLI JSON schemas (verified against rex 0.1.0-preview.25)
// ---------------------------------------------------------------------------

export const REX_VERIFIED_VERSION = "0.1.0-preview.25";

export const RexWhoamiSchema = z
  .object({
    account: z.string().optional(),
    endpoint: z.string().optional(),
    pid: z.number().optional(),
    rex_version: z.string().optional(),
    api_revision: z.number().optional(),
    session_count: z.number().optional(),
  })
  .passthrough();

export const RexSessionSchema = z
  .object({
    session_id: z.string().min(1),
    label: z.string(),
  })
  .passthrough();

export const RexSessionListSchema = z
  .object({
    sessions: z.array(RexSessionSchema).default([]),
  })
  .passthrough();

export const RexWindowNewSchema = z
  .object({
    window_id: z.string().min(1),
    block_ids: z.array(z.string().min(1)).default([]),
    revision: z.number().optional(),
  })
  .passthrough();

export const RexNewSessionSchema = z
  .object({
    session_id: z.string().min(1),
    initial_windows: z.array(RexWindowNewSchema).default([]),
  })
  .passthrough();

export const RexBlockSummarySchema = z
  .object({
    block_id: z.string().min(1),
    label: z.string().default(""),
    creator_name: z.string().optional(),
    flavor: z.string().optional(),
    placement: z.string().optional(),
    window_id: z.string().optional(),
  })
  .passthrough();

export const RexWindowLayerSchema = z
  .object({
    layer_id: z.string().optional(),
    blocks: z.array(RexBlockSummarySchema).default([]),
  })
  .passthrough();

export const RexWindowSchema = z
  .object({
    window_id: z.string().min(1),
    label: z.string().default(""),
    focused_block_id: z.string().optional(),
    layers: z.array(RexWindowLayerSchema).default([]),
  })
  .passthrough();

export const RexWindowListSchema = z
  .object({
    session_id: z.string().min(1),
    label: z.string().default(""),
    active_window_id: z.string().optional(),
    windows: z.array(RexWindowSchema).default([]),
  })
  .passthrough();

export const RexBlockListSchema = z
  .object({
    blocks: z.array(RexBlockSummarySchema).default([]),
  })
  .passthrough();

export const RexProgramStatusStateSchema = z
  .enum(["idle", "working", "done", "blocked", "error", "unknown"])
  .catch("unknown");

export const RexProgramStatusRecordSchema = z
  .object({
    id: z.string().optional(),
    state: RexProgramStatusStateSchema,
    kind: z.string().optional().catch(undefined),
    msg: z.string().optional().catch(undefined),
    app: z.string().optional(),
    effective_app: z.string().optional(),
    updated_at: z.string().optional(),
    owner: z
      .object({
        pid: z.number(),
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const RexProgramStatusSchema = z
  .object({
    records: z.array(RexProgramStatusRecordSchema).default([]),
  })
  .passthrough();

export const RexProcessInfoSchema = z
  .object({
    pid: z.number(),
    name: z.string().optional(),
    argv0: z.string().optional(),
    cwd: z.string().optional(),
  })
  .passthrough();

export const RexProcessSchema = z
  .object({
    last_exit: z.unknown().nullable().optional(),
    child: RexProcessInfoSchema.nullable().optional(),
    foreground: RexProcessInfoSchema.nullable().optional(),
    home: z.string().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Worker Dispatcher persisted state (internal; NOT exported to config/*.schema.json)
// Mirrors ActiveTask / ParkedTab in src/lib/task-fsm.ts with Sets stored as arrays.
// ---------------------------------------------------------------------------

const PersistedWorkerRuntimeSchema = z
  .object({
    profileName: z.string(),
    kind: z.string(),
    model: z.string(),
    effort: z.string(),
    permissionMode: z.string(),
    cliArgs: z.array(z.string()),
  })
  .strict();

const PersistedReviewerConfigSchema = z
  .object({
    enabled: z.boolean(),
    required: z.boolean(),
    maxRounds: z.number().int(),
    skipIfNoDiff: z.boolean(),
    runtime: PersistedWorkerRuntimeSchema.nullable(),
  })
  .strict();

const PersistedSessionHandleSchema = z
  .object({
    boardProfile: z.string(),
    runtime: PersistedWorkerRuntimeSchema,
    tabId: z.string(),
    paneId: z.string(),
    agentName: z.string(),
    startedAtMs: z.number(),
  })
  .strict();

const PersistedSessionLifecycleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("awaiting_prompt"),
      promptText: z.string(),
      sinceMs: z.number().optional(),
      uiBlockedNotified: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("running") }).strict(),
  z.object({ kind: z.literal("ui_blocked") }).strict(),
  z.object({ kind: z.literal("idle_grace"), sinceMs: z.number() }).strict(),
  z.object({ kind: z.literal("idle_reminded"), remindedAtMs: z.number() }).strict(),
]);

const PersistedManagedSessionSchema = z
  .object({
    handle: PersistedSessionHandleSchema,
    lifecycle: PersistedSessionLifecycleSchema,
  })
  .strict();

const PersistedTaskContextSchema = z
  .object({
    taskId: z.string().min(1),
    channel: z.string(),
    projectSlug: z.string(),
    repoPath: z.string(),
    baseBranch: z.string(),
    branch: z.string(),
    useWorktree: z.boolean(),
    worktreePath: z.string().optional(),
    runtimeKind: z.enum(["herdr", "rex"]).optional(),
    workspaceId: z.string(),
    boardProfile: z.string(),
    reviewConfig: PersistedReviewerConfigSchema,
    startHeadSha: z.string().nullable(),
    machineName: z.string(),
    humanHandle: z.string(),
  })
  .strict();

const PersistedTaskPhaseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("implementing"), impl: PersistedManagedSessionSchema }).strict(),
  z
    .object({
      kind: z.literal("reviewing"),
      round: z.number().int(),
      impl: PersistedSessionHandleSchema,
      reviewer: PersistedManagedSessionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("fixing"),
      round: z.number().int(),
      impl: PersistedManagedSessionSchema,
    })
    .strict(),
]);

export const PersistedActiveTaskSchema = z
  .object({
    ctx: PersistedTaskContextSchema,
    phase: PersistedTaskPhaseSchema,
    lastLeaseRenewMs: z.number(),
    phaseSeenReplyIds: z.array(z.string()),
    lastImplSummary: z.string(),
  })
  .strict();

export const PersistedParkedTabSchema = z
  .object({
    taskId: z.string().min(1),
    projectSlug: z.string(),
    useWorktree: z.boolean(),
    workspaceId: z.string(),
    tabId: z.string(),
    reason: z.enum(["blocked", "failed"]),
    parkedAtMs: z.number(),
    task: PersistedActiveTaskSchema,
  })
  .strict();

export const PersistedDispatcherStateSchema = z
  .object({
    version: z.literal(1),
    machine: z.string().min(1),
    savedAtMs: z.number(),
    activeWorkers: z.record(z.string(), PersistedActiveTaskSchema),
    parkedTabs: z.record(z.string(), PersistedParkedTabSchema),
  })
  .strict()
  .describe("Worker Dispatcher state persisted across restarts (internal, versioned).");

// ---------------------------------------------------------------------------
// Exported TypeScript types inferred directly from Zod schemas
// ---------------------------------------------------------------------------

export type MachineOs = z.infer<typeof MachineOsSchema>;
export type MachineRole = z.infer<typeof MachineRoleSchema>;
export type EffortLevel = z.infer<typeof EffortLevelSchema>;
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export type RawWorkerAgentProfile = z.infer<typeof WorkerAgentProfileSchema>;
export type RawReviewerConfig = z.infer<typeof ReviewerConfigSchema>;
export type ProjectReviewerOverride = z.infer<typeof ProjectReviewerOverrideSchema>;
export type BoardConfig = z.infer<typeof BoardConfigSchema>;
export type LeadConfig = z.infer<typeof LeadConfigSchema>;
export type RawWorkerDefaultsConfig = z.infer<typeof WorkerDefaultsConfigSchema>;
export type MachineRuntime = z.infer<typeof MachineRuntimeSchema>;
export type RawMachineConfig = z.infer<typeof MachineConfigSchema>;
export type RawSwarmConfig = z.infer<typeof SwarmConfigSchema>;
export type EventsConfig = z.infer<typeof EventsConfigSchema>;
export type ConfiguredReactor = z.infer<typeof ConfiguredReactorSchema>;
export type ReactorEventSelector = z.infer<typeof ReactorEventSelectorSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ProjectsConfig = z.infer<typeof ProjectsConfigSchema>;
export type BoardTaskState = z.infer<typeof BoardTaskStateSchema>;
export type BoardMessage = z.infer<typeof BoardMessageSchema>;
export type BoardThreadSummary = z.infer<typeof BoardThreadSummarySchema>;
export type MachineRegistryProject = z.infer<typeof MachineRegistryProjectSchema>;
export type MachineRegistryEntry = z.infer<typeof MachineRegistryEntrySchema>;
export type MergedLeadProjectsCatalog = z.infer<typeof MergedLeadProjectsCatalogSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type HerdrAgentStatus = AgentStatus;
export type HerdrWorkspace = z.infer<typeof HerdrWorkspaceSchema>;
export type HerdrTab = z.infer<typeof HerdrTabSchema>;
export type HerdrAgent = z.infer<typeof HerdrAgentSchema>;
export type RexWhoami = z.infer<typeof RexWhoamiSchema>;
export type RexSession = z.infer<typeof RexSessionSchema>;
export type RexWindowNew = z.infer<typeof RexWindowNewSchema>;
export type RexNewSession = z.infer<typeof RexNewSessionSchema>;
export type RexBlockSummary = z.infer<typeof RexBlockSummarySchema>;
export type RexWindow = z.infer<typeof RexWindowSchema>;
export type RexWindowList = z.infer<typeof RexWindowListSchema>;
export type RexProgramStatusRecord = z.infer<typeof RexProgramStatusRecordSchema>;
export type RexProgramStatus = z.infer<typeof RexProgramStatusSchema>;
export type RexProcessInfo = z.infer<typeof RexProcessInfoSchema>;
export type RexProcess = z.infer<typeof RexProcessSchema>;
export type PersistedActiveTask = z.infer<typeof PersistedActiveTaskSchema>;
export type PersistedParkedTab = z.infer<typeof PersistedParkedTabSchema>;
export type PersistedDispatcherState = z.infer<typeof PersistedDispatcherStateSchema>;
