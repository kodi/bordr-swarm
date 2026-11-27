# Research: Rex vs Herdr as a worker runtime

> Status: exploration only (no implementation). Board task `msg_f86bbe3b-05bd-4a78-8ab8-482f06fd6f74_1`.
> Rex docs read 2026-11-27 (Rex Beta 0.1.0). Herdr reference: `herdr 0.9.5` installed locally; JSON schemas in `src/lib/schemas.ts` were verified against 0.9.3.
> Rex was **not** installed or exercised here. Everything about Rex below comes from its docs, not from running it.

Abbreviation: `D` = `https://www.superlogical.com/rex/docs`

## TL;DR

Rex overlaps with Herdr on the **terminal multiplexer** layer, but **not** on the **agent runtime** layer:

- **Covered:** spawn, `cwd`, background (no-focus) creation, JSON output with stable IDs, rename, close, capture, send input, SSH targets, headless Linux server under `systemd --user`.
- **Missing:**
  - Herdr's built-in **agent status detection** (`working`/`blocked`/`idle`/`done`).
  - Herdr's `agent start` / `agent prompt` semantics (wait until ready, detect a startup prompt, submit a prompt reliably).
  - Worktree management.
  - A per-pane `--env` flag.

**Verdict:** in theory, a Rex-backed worker could run alongside a Herdr-backed one behind the same Board dispatch flow, because the FSMs are pure and only consume an agent-status enum. In practice:

- We would have to build the agent-awareness layer ourselves, at least for `claude`.
- Rex is still beta: no stable channel, no semver promise, installs gated behind Discord.
- Rex workers would be invisible in Sheprd.

A spike is feasible: **claude-only, a Linux worker, Rex as the per-machine runtime**. It is not production-worthy yet. Rough effort is **~5–8 dev-days** (see below).

## 1. Capability map

These are the Herdr features `bordr-swarm` uses. Wrapper methods are in `src/lib/herdr.ts`; call sites are listed under each.

| #   | Herdr capability (CLI)                                                                                                                 | Wrapper / used in                                                                                                                                                                                                                                                  | Rex equivalent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Fit                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| 1   | JSON envelope output with IDs (`{result:{...}}`)                                                                                       | `parseEnvelope` `herdr.ts:56`; Zod schemas `schemas.ts:752-884`                                                                                                                                                                                                    | `--json` on create/list/inspect, "stable to parse and includes full IDs"; exit codes 0/1/2/3/4/130 (`D/automate/cli`)                                                                                                                                                                                                                                                                                                                                                                            | ✅                                                 |
| 2   | `workspace list`                                                                                                                       | `listWorkspaces` `herdr.ts:101` ← `findOrCreateProjectTab`                                                                                                                                                                                                         | `rex ls --json` / `rex session ls --json` (`D/reference/cli`)                                                                                                                                                                                                                                                                                                                                                                                                                                    | ✅                                                 |
| 3   | `workspace create --cwd --label --env K=V --no-focus`                                                                                  | `createWorkspace` `herdr.ts:106` ← `findOrCreateProjectTab` (Dispatcher `dispatcher.ts:399`, Lead Watcher `lead-watcher.ts:432`)                                                                                                                                   | `rex new [LABEL] -c DIR --json [-- CMD]` → `.session_id`. Focus behaviour of `rex new` is not documented. **No `--env`** (`D/reference/cli`)                                                                                                                                                                                                                                                                                                                                                     | 🟡 env missing                                     |
| 4   | `tab create --workspace --cwd --label --env --no-focus`                                                                                | `createTab` `herdr.ts:138` ← Dispatcher spawn, reviewer spawn `dispatcher-effects.ts:117`                                                                                                                                                                          | `rex window new -s SESSION LABEL -c DIR --focus=false --json -- CMD`, or `rex run -s SESSION -c DIR --label L --focus=false --json -- CMD` → `.window_id`, `.block_ids[0]` (`D/reference/cli`, `D/automate/shell-scripting`)                                                                                                                                                                                                                                                                     | 🟡 env via `-- env K=V cmd` wrapper (my inference) |
| 5   | `tab list` (existence + `agent_status`)                                                                                                | `listTabs` `herdr.ts:129` ← reconcile loops `dispatcher.ts:599`, `lead-watcher.ts:311`                                                                                                                                                                             | `rex window ls -A`, `rex block ls -A --json` (`D/reference/cli`)                                                                                                                                                                                                                                                                                                                                                                                                                                 | ✅ for existence; status comes from #12            |
| 6   | `tab rename <id> <label>` (`[BLOCKED]`/`[FAILED]` markers)                                                                             | `renameTab` `herdr.ts:243` ← `dispatcher.ts:478`, `dispatcher-effects.ts:50,376`, `lead-watcher.ts:256,367,450`                                                                                                                                                    | `rex window rename` / `rex block rename` (`D/reference/cli`)                                                                                                                                                                                                                                                                                                                                                                                                                                     | ✅                                                 |
| 7   | `tab close <id>`                                                                                                                       | `closeTab` `herdr.ts:247` ← `dispatcher-effects.ts:382,406`, `lead-watcher.ts:287,489`, `scripts/stop.ts:146`, `scripts/apply-main.ts:407`                                                                                                                         | `rex window close` / `rex block close` / `rex kill` (`D/reference/cli`)                                                                                                                                                                                                                                                                                                                                                                                                                          | ✅                                                 |
| 8   | `worktree create --cwd --branch --base --label --no-focus`                                                                             | `createWorktree` `herdr.ts:200` ← `dispatcher.ts:392` (opt-in `useWorktree`)                                                                                                                                                                                       | **Not documented**: "worktree" appears nowhere in the Rex docs                                                                                                                                                                                                                                                                                                                                                                                                                                   | ❌ do it ourselves with `git worktree add`         |
| 9   | `worktree remove --workspace`                                                                                                          | `removeWorktree` `herdr.ts:239` ← `dispatcher-effects.ts:400`                                                                                                                                                                                                      | Not documented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ❌ `git worktree remove`                           |
| 10  | `pane run <pane> <cmd>` (exporting env into a worktree shell)                                                                          | `paneRun` `herdr.ts:251`                                                                                                                                                                                                                                           | `rex send -b BLOCK "cmd"` + `rex send-key -b BLOCK enter`; `send` does **not** press Enter (`D/automate/shell-scripting`)                                                                                                                                                                                                                                                                                                                                                                        | ✅                                                 |
| 11  | `pane read --source recent-unwrapped --lines N --raw` (crash tail)                                                                     | `paneRead` `herdr.ts:255` ← `dispatcher-effects.ts:470`                                                                                                                                                                                                            | `rex capture -b BLOCK --format text --unwrap --trim`. No `--lines`, so we slice the tail ourselves. Alternate-screen TUIs return only the current screen (`D/reference/cli`)                                                                                                                                                                                                                                                                                                                     | ✅/🟡                                              |
| 12  | **`agent list` / `agent get <name>`: auto-detected `agent_status` ∈ `idle\|working\|blocked\|done\|unknown`**                          | `listAgents` `herdr.ts:275`, `getAgent` `herdr.ts:280` ← reconcile loops, Lead adoption `lead-watcher.ts:362`, `scripts/status.ts:116`, `scripts/stop.ts:129`, `scripts/apply-main.ts:380`. Consumed by `session-fsm.ts:69`, `lead-fsm.ts:79`, `task-fsm.ts:67-69` | **No automatic detection.** The Program Status Protocol (OSC 7501, `state=idle\|working\|done\|blocked\|error`, `kind=permission\|question\|auth`) requires the _program_ to self-report. Readable through `rex block call program_status` and `terminal.program_status_changed` events (`D/build/program-status`, `D/reference/events`). `rex skill setup --agent claude\|codex` installs a hook, but the docs do **not** say that hook emits working/blocked status (`D/automate/agent-skill`) | ❌ **main gap**                                    |
| 13  | **`agent start <name> --kind K --pane P --timeout T -- args`** (launch + wait-until-ready; `agent_not_ready` ⇒ startup prompt visible) | `startAgent` `herdr.ts:291` ← `dispatcher.ts:424`, `dispatcher-effects.ts:138,290`, `lead-watcher.ts:440`                                                                                                                                                          | Launch is easy (`rex run -- claude ...`). There is no "wait until ready" or "startup blocked" signal unless #12 is solved. `rex wait` only waits for exit (`D/reference/cli`)                                                                                                                                                                                                                                                                                                                    | ❌/🟡                                              |
| 14  | **`agent prompt <name> <text> [--wait]`** (deliver a multi-line prompt to the agent TUI and submit)                                    | `promptAgent` `herdr.ts:329` ← `dispatcher.ts:487`, `dispatcher-effects.ts:202,280,319,420`, `lead-watcher.ts:267,385,467`                                                                                                                                         | `rex send` (stdin-capable) + `rex send-key enter`, or `rex block call write`. Bracketed paste for multi-line prompts and submit timing would be our job (`D/automate/shell-scripting`, `D/reference/lua`)                                                                                                                                                                                                                                                                                        | 🟡                                                 |
| 15  | Named agents (`/^[a-z][a-z0-9_-]{0,31}$/`), looked up by name                                                                          | `sanitizeHerdrAgentName` `herdr.ts:44`; adoption-by-name after restart `lead-watcher.ts:362`                                                                                                                                                                       | No agent registry. Use block **labels** plus saved IDs; label targets resolve case-insensitively, and ambiguity gives exit 3 (`D/automate/cli`)                                                                                                                                                                                                                                                                                                                                                  | 🟡                                                 |
| 16  | Remote target `--machine <label>`                                                                                                      | `buildArgs` `herdr.ts:80`; `machines.<m>.herdrTarget` `schemas.ts:434` (default `"local"`)                                                                                                                                                                         | `rex -S LABEL` / `rex -S ssh://user@host`; `rex hosts add` (`D/linux/remote-access`)                                                                                                                                                                                                                                                                                                                                                                                                             | ✅ (we default to local anyway)                    |
| 17  | `herdr status server`, `herdr --version`                                                                                               | `scripts/doctor.ts:55,223`                                                                                                                                                                                                                                         | `rex server status`, `rex version` (`D/reference/cli`)                                                                                                                                                                                                                                                                                                                                                                                                                                           | ✅                                                 |
| 18  | Herdr server as an unprivileged long-lived daemon                                                                                      | `docs/worker-machine-setup.md`                                                                                                                                                                                                                                     | Linux: `rex server install` sets up `systemd --user` `rex.socket` plus linger, no sudo. macOS: "The Rex app runs the server", and a standalone headless macOS server is not documented (`D/reference/cli`, `D/linux/server-modes`, `D/linux/installation`)                                                                                                                                                                                                                                       | ✅ Linux / 🟡 macOS                                |
| 19  | **Sheprd** as the cockpit: `[BLOCKED]` tabs visible on desktop and phone                                                               | `docs/architecture.md:26-82`                                                                                                                                                                                                                                       | Rex Mac app: tab indicators, Activity view, Dock badge. iOS app for enrolled testers only (`D/reference/mac-settings`, `D/installation`). **Sheprd will not see Rex sessions**                                                                                                                                                                                                                                                                                                                   | ❌ split cockpit                                   |

Not used today, but Rex offers it: `rex events --json` (an NDJSON stream of `block_closed`, `terminal.child_exited`, `program_status_changed`, …). It could replace the 2-call poll (`listTabs` + `listAgents`) in the reconcile loops with push updates.

## 2. Rex specifics that matter for automation

- **Machine-readable output:**
  - `--json` on all create/list/inspect commands, with stable IDs such as `block:01a10e00-…`.
  - A self-describing control API: `rex api list|describe|call` with JSON-Schema methods.
  - Distinct exit codes, e.g. `3` = target not found or ambiguous, `4` = server unreachable.
  - No gRPC, no webhooks, and no MCP server that controls Rex.
  - Sources: `D/automate/cli`, `D/automate/server-api`, `D/reference/api`.
- **Headless/background operation:**
  - Client/server design; sessions outlive clients.
  - Linux and FreeBSD are **server only**, which fits a worker box.
  - `rex server start` (background, idempotent) or `rex server install` (`systemd --user`, linger, no sudo). This fits our "no sudo" convention.
  - Creation without focus: `--focus=false`.
  - Some client actions (e.g. `pane.split` via `rex do`) need the GUI app running with Remote Control enabled. Core spawn/send/capture/close do not.
  - Sources: `D/linux/server-modes`, `D/reference/cli`, `D/automate/shell-scripting`.
- **Agent status detection:**
  - Rex uses opt-in self-reporting (OSC 7501 Program Status Protocol, spec rev 0.4, 2026-10-10). It explicitly prefers this "rather than" screen-scraping heuristics.
  - Herdr infers status for us. Under Rex, each agent CLI (or a hook we install) must emit it.
  - Claude Code and Codex have hooks we could use for this.
  - `agy` and `pi` would need screen-scrape heuristics via `rex capture`, which goes against Rex's design.
  - Sources: `D/build/program-status`, `D/automate/agent-skill`.
- **Env var injection:**
  - No per-pane `--env` flag. `--env` exists only on `rex server start`, where it applies to the whole server.
  - Workaround: `rex run -- env BOARD_PROFILE=… VERCEL_SCOPE=… claude …`.
  - Caveat: after a server-restart restore, a resumed Claude gets a fresh environment and exported variables are lost (`D/features/session-restore`). For us that is acceptable, because the Dispatcher would treat the pane as a fresh session anyway.
- **OS support:**
  - macOS app (which hosts the server).
  - Linux/FreeBSD/Windows server.
  - iOS/Windows apps for enrolled testers only.
  - Linux: x86-64 (SSE4.2) or ARM64, glibc ≥ 2.26 or musl. Packages: deb, rpm, pacman, apk, Nix.
  - Sources: `D/installation`, `D/linux/installation`.
- **Remote/multi-machine model:**
  - SSH targets (`-S ssh://…`) that auto-start the remote personal server.
  - Saved `rex hosts`, Tailscale (built in or Serve), or HTTP with `--allow-anonymous`.
  - Auth is connection-based only; a full auth system is "planned".
  - Lua scripts can reach other hosts through `rex.server(LABEL)`.
  - We would keep Rex **local per worker** (the Board is the bus), same as Herdr.
  - Source: `D/linux/remote-access`.
- **Maturity/stability:**
  - Beta 0.1.0. The `stable` channel has "none right now"; `preview` and `snapshot` are the alternatives.
  - No documented CLI semver guarantee beyond "`--json` is stable to parse".
  - Client/server version skew is checked. A Linux package upgrade restarts the _shared_ server; the _personal_ server picks up the new version only when it stops.
  - Limits: 64 sessions, 1024 blocks, 1 MiB requests, 10s default CLI `--timeout`.
  - Sources: `D/linux/installation`, `D/linux/upgrading`, `D/reference/cli`.
- **Licensing/cost:**
  - "Rex is and will always be free. You do not need to create an account."
  - Fully self-hostable, no telemetry, no license checks.
  - Not stated as open source.
  - Beta downloads require a Discord login or an invite.
  - Sources: `D/reference/privacy`, `https://www.superlogical.com/updates/public-testing-beginning`.

## 3. Verdict, blockers and gaps

**Enough overlap? Yes for the plumbing, no for the agent layer.** A Rex-backed worker can sit next to a Herdr-backed one only if we add an agent-awareness shim:

1. **Blocker: agent status (#12).** Every FSM transition (prompt delivery, idle grace, auto-close, `[BLOCKED]` parking, reviewer handoff) depends on `working`/`blocked`/`idle`.
   - Options:
     - (a) Install Claude Code hooks that emit OSC 7501 to the pane TTY: `UserPromptSubmit`→working, `Notification(permission)`→blocked, `Stop`→idle.
     - (b) First verify whether `rex skill setup --agent claude` already emits status. The docs are silent.
     - (c) Screen-scrape fallback through `rex capture`.
   - Without one of these there is no Rex worker.
2. **Blocker: readiness and startup prompts (#13).** We need a replacement for `agent start --timeout` and its `agent_not_ready` result (for example the folder-trust prompt). This follows from #1: wait for the first `idle`, or for `blocked kind=permission`.
3. **Gap: prompt delivery (#14).** We need reliable multi-line paste plus submit to TUIs, using bracketed-paste sequences through `rex block call write`, then `send-key enter`. It needs testing against claude/codex.
4. **Gap: worktrees (#8/#9).** Move them into the Dispatcher with plain `git worktree add/remove`, which is runtime-agnostic and arguably better.
5. **Gap: env (#3/#4).** Use the `env K=V` argv wrapper. This is trivial.
6. **Gap: cockpit split (#19).** Sheprd only sees Herdr. Rex-blocked workers would appear in the Rex Mac app instead, and in Board replies. Board replies stay the source of truth; that parity is acceptable for a spike.
7. **Risk: maturity.** Beta, no stable channel, installs gated by Discord, and headless macOS not documented. A Rex worker should start on **Linux**.
8. **Agent coverage.** `claude` and `codex` have hooks; `agy` and `pi` have no documented hook. Route `agent=agy|pi` only to Herdr machines.

## 4. Runtime abstraction sketch (no implementation)

The FSMs (`session-fsm.ts`, `task-fsm.ts`, `lead-fsm.ts`) are already pure and only import the `HerdrAgentStatus` _type_. The seam is therefore `HerdrClient` plus the effect shells (`dispatcher.ts`, `dispatcher-effects.ts`, `lead-watcher.ts`).

```ts
// src/lib/runtime.ts (sketch)
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown"; // was HerdrAgentStatus

export interface SessionRef {
  runtime: "herdr" | "rex";
  containerId: string; // herdr workspace_id | rex session_id
  tabId: string; // herdr tab_id      | rex window_id
  paneId: string; // herdr pane_id     | rex block_id
  agentName: string; // herdr agent name  | rex block label
}

export interface RuntimeSnapshot {
  tabs: Set<string>; // existing tabIds
  agentsByPane: Map<string, { status: AgentStatus }>; // live agents
}

export interface WorkerRuntime {
  readonly kind: "herdr" | "rex";
  health(): Promise<{ ok: boolean; detail: string }>; // doctor/status
  spawn(opts: {
    group: string; // project slug → herdr workspace / rex session
    cwd: string;
    label: string;
    env: Record<string, string>;
    agent: { name: string; kind: string; args: string[] };
    timeoutMs: number;
  }): Promise<{ ref: SessionRef; blockedOnStartup: boolean }>; // replaces create*+startAgent
  prompt(ref: SessionRef, text: string): Promise<void>;
  snapshot(): Promise<RuntimeSnapshot>; // replaces listTabs+listAgents
  find(agentName: string): Promise<SessionRef | null>; // Lead adoption after restart
  rename(ref: SessionRef, label: string): Promise<void>;
  close(ref: SessionRef): Promise<void>;
  readTail(ref: SessionRef, lines: number): Promise<string>;
}
// Worktrees move out of the runtime: Dispatcher runs `git worktree add` first and passes cwd.
```

**Config.** Make the per-machine runtime a discriminated union, keeping `herdrTarget` as a back-compat alias:

```jsonc
"machines": {
  "mac-worker":   { "role": "worker", "maxWorkers": 2, "runtime": { "kind": "herdr", "target": "local" } },
  "linux-worker": { "role": "worker", "maxWorkers": 2, "runtime": { "kind": "rex", "server": "local",
                    "supportedAgents": ["claude", "codex"] } }
}
```

**Routing.** Two options:

- **Per-machine (recommended first).** Since the Dispatcher is per-machine, one machine runs Herdr and another runs Rex, both claiming from the same Board queue. A machine whose runtime can't host the task's `agent=` label should not claim it; the label routing in `src/lib/routing.ts` already filters by machine. An optional task label `runtime=rex|herdr` can pin a task.
- **Per-task on one machine (later).** The Dispatcher holds `Map<kind, WorkerRuntime>`, and every `SessionRef` carries `runtime`, so reconciliation knows which backend to poll. It needs both servers installed on the same host.

**Rough effort** (for a claude-only Rex worker on Linux):

| Slice                                                                                                                                                              | Estimate                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Extract `WorkerRuntime` + `HerdrRuntime` adapter, rename `HerdrAgentStatus`→`AgentStatus`, rewire Dispatcher/effects/Lead Watcher/scripts (no behaviour change)    | 1–1.5 d                                                              |
| Move worktree create/remove into Dispatcher via `git worktree`                                                                                                     | 0.5 d                                                                |
| `RexRuntime` adapter: spawn (`rex new`/`rex run --json`, `env` wrapper), rename, close, capture tail, `block ls` snapshot                                          | 1–1.5 d                                                              |
| Agent status for claude: verify `rex skill setup` hook output; else our own hooks emitting OSC 7501; map to `AgentStatus`; readiness and startup-blocked detection | 1.5–2 d                                                              |
| Prompt delivery: bracketed paste + submit, tested against the claude TUI                                                                                           | 0.5 d                                                                |
| Config schema/union + routing + doctor/status/stop + regenerated JSON schemas                                                                                      | 0.5–1 d                                                              |
| Tests (adapter fakes, routing) + Linux worker docs                                                                                                                 | 1 d                                                                  |
| **Total**                                                                                                                                                          | **~5–8 dev-days** (+1 d per extra agent kind with hooks, e.g. codex) |

The first slice is worth doing on its own merits: it decouples the effect shells from Herdr without committing to Rex.

## Sources (Rex docs read)

- `D/installation`, `D/features/session-restore`
- `D/automate/cli`, `D/automate/agent-skill`, `D/automate/lua-scripts`, `D/automate/lua-events`, `D/automate/shell-scripting`, `D/automate/server-api`
- `D/build/program-status`, `D/build/program-resume`
- `D/linux/installation`, `D/linux/server-modes`, `D/linux/shared-server`, `D/linux/login-server`, `D/linux/remote-access`, `D/linux/upgrading`, `D/windows/installation`, `D/windows/running`, `D/freebsd/installation`
- `D/reference/cli`, `D/reference/api`, `D/reference/lua`, `D/reference/events`, `D/reference/privacy`, `D/reference/mac-settings`, `D/reference/mac-actions`
- `D/customize/*`
- `D/llms-full.txt`
- `https://www.superlogical.com/updates/public-testing-beginning`
- `/rex/pricing` and `/pricing` return 404
