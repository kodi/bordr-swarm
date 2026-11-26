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
    'Permission/approval policy for autonomous agents. Recommended: "auto" (maps to `--permission-mode auto` for claude and `--mode auto` for agy). "bypassPermissions" maps to `--dangerously-skip-permissions` on agy.',
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
  .refine(
    (val) => {
      const secs = parseDurationToSeconds(val);
      return secs !== null && secs >= 30 && secs <= 3600;
    },
    'Must be a duration between "30s" and "1h" (Vercel Board lease limits), e.g. "15m".',
  )
  .describe(
    'Vercel Board task claim lease duration ("30s" to "1h", default "15m"). The deterministic dispatcher renews active leases automatically.',
  );

export const WorkerAgentProfileSchema = z
  .object({
    kind: z
      .string()
      .min(1)
      .describe(
        'Herdr agent kind & CLI binary name passed to `herdr agent start --kind <kind>` (e.g. "claude", "agy", "codex", "opencode").',
      ),
    model: z
      .string()
      .default("")
      .describe(
        'Model name or alias passed via `--model` (e.g. "opus" for claude). Leave empty ("") to omit `--model` and use the CLI\'s own default model (recommended for `agy`).',
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

export const BoardConfigSchema = z
  .object({
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
    humanHandle: z
      .string()
      .min(1)
      .default("@owner")
      .describe(
        'Human operator mention handle injected into Lead and Worker prompts for escalations (e.g. "@alice").',
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
      .default("http://main-machine:4748")
      .describe(
        "Client-facing URL (e.g. Tailscale Caddy reverse proxy) where humans and Sheprd open the Board Inspector UI.",
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
      .min(1)
      .describe(
        "Key in `machines` where the Lead agent and Board Inspector UI run (e.g. `main-machine`).",
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
        "Directory on the main machine where `apply-main` writes rendered `CLAUDE.md` and symlinks `projects.json`.",
      ),
  })
  .strict()
  .describe("Configuration for the persistent Lead triage agent on the main machine.");

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
      })
      .describe(
        'Map of worker agent profile keys to CLI settings. Tasks can target any key here with `--label agent=<key>` (e.g. `agent=claude`, `agent=agy`).',
      ),
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
      .describe("Seconds between dispatcher reconciliation and task-discovery ticks."),
    idleTimeoutSeconds: z
      .number()
      .int()
      .min(5)
      .default(30)
      .describe(
        "Seconds a worker agent may sit idle while its task is still `claimed` before the dispatcher sends a completion/block reminder (and parks it if still idle after a second window).",
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

export const MachineConfigSchema = z
  .object({
    role: MachineRoleSchema.optional(),
    os: MachineOsSchema,
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
        'Hostnames and host:port pairs passed to `board inspect --allow-host` on the main machine when served behind a reverse proxy (e.g. ["main-machine", "main-machine:4748"]).',
      ),
    herdrTarget: z
      .string()
      .min(1)
      .default("local")
      .describe(
        'Herdr target for this dispatcher. Recommended: "local" (talks directly to the local `herdr server` socket). Can also be a saved `herdr machine list` label.',
      ),
    maxWorkers: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Maximum concurrent ephemeral worker sessions this machine will claim and run (0 disables claiming, e.g. on a dedicated main machine).",
      ),
    labels: z
      .array(LabelStringSchema)
      .default([])
      .describe(
        'Additional routing labels matched against task labels. `machine=<key>` and `os=<os>` are added automatically.',
      ),
  })
  .strict()
  .describe("Configuration for a single physical or virtual machine in the swarm.");

export const SwarmConfigSchema = z
  .object({
    $schema: z.string().optional().describe("Optional JSON Schema path for editor validation."),
    board: BoardConfigSchema,
    lead: LeadConfigSchema,
    workerDefaults: WorkerDefaultsConfigSchema,
    machines: z
      .record(z.string().min(1), MachineConfigSchema)
      .refine((m) => Object.keys(m).length > 0, "At least one machine must be defined in `machines`.")
      .describe(
        "Map of logical machine keys (e.g. `main-machine`, `worker-machine`, or your real hostnames) to their OS, role, capacity, and labels.",
      ),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (!cfg.machines[cfg.lead.machine]) {
      ctx.addIssue({
        code: "custom",
        path: ["lead", "machine"],
        message: `lead.machine "${cfg.lead.machine}" does not exist in machines (${Object.keys(cfg.machines).join(", ")}).`,
      });
    }
    const builtinAgents = new Set(["claude", "agy"]);
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
  })
  .describe(
    "Top-level swarm configuration (copy `config/swarm.example.json` to gitignored `config/swarm.json`).",
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
    useWorktree: z
      .boolean()
      .optional()
      .describe(
        "Optional per-project override for `workerDefaults.useWorktree`. Set `true` to allow multiple concurrent workers on this single repo via Git worktrees.",
      ),
    paths: z
      .record(z.string().min(1), z.string().min(1))
      .refine(
        (p) => Object.keys(p).length > 0,
        "Each project must define at least one machine checkout path under `paths`.",
      )
      .describe("Map of machine keys from `swarm.json` to absolute local repository paths."),
  })
  .strict()
  .describe("Repository metadata and per-machine checkout paths for a single `#projects/<slug>` queue.");

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
      cursor: z.union([z.string(), z.number()]).optional(),
    })
    .passthrough(),
]);

// ---------------------------------------------------------------------------
// Herdr CLI JSON schemas (verified against herdr 0.9.3)
// ---------------------------------------------------------------------------

export const HerdrAgentStatusSchema = z
  .enum(["idle", "working", "blocked", "done", "unknown"])
  .describe(
    'Herdr detected agent lifecycle state: "working" = active turn, "blocked" = approval/question prompt visible, "idle"/"done" = ready for input, "unknown" = unclassified.',
  );

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
    workspace: z.object({ workspace_id: z.string().min(1), active_tab_id: z.string().optional() }).passthrough(),
    tab: z.object({ tab_id: z.string().min(1) }).passthrough().optional(),
    root_pane: z.object({ pane_id: z.string().min(1) }).passthrough().optional(),
    pane: z.object({ pane_id: z.string().min(1) }).passthrough().optional(),
  })
  .passthrough();

export const HerdrCreatedTabResultSchema = z
  .object({
    tab: z.object({ tab_id: z.string().min(1), workspace_id: z.string().optional() }).passthrough(),
    root_pane: z.object({ pane_id: z.string().min(1) }).passthrough().optional(),
    pane: z.object({ pane_id: z.string().min(1) }).passthrough().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Exported TypeScript types inferred directly from Zod schemas
// ---------------------------------------------------------------------------

export type MachineOs = z.infer<typeof MachineOsSchema>;
export type MachineRole = z.infer<typeof MachineRoleSchema>;
export type EffortLevel = z.infer<typeof EffortLevelSchema>;
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export type WorkerAgentProfile = z.infer<typeof WorkerAgentProfileSchema>;
export type BoardConfig = z.infer<typeof BoardConfigSchema>;
export type LeadConfig = z.infer<typeof LeadConfigSchema>;
export type WorkerDefaultsConfig = z.infer<typeof WorkerDefaultsConfigSchema>;
export type RawMachineConfig = z.infer<typeof MachineConfigSchema>;
export type RawSwarmConfig = z.infer<typeof SwarmConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ProjectsConfig = z.infer<typeof ProjectsConfigSchema>;
export type BoardTaskState = z.infer<typeof BoardTaskStateSchema>;
export type HerdrAgentStatus = z.infer<typeof HerdrAgentStatusSchema>;
export type HerdrWorkspace = z.infer<typeof HerdrWorkspaceSchema>;
export type HerdrTab = z.infer<typeof HerdrTabSchema>;
export type HerdrAgent = z.infer<typeof HerdrAgentSchema>;
