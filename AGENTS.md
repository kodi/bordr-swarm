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
- **Plain Herdr tabs by default + per-repo lock:** Workers spawn via `herdr tab create` with `--env BOARD_PROFILE=...` and `--env VERCEL_SCOPE=...`, guarded by a per-repo lock so two plain-tab workers never mutate the same checkout simultaneously. Optional `useWorktree: true` per project remains supported.
- **Worker agent label routing:** Workers default to `claude` (`--model opus --effort medium --permission-mode auto`), and support target label routing via `agent=agy` (`agy --effort medium --mode auto`), `agent=codex` (`codex -c model_reasoning_effort="medium" -c sandbox_workspace_write.network_access=true --approve-for-me`), and `agent=pi` (`pi --thinking medium --approve`) — each omitting `--model` by default unless `model=...` is configured or labeled. Lead uses `claude --model opus --effort high --permission-mode auto`.
- **Board Inspector UI:** Uses `board inspect` from `@vercel/board` (pinned in `mise.toml` as `"npm:@vercel/board" = "latest"`), with `--allow-host` rendered from `machines.<main>.allowedHosts`.
- **No secrets or personal machine details in git:** `config/swarm.json` and `config/projects.json` are gitignored; keep generic templates in `*.example.json`.

## Conventions

- Keep Linux services unprivileged (`systemctl --user`) — never require `sudo` for agent runtime users.
- Herdr CLI commands return JSON; always parse IDs from JSON responses rather than guessing them. Use `--no-focus` for background spawns.
- Sanitize Herdr live agent names to match `/^[a-z][a-z0-9_-]{0,31}$/`.
