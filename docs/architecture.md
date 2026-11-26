# Swarm Architecture

## System Overview

```mermaid
flowchart LR
  Human["Human Operator\n(Browser / Sheprd)"]

  subgraph ControlPlane["Vercel Board (Hosted Control Plane)"]
    Inbox["#inbox\n(Raw requests & triage)"]
    Queue["#projects/<slug>\n(Atomic task queue + leases)"]
  end

  subgraph MainMachine["Main Machine (Linux or macOS)"]
    BoardUI["Board Inspector UI\n(board inspect :4747 -> Caddy :4748)"]
    LeadWatcher["Lead Watcher (Node 24+ TS)\n0 LLM tokens · Watches #inbox,\n@lead mentions & blocked tasks"]
    Lead["Lead Agent (Claude Opus high)\nHerdr ~/swarm-hq\nIdle until woken by event"]
  end

  subgraph WorkerMachine["Worker Machine(s) (macOS or Linux)"]
    Dispatcher["Worker Dispatcher (Node 24+ TS)\n0 LLM tokens · Lease heartbeat\nPer-repo lock · Tab lifecycle"]
    subgraph Herdr["Herdr Server (Local Socket)"]
      W1["Tab: task-101 (claude)\nOpus medium · auto"]
      W2["Tab: task-102 (agy)\nDefault model · auto"]
      Parked["Tab: [BLOCKED] task-99\nParked for human review"]
    end
  end

  Sheprd["Sheprd UI (Desktop / Mobile)\nLive terminals & blocked alerts"]

  Human -->|"Post ideas / review"| BoardUI
  BoardUI <--> ControlPlane
  ControlPlane -->|"Poll #inbox, @lead & blocked\n(0 LLM tokens)"| LeadWatcher
  LeadWatcher -->|"Auto-start & wake via\nherdr agent prompt"| Lead
  Lead -->|"Create tasks + labels\n(machine=, agent=, --needs)"| Queue
  Queue <-->|"Claim · Renew every 5m\nComplete / Block"| Dispatcher
  Dispatcher -->|"Spawn plain tab + --env\nherdr agent start"| Herdr
  W1 -->|"Progress / complete / block"| Queue
  W2 -->|"Progress / complete / block"| Queue
  Herdr -.->|"SSH profile / live state"| Sheprd
  Lead -.->|"SSH profile / live state"| Sheprd
  Sheprd -->|"Approve / unblock / close"| Human
```

## Task Lifecycle

```mermaid
sequenceDiagram
  autonumber
  actor Human
  participant Board as Vercel Board
  participant Lead as Lead Agent (main-machine)
  participant Disp as Worker Dispatcher (worker-machine)
  participant Herdr as Herdr Worker Tab (claude / agy)
  participant Sheprd as Sheprd UI

  Human->>Board: Post request in #inbox
  Board-->>Lead: Wake via vercel board wait
  Lead->>Board: Create task in #projects/<slug> (labels: machine=, agent=)
  Disp->>Board: Poll ready tasks (filter machine, OS, repo lock, agent CLI)
  Disp->>Board: Claim task (--as worker-<host>-<id> --lease 15m)
  Disp->>Herdr: Create plain tab (--env BOARD_PROFILE) & start claude/agy
  Disp->>Herdr: Deliver rendered worker prompt

  loop Every 5 minutes while claimed
    Disp->>Board: Renew task lease (--lease 15m)
  end

  alt Task succeeds
    Herdr->>Board: vercel board tasks complete <id> "<summary + PR>"
    Disp->>Herdr: Auto-close Herdr tab & release repo lock
  else Worker blocked or needs approval
    Herdr->>Board: vercel board tasks block <id> "<reason>"
    Disp->>Herdr: Rename tab "[BLOCKED] task-<id> (<agent>)" & park
    Herdr-->>Sheprd: Surfaces blocked badge for human inspection
    Human->>Sheprd: Resolve & close tab (frees parked slot + repo lock)
  end
```

## Design Goals

1. **Single human cockpit:** Open the Vercel Board UI on your `main-machine` (from any tailnet/LAN device or inside Sheprd) to submit tasks, read status, and resolve escalated blockers.
2. **Cross-project workers without stale context:** Never keep long-lived worker sessions pinned to one repo. Spawn a fresh coding agent session per task in the right repo checkout, and close it on completion.
3. **Sheprd as the exception dashboard:** Because finished worker tabs are automatically closed, **any worker tab still visible in Sheprd means either actively working or `blocked`/`failed` needing human eyes**.
4. **Zero idle LLM burn:** Use blocking `vercel board wait` for the Lead agent, and a deterministic TypeScript Dispatcher (0 LLM tokens) for claiming tasks, renewing leases, spawning workers, and cleanup.
5. **Reproducible & host-agnostic:** Machine names, OS types (`linux` / `macos`), hostnames, capacities, and agent profiles live declaratively in gitignored `config/swarm.json` + `config/projects.json`.

---

## Components

### 1. Vercel Board (Control Plane)

Uses the hosted Vercel team board (`vercel board whoami` on every machine authenticated with `vercel login`, with optional `VERCEL_SCOPE` / `boardName`).

**Channel convention:**

- `#inbox` — Raw human requests, cross-project ideas, and human ↔ Lead discussion.
- `#projects/<slug>` — Concrete, self-contained tasks for a specific repo (e.g., `#projects/example-app`).

**Task metadata:**

- Labels:
  - `machine=<name>` (or `machine=any`, `os=macos|linux`) — routes the task to a matching host dispatcher.
  - `agent=claude` (default) or `agent=agy` — selects the worker CLI profile from `workerDefaults.agents` in `config/swarm.json`.
  - Optional overrides: `model=<model>`, `effort=low|medium|high|xhigh|max`, `kind=bug|feature|chore`.
- Dependencies: `--needs <task_id>` to sequence cross-project or review tasks automatically.
- Identities: `--as <name>` or `BOARD_PROFILE=<name>` env var (`lead`, `worker-<machine>-<taskId>`).

### 2. Board Inspector UI (`main-machine`)

Runs `board inspect --port 4747 --no-open --allow-host <host>...` (from `@vercel/board`, installed via `mise.toml`) as a `systemd --user` service (Linux) or `launchd` agent (macOS), bound to `127.0.0.1:4747`.

Optionally exposed to your private network / tailnet via Caddy (see `infra/caddy/board-snippet.Caddyfile`) or `tailscale serve`.

### 3. Lead Agent (`main-machine`)

- **Runtime:** Claude Code (`--model opus --effort high --permission-mode auto`) in a dedicated Herdr workspace (`~/swarm-hq`) on the main machine.
- **Env:** `BOARD_PROFILE=lead` (+ optional `VERCEL_SCOPE`).
- **Loop:** Blocks on `vercel board wait` for `#inbox`, `@lead` mentions, and `blocked` notifications.
- **Owns:** Triage, decomposition into `#projects/<slug>` tasks, dependency wiring (`--needs`), and unblocking workers within policy. Escalates human-only decisions to `board.humanHandle`.
- **Does NOT own:** Process spawning, lease renewal, or tab cleanup.

### 4. Worker Dispatcher (TypeScript / Node 24+)

Runs as a **per-machine daemon** locally on each worker machine (Linux or macOS). Talks directly to the local `herdr` socket, manages local `maxWorkers` slots, and claims ready tasks matching projects, OS/machine labels, and installed agent CLIs available on that host.

#### Per-Task Lifecycle

1. **Discover & Claim:** When `activeSlots < maxWorkers`, list ready tasks under `projects/` (`vercel board tasks projects/ --state all --json`), filter by machine/OS labels, installed agent binary, and repo availability (ensuring at most one active/parked plain-tab worker per project checkout at a time), and atomically claim the oldest eligible task with `vercel board tasks claim <task_id> --as <workerProfile> --lease 15m --json`.
2. **Lease heartbeat (critical):** The **dispatcher** runs `vercel board tasks renew <task_id> --as <workerProfile> --lease 15m` every 5 minutes while the worker is alive. Never rely on the LLM to remember renewals.
3. **Spawn in Herdr:**
   - Look up `project` in `config/projects.json` → resolve local repo path for this machine.
   - Resolve worker agent profile from task label `agent=<name>` (defaults to `workerDefaults.defaultAgent`, i.e., `claude`, or `agy` when requested) plus optional `model=` / `effort=` overrides.
   - **Plain tab mode (default):**
     - Find or create a workspace for `<project>`, then `herdr tab create --workspace <wsId> --cwd <repoPath> --label "task-<taskId> (<agent>)" --env BOARD_PROFILE=<workerProfile> --no-focus`.
   - **Optional worktree mode (`useWorktree: true`):**
     - `herdr worktree create --cwd <repoPath> --branch task/<taskId> --base <baseBranch> --label "task-<taskId> (<agent>)" --no-focus` and export `BOARD_PROFILE` / `VERCEL_SCOPE` in the pane before starting the agent.
   - Start the selected agent via `herdr agent start <agentName> --kind <claude|agy> --pane <paneId> -- <args...>`:
     - `claude`: `--model <model> --effort <effort> --permission-mode auto`
     - `agy`: `--effort <effort> --mode auto` (+ `--model <model>` when configured, otherwise `agy`'s default model)
   - Deliver rendered `prompts/worker-prompt.md` via `herdr agent prompt`.
4. **Monitor & Cleanup:**
   - Poll Board task state + `herdr tab list` + `herdr agent list`:
   - **`completed` / `canceled`:** Close the Herdr tab (`herdr tab close <tabId>`) (or remove temporary worktree in worktree mode), stop lease renewal, free the slot and repo lock.
   - **`blocked` (Board state OR Herdr `blocked` UI state):**
     - **Keep the tab open** and rename it `[BLOCKED] task-<taskId> (<agent>)` so Sheprd highlights it.
     - Post a short note on the Board thread pointing to `<machine> / <project> / tab`.
     - If Board task is `blocked`, park the tab (subject to `maxParkedTabs` cap) and free the active compute slot. Closing the tab manually in Sheprd automatically frees the parked slot and repo lock.
   - **`failed` / unexpected exit:** Keep tab open as `[FAILED] task-<taskId> (<agent>)`, post tail of `herdr pane read` to the Board thread, fail the task if still claimed, stop lease renewal, free the slot.

---

## Operational Gotchas

1. **Lease TTL:** Always renew in the TypeScript dispatcher loop, never in the LLM prompt.
2. **Shared repo checkouts in plain-tab mode:** The Dispatcher enforces a per-repo lock across active and parked plain-tab workers so two tasks never mutate the same working tree simultaneously. Enable `useWorktree: true` per project if you need parallel tasks on the same repository.
3. **Host header protection on `board inspect`:** When reverse-proxying `board inspect`, pass `--allow-host <host>` for every hostname/port used by clients (handled automatically by `scripts/apply-main.ts` from `machines.<main>.allowedHosts`).
4. **Non-interactive PATH:** `systemd --user` and macOS `launchd` do not load interactive shell profiles. Point services at `mise` shims (`~/.local/share/mise/shims`) or invoke `mise exec -- ...`.
5. **Herdr ID scoping:** Pane/tab/workspace IDs (`w1:p1`) and agent names are unique _per Herdr server_, not globally across SSH machines.
