# AGENTS.md

Context for AI agents working in `bordr-swarm`.

## Project Goal

Build a reproducible, low-maintenance, multi-machine coding-agent swarm combining:

1. **Vercel Board** (`vercel board`, CLI >= 66.6.0) as the shared message bus & atomic task queue (using a hosted Vercel team board, authenticated via `vercel login` on each host).
2. **Herdr** (`herdr server` running on every machine, machines visible to each other via saved SSH profiles) as the terminal/workspace/worktree & agent process runtime.
3. **Sheprd** as the native desktop/mobile UI to monitor active/blocked workers across all machines.

## Generalized Machine Topology

Machine names, OS (`"linux"` or `"macos"`), hostnames, capacities, and repo paths are configured declaratively in gitignored `config/swarm.json` and `config/projects.json` (never hardcode personal hostnames, IPs, usernames, or private repo paths in committed files):

- **Main machine** (example key: `main-machine`, `role: "main"`):
  - Hosts the **Vercel Board Inspector UI** (`board inspect` from `@vercel/board` bound to localhost, optionally reverse-proxied over a private network/Tailscale) and the **Lead Agent** (Claude CLI, Opus high).
- **Worker machine(s)** (example key: `worker-machine`, `role: "worker"`):
  - Runs `herdr server`, optional `sheprd`, coding agent CLIs (`claude`, optional `agy`, `codex`, `pi`), and the local **Worker Dispatcher** daemon (`maxWorkers` concurrent slots).

## Architectural Decisions

- **Stack:** `mise` for toolchains & task automation + **TypeScript on Node 24+/26+ (native TS execution, zero build step)** + **Zod v4** (`src/lib/schemas.ts`) for runtime validation and self-documenting `.describe()` metadata (exported to `config/swarm.schema.json` and `config/projects.schema.json` via `mise run schemas:generate`).
  - Keep TS code compatible with Node's built-in type stripping (`erasableSyntaxOnly: true`, `verbatimModuleSyntax: true` — no `enum`, `namespace`, or parameter properties).
- **Per-machine Dispatcher:** Runs locally on each worker machine, talking directly to the local `herdr` socket. Owns atomic claiming, background lease renewal (`15m` leases renewed every `5m`), spawning, and cleanup — never rely on the LLM to remember `vercel board tasks renew`.
- **Durable Dispatcher state:** The dispatcher persists its tracked tasks (versioned, Zod-validated, written atomically) to `~/.local/state/bordr-swarm/dispatcher-<machine>.json` (`DISPATCHER_STATE_PATH`) and restores them on boot, so restarts with tasks in flight are safe. A graceful stop never closes tabs or releases tasks. Loading state never closes, releases, or fails anything: those decisions come only from FSM outcomes during reconcile. Lapsed leases and lost claims are modelled in the pure task FSM (`reclaim_task` / `[ORPHANED]`), and an orphan sweep (`src/lib/orphan-sweep.ts`) adopts or releases claimed-but-untracked tasks when no state file is usable. Task discovery lists `--state open` with cursor pagination. Tracked tasks that drop out of that list are resolved with a point lookup.
- **Ephemeral Per-Thread Lead Sessions:** `LeadWatcher` (`src/lead-watcher.ts`) spawns a fresh isolated Claude tab per Board thread (`lead-<shortId>`) on demand, delivers rapid same-thread follow-ups to the warm tab, parks `[BLOCKED]`/`[FAILED]` tabs in Sheprd without stalling other threads, and auto-closes finished tabs once idle.
- **Pure FSMs with Discriminated Unions (No Flag/If-Soup):** Model stateful daemon lifecycles (`src/lib/session-fsm.ts`, `src/lib/task-fsm.ts`, `src/lib/lead-fsm.ts`) as pure, synchronous state machines returning declarative side effects (executed by thin I/O shells):
  - Represent every distinct phase/substate as its own discriminated union variant carrying **only** the fields valid in that state — avoid boolean flags (`sawWorking`, `uiBlocked`) or nullable timers (`idleSinceMs: number | null`) that allow illegal combinations.
  - Dispatch transitions with exhaustive `switch (state.kind)` + `default: return assertNever(state)` so TypeScript enforces handling every variant.
  - Keep FSM unit tests pure and deterministic (no sleeps, no I/O).
- **Plain Herdr tabs by default + per-repo lock:** Workers spawn via `herdr tab create` with `--env BOARD_PROFILE=...` and `--env VERCEL_SCOPE=...`, guarded by a per-repo lock so two plain-tab workers never mutate the same checkout simultaneously. Optional `useWorktree: true` per project remains supported.
- **Worker agent label routing:** Workers default to `claude` (`--model opus --effort medium --permission-mode auto`), and support target label routing via `agent=agy` (`agy --effort medium --mode auto`), `agent=codex` (`codex -c model_reasoning_effort="medium" -c sandbox_workspace_write.network_access=true --approve-for-me`), and `agent=pi` (`pi --thinking medium --approve`) — each omitting `--model` by default unless `model=...` is configured or labeled. Lead uses `claude --model opus --effort high --permission-mode auto`.
- **Board Inspector UI:** Uses `board inspect` from `@vercel/board` (pinned in `mise.toml` as `"npm:@vercel/board" = "latest"`), with `--allow-host` rendered from `machines.<main>.allowedHosts`.
- **No secrets or personal machine details in git:** `config/swarm.json` and `config/projects.json` are gitignored; keep generic templates in `*.example.json`.

- **Event bus (`src/bus/`), events are hints:** `BoardTailSource` (`vercel board tail --json`), `HerdrEventSource` (Herdr socket, Zod-validated, private protocol, so any failure falls back to CLI polling), and `FsWatchSource` publish a `SwarmEvent` discriminated union. Events only wake a debounced, non-overlapping `WakeScheduler` tick of the same level-triggered FSMs; a periodic reconcile (`reconcileIntervalSeconds`, or `pollIntervalSeconds` while a source is down) stays as the safety net. Every slice of behavior must keep working with all sources disabled (`events.boardTail`/`events.herdr: false`). Never leave a `board tail` child behind: spawn it `detached` and kill the process group on stop.
- **Reactors:** "when X, do Y" rules are named reactors (`src/reactors/`) with pure `matches(event)` / `react(event, ctx) → ReactorEffect[]`; daemons execute effects in thin, per-effect-isolated handlers. Bind configuration when creating a reactor; `ctx` is only the daemon's read-only live view. Config-driven reactors (`swarm.json` `reactors[]`) run local commands only from local config (argv, no shell, event JSON on stdin) and never derive a command, path, or argument from Board content.

## Conventions

- Keep Linux services unprivileged (`systemctl --user`) — never require `sudo` for agent runtime users.
- Herdr CLI commands return JSON; always parse IDs from JSON responses rather than guessing them. Use `--no-focus` for background spawns.
- Sanitize Herdr live agent names to match `/^[a-z][a-z0-9_-]{0,31}$/`.
