# bordr-swarm

Declarative ("terraformable") setup, documentation, prompts, and TypeScript/Node tooling for running a multi-machine AI coding agent swarm coordinated through **Vercel Board**, executed in **Herdr**, and monitored in **Sheprd**.

## Architecture at a Glance

- **Control plane:** [Vercel Board](https://vercel.com/docs/board) (hosted team board) — channels, threads, atomic task leases, and dependencies (`--needs`).
- **Board UI (`main-machine`):** Runs `board inspect` (from `@vercel/board`) as a background service (`systemd --user` on Linux or `launchd` on macOS), optionally reverse-proxied over a private network / Tailscale.
- **Lead Agent (`main-machine`):** Claude Code (`opus` high, `--permission-mode auto`) running in a dedicated Herdr workspace (`~/swarm-hq`). Watches `#inbox`, `@lead` mentions, and `blocked` tasks via `vercel board wait`. Triages requests into `#projects/<slug>` tasks and unblocks workers within policy.
- **Worker Dispatcher (`worker-machine`, 0 LLM tokens):** Lightweight per-machine TypeScript daemon (Node 24+/26+ native TS) that claims ready tasks, maintains Vercel Board lease heartbeats, spawns fresh per-task workers (default `claude` `opus` medium, or `agy` when labeled `agent=agy`) in plain Herdr tabs in the right project checkout, and cleans up completed tabs so **any lingering worker tab in Sheprd means actively working or needs human help**.
- **Monitoring:** **Sheprd** across all machines (and paired mobile) for instant `blocked` badges, scrollback inspection, and live human intervention.

## Quick Start

Everything is driven by [`mise`](https://mise.jdx.dev/) + native TypeScript on Node 24+/26+ (zero build step):

```bash
# 1. Clone this repo on your main machine and/or worker machine(s)
git clone https://github.com/kodi/bordr-swarm.git ~/bordr-swarm
cd ~/bordr-swarm

# 2. Install mise tools (node, vercel CLI, @vercel/board) and agent skills
./scripts/bootstrap.sh

# 3. Copy and customize local config (gitignored)
cp config/swarm.example.json config/swarm.json
cp config/projects.example.json config/projects.json
# Edit machine names, os ("linux" | "macos"), hostnames, and local repo paths

# 4. Verify CLI versions, Vercel Board auth, Herdr, and agent CLIs
mise run doctor

# 5. Configure services for the host's role:
mise run apply:main    # On your main machine (Board UI + Lead HQ; add --start-lead to launch Lead)
mise run apply:worker  # On your worker machine(s) (launchd on macOS, systemd --user on Linux)
```

## Task Routing Labels

Tasks created in `#projects/<slug>` support optional labels:

- `machine=<name>` or `machine=any` — route to a specific machine key from `config/swarm.json`
- `os=macos` or `os=linux` — route by machine OS
- `agent=claude` (default) or `agent=agy` — choose which worker CLI spawns in Herdr
- `model=<model>` / `effort=low|medium|high|xhigh|max` — optional per-task overrides

## Repo Layout

```text
.
├── AGENTS.md                   # Context & conventions for coding agents working in this repo
├── mise.toml                   # Pinned toolchains (node, vercel, @vercel/board) + tasks
├── package.json                # Minimal ESM + TypeScript setup
├── tsconfig.json               # Strict TS (erasableSyntaxOnly for native Node TS execution)
├── config/
│   ├── swarm.example.json      # Board config, machine roles/OS/hostnames, agent profiles
│   └── projects.example.json   # Cross-project registry (slug -> repo path per machine)
├── docs/
│   ├── architecture.md         # Full design, lifecycle states, routing, and gotchas
│   ├── main-machine-setup.md   # Main machine setup (Board UI, Lead HQ, reverse proxy)
│   └── worker-machine-setup.md # Worker machine setup (Dispatcher, agent labels, Sheprd)
├── prompts/
│   ├── lead-CLAUDE.md          # Lead agent playbook template
│   └── worker-prompt.md        # Ephemeral worker prompt template
├── infra/
│   ├── caddy/                  # Optional Caddy reverse-proxy snippet for Board UI
│   ├── systemd/                # Linux `systemd --user` templates (Board UI & Worker Dispatcher)
│   └── launchd/                # macOS `launchd` plist template (Worker Dispatcher)
├── src/
│   ├── dispatcher.ts           # Per-machine Worker Dispatcher daemon
│   └── lib/                    # Typed wrappers for config, Vercel Board, Herdr, and routing
├── scripts/
│   ├── bootstrap.sh            # One-shot machine bootstrap (mise + skills)
│   ├── doctor.ts               # Environment & connectivity preflight checker
│   ├── apply-main.ts           # Idempotent main-machine setup (Linux & macOS)
│   └── apply-worker.ts         # Idempotent worker-machine setup (macOS & Linux)
└── tests/
    └── dispatcher.test.ts      # Node built-in unit tests for routing, agents, and lifecycle
```

## Docs

- [Architecture & Design](docs/architecture.md) _(includes Mermaid topology & task-lifecycle diagrams)_
- [Main Machine Setup Guide](docs/main-machine-setup.md)
- [Worker Machine Setup Guide](docs/worker-machine-setup.md)

## Development & Quality Checks

Uses native **TypeScript 7**, **oxlint**, **oxfmt**, and **lefthook** pre-commit hooks on staged files:

```bash
npm install      # Installs dev tools & registers lefthook pre-commit hooks
npm run check    # Runs oxfmt --check, oxlint, tsc --noEmit (TS 7), and node --test
npm run fmt      # Auto-formats files with oxfmt
```
