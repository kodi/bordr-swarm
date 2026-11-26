# bordr-swarm

**Turn your laptop, Mac Studio, and spare Linux box into a self-organizing coding-agent fleet — with zero idle token burn and an exception-only dashboard.**

`bordr-swarm` wires together **[Vercel Board](https://vercel.com/docs/board)** (hosted team control plane & atomic task queue), **Herdr** (terminal, workspace & agent runtime), and **Sheprd** (desktop + mobile UI) using a lightweight, declarative TypeScript/Node 24+ toolkit.

> **1 runtime dependency (`zod`)** · **Zero build step** (native Node TS) · **0 idle LLM tokens** · **macOS & Linux** · **Claude Code + Antigravity (`agy`)**

---

## What It Feels Like to Use

1. **Drop an idea in `#inbox`** from your browser or phone — _"In `my-api`, add a `/healthz` endpoint with tests, and in `my-web`, wire a status badge (`agent=agy`)."_
2. **Lead wakes up instantly** (0 tokens while idle), reads the live fleet catalog, splits your request into self-contained tasks under `#projects/my-api` and `#projects/my-web`, and wires dependencies with `--needs`.
3. **Workers across your machines claim & execute** — each host's deterministic Dispatcher atomically claims matching tasks, renews leases every 5 minutes, opens a fresh Herdr tab in the right checkout, and runs `claude` or `agy`.
4. **Finished tabs vanish; blockers surface** — when a task completes, its tab closes automatically. **Any worker tab still open in Sheprd means either actively working or `[BLOCKED]` / `[FAILED]` waiting on human eyes.**

---

## Why `bordr-swarm`?

Most DIY agent swarms fail in the same four ways: polling loops burn tokens overnight, LLMs forget to renew task leases, stale long-lived sessions corrupt repo state, and adding a second machine turns into a YAML/SSH nightmare. `bordr-swarm` solves each one deterministically:

| Pain Point                       | How `bordr-swarm` Solves It                                                                                                                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Idle LLM token burn**          | Two tiny TypeScript daemons — **Lead Watcher** and **Worker Dispatcher** — handle all polling, deduplication, task claiming, and `15m` lease renewals (every `5m`). Lead only wakes when a real `#inbox` post, `@lead` mention, or `blocked` task arrives. |
| **Tab soup & babysitting**       | Completed worker tabs auto-close. Blocked or failed tabs stay open, renamed `[BLOCKED]` / `[FAILED]`, and light up in **Sheprd** (desktop & mobile). Closing a parked tab frees its slot and repo lock.                                                    |
| **Cross-machine config drift**   | **Zero fleet-wide config.** Each machine runs a ~10-line local `config/swarm.json`. Workers auto-publish their capabilities and repo slugs to `#swarm/registry` (keeping local filesystem paths private), and Lead auto-syncs the merged catalog.          |
| **Repo collisions**              | Workers spawn in plain Herdr tabs guarded by a **per-repo lock** so two agents never mutate the same working tree simultaneously — with opt-in `useWorktree: true` per project when you want parallel work on one repo.                                    |
| **Single-agent lock-in**         | Default workers run **Claude Code** (`opus`, medium effort, `--permission-mode auto`), and any task can route to **Antigravity (`agy`)** via `--label agent=agy` (or override `model=` / `effort=` per task).                                              |
| **OS service & proxy headaches** | One unified CLI (`mise run ...`) wraps `systemd --user` (Linux, unprivileged, `linger`-checked), `launchd` (macOS, race-free `kickstart`/`bootout`), auto-detected Tailscale MagicDNS `--allow-host`, and pull-based `mise run update`.                    |

---

## Architecture at a Glance

```mermaid
flowchart LR
  Human["Human Operator\n(Browser / Sheprd)"]

  subgraph ControlPlane["Vercel Board (Hosted Control Plane)"]
    Inbox["#inbox\n(Requests & triage)"]
    Registry["#swarm/registry\n(Auto-published host & repo cards)"]
    Queue["#projects/<slug>\n(Atomic task queue + leases)"]
  end

  subgraph MainHost["Main Machine (or role: both)"]
    BoardUI["Board Inspector UI\nlocalhost:4747 / Tailscale HTTPS"]
    LeadWatcher["Lead Watcher (0 tokens)\nPolls events · Syncs #swarm/registry"]
    Lead["Lead Agent (Claude Opus high)\nHerdr ~/swarm-hq · Wakes on demand"]
  end

  subgraph WorkerHost["Worker Machine(s) (macOS / Linux)"]
    Dispatcher["Worker Dispatcher (0 tokens)\nClaim · 5m Lease Heartbeat · Repo Lock"]
    subgraph Herdr["Herdr Server"]
      W1["Tab: task-a1b2 (claude)"]
      W2["Tab: task-c3d4 (agy)"]
      Parked["Tab: [BLOCKED] task-e5f6"]
    end
  end

  Sheprd["Sheprd UI (Desktop / Mobile)\nException dashboard & live takeover"]

  Human -->|"Post ideas / review"| BoardUI
  BoardUI <--> ControlPlane
  ControlPlane -->|"Events & registry"| LeadWatcher
  LeadWatcher -->|"herdr agent prompt"| Lead
  Lead -->|"Create tasks + labels + --needs"| Queue
  Dispatcher -->|"Auto-publish capabilities & repos"| Registry
  Queue <-->|"Claim · Renew · Complete / Block"| Dispatcher
  Dispatcher -->|"Spawn tab · Auto-close on done"| Herdr
  W1 -->|"Reply & complete"| Queue
  W2 -->|"Reply & complete"| Queue
  Herdr -.->|"Live status"| Sheprd
  Lead -.->|"Live status"| Sheprd
  Sheprd -->|"Approve / unblock / close"| Human
```

---

## 2-Minute Quick Start (Single Machine)

No hand-editing JSON required. Everything runs through [`mise`](https://mise.jdx.dev/) + Node 24+ native TypeScript:

```bash
# 1. Clone and install pinned tools (Node, Vercel CLI, @vercel/board, vercel/board skill)
git clone https://github.com/kodi/bordr-swarm.git ~/bordr-swarm
cd ~/bordr-swarm
./scripts/bootstrap.sh

# 2. Interactive setup wizard (auto-detects OS, hostname, Tailscale, CLIs & Vercel handle)
mise run init
```

Press **Enter** to accept the default role **`both`** (Board UI + Lead + Worker on one machine), answer 2 quick prompts, and let `init` start your services.

Then register your first local Git repo (no restart needed — the Dispatcher hot-reloads and publishes to `#swarm/registry` automatically):

```bash
mise run project:add -- ~/path/to/your-repo
```

Open **`http://127.0.0.1:4747`** and drop your first message in `#inbox`:

> _"In `your-repo`, do a read-only smoke test: summarize what the repo does and the last 3 commits in clean Markdown, no file changes."_

_(On first run, open **Sheprd** once to approve Claude's folder-trust prompt.)_

---

## Scale Out to Multiple Machines

Want an always-on Linux box hosting the Board UI + Lead, and one or more Macs/Linux workstations doing the heavy lifting? Each host only needs its own tiny local config — **machines discover each other automatically via `#swarm/registry`**:

1. **Always-on main host (Linux or macOS):**

   ```bash
   ./scripts/bootstrap.sh && mise run init   # Pick role: 2) main
   ```

   Expose the Board UI privately over HTTPS with automatic Let's Encrypt certs (browsers require a Secure Context for `crypto.randomUUID()`):

   ```bash
   sudo tailscale serve --bg --https=4748 http://127.0.0.1:4747
   ```

   _(Your Tailscale MagicDNS hostname is auto-detected and added to `--allow-host` — no `421 Misdirected Request` surprises.)_

2. **Each worker host (macOS or Linux):**
   ```bash
   ./scripts/bootstrap.sh && mise run init   # Pick role: 3) worker
   mise run project:add -- ~/code/my-app
   ```
   Register the same repo slug on **two or more workers** and Lead automatically sees both hosts (`defaultMachine: "any"`), letting whichever machine has free slots claim the task — or pin it explicitly with `--label machine=<host>` / `--label os=macos`.

---

## Developer Experience (DX) Toolkit

Never remember raw `systemctl --user`, `XDG_RUNTIME_DIR`, or `launchctl` incantations again. Every host exposes the same ergonomic command set:

| Command                          | What It Does                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mise run init`                  | Interactive first-time setup wizard — handles `vercel login`, environment auto-detection, minimal `config/swarm.json`, and initial service start.                          |
| `mise run apply`                 | Role-aware idempotent apply (`main`, `worker`, or `both`) with a "Ready to go!" summary banner.                                                                            |
| `mise run doctor`                | Preflight check for tools, Zod config validation, Vercel Board auth, Herdr server, Tailscale, and Linux `systemd` linger — with 1-line fix hints on every warning.         |
| `mise run status`                | Shows active background services, Board UI HTTP health, and live Herdr swarm agents on this host.                                                                          |
| `mise run logs -- -f`            | Cross-platform log tailing (`lead-watcher`, `ui`, or `dispatcher`).                                                                                                        |
| `mise run project:add -- <path>` | Registers a local Git repo, auto-detects its default branch, hot-reloads the Dispatcher, and updates `#swarm/registry` immediately. (`project:ls`, `project:rm -- <slug>`) |
| `mise run update`                | Pull-based self-update (`git pull --ff-only`, conditional tool/dep sync, role-aware service reload, and status check). Pass `-- --restart-lead` after editing prompts.     |
| `mise run stop`                  | Cleanly stops & unloads all swarm services and closes Lead in Herdr. Add `-- --reset` for a 1-command clean slate.                                                         |

### Task Routing Labels

Ask Lead in natural language in `#inbox` — or create tasks directly via CLI with optional routing labels:

```bash
# Default worker (Claude Code: opus, medium effort, auto mode) on any matching machine
vercel board tasks create projects/example-app "Add health check endpoint"

# Route to Antigravity CLI (agy) with its default model
vercel board tasks create projects/example-app "Refactor parser" --label agent=agy

# Target a specific host, OS, model, or reasoning effort
vercel board tasks create projects/example-app "Build macOS bundle" \
  --label machine=worker-machine --label effort=high

# Chain cross-project tasks with dependencies
vercel board tasks create projects/web-app "Display new health badge" --needs <task_id>
```

### Minimal Config, Strict Validation

`mise run init` generates a tiny per-host `config/swarm.json` (gitignored). Every omitted setting falls back to strict **Zod v4** defaults, and editor autocomplete/hover docs come free from the generated JSON Schema ([config/swarm.schema.json](config/swarm.schema.json)):

```json
{
  "$schema": "./swarm.schema.json",
  "board": {
    "humanHandle": "@owner"
  },
  "machines": {
    "my-workstation": {
      "role": "both",
      "os": "macos",
      "maxWorkers": 2
    }
  }
}
```

Need custom agent profiles, worktrees, or lease tuning? See [config/swarm.example.json](config/swarm.example.json) for every available field.

---

## Engineering & Toolchain

Built to stay fast, readable, and easy to fork:

- **Zero build step:** Node 24+/26+ native TypeScript execution (`erasableSyntaxOnly: true`, `verbatimModuleSyntax: true`).
- **Minimal runtime surface:** Only **`zod` v4** at runtime — everything else uses Node built-ins (`node:child_process`, `node:fs`, `node:readline/promises`, `node:test`).
- **Instant quality checks:** Native **TypeScript 7** (`tsc --noEmit`), **oxlint**, **oxfmt**, and **lefthook** pre-commit hooks run the full suite in under a second:

```bash
npm install             # Installs dev tools & registers lefthook pre-commit hooks
npm run check           # oxfmt --check + oxlint + TS 7 typecheck + node --test
npm run fmt             # Auto-format all files with oxfmt
npm run schemas:generate # Regenerate JSON Schemas from Zod definitions
```

---

## Docs & Repo Layout

- [Architecture & Design](docs/architecture.md) — full task lifecycle, Mermaid diagrams, and operational gotchas
- [Main Machine Setup Guide](docs/main-machine-setup.md) — headless Linux/macOS hub, `systemd --user`, and Tailscale HTTPS
- [Worker Machine Setup Guide](docs/worker-machine-setup.md) — joining workers, multi-machine repos, agent labels, and Sheprd

```text
.
├── mise.toml                   # Pinned toolchains (node, vercel, @vercel/board) + DX tasks
├── config/
│   ├── swarm.example.json      # Full reference config (your local config/swarm.json is gitignored)
│   ├── projects.example.json   # Reference project registry (normally managed by `project:add`)
│   ├── swarm.schema.json       # Generated Zod v4 JSON Schema for editor autocomplete
│   └── projects.schema.json    # Generated Zod v4 JSON Schema
├── prompts/
│   ├── lead-CLAUDE.md          # Lead agent playbook template (GFM Markdown + triage policy)
│   └── worker-prompt.md        # Ephemeral worker prompt template
├── src/
│   ├── dispatcher.ts           # Per-machine Worker Dispatcher daemon (0 idle tokens)
│   ├── lead-watcher.ts         # Event-driven Lead Watcher & #swarm/registry sync (0 idle tokens)
│   └── lib/                    # Typed wrappers: config, schemas, host-env, board, herdr, registry, routing
├── scripts/                    # bootstrap, init, apply, apply-main, apply-worker, stop, doctor, project, status, logs, update
├── infra/                      # Optional systemd, launchd, and Caddy reference templates
└── tests/                      # Fast Node built-in unit tests (dispatcher, lead-watcher, registry)
```
