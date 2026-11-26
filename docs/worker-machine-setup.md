# Worker Machine Setup Guide

A **worker machine** (macOS or Linux) runs **Herdr**, optional **Sheprd**, and the local **Worker Dispatcher** daemon that claims tasks from Vercel Board and spawns ephemeral coding agents (`claude` by default, or `agy` when labeled `agent=agy`).

## 1. Install Tools & Run Setup Wizard

```bash
git clone https://github.com/kodi/bordr-swarm.git ~/projects/bordr-swarm
cd ~/projects/bordr-swarm

# Install mise-managed Node, Vercel CLI, @vercel/board, and the vercel/board agent skill
./scripts/bootstrap.sh

# Interactive setup: authenticates Vercel CLI, writes a minimal per-host config/swarm.json,
# optionally registers your first repo, and installs the Worker Dispatcher service
mise run init
```

Choose role **`worker`** (or **`both`** if this is a single-machine setup). A worker's `config/swarm.json` only needs to describe itself — you do not need to list other machines or manually copy `config/projects.example.json`.

> **PATH note:** If an older `vercel` binary exists in npm/pnpm global bins, make sure `mise` shims come first in `PATH` (`~/.local/share/mise/shims`) and confirm `vercel --version` is `>= 66.6.0` via `mise run doctor`.

## 2. Register Local Repositories

Add or remove local Git repos at any time with the 1-line CLI helper (no restart required):

```bash
# Register a local repo on this worker and auto-publish to #swarm/registry
mise run project:add -- ~/path/to/your-repo

# List or remove local repos on this worker
mise run project:ls
mise run project:rm -- your-repo
```

The Worker Dispatcher hot-reloads `config/projects.json` and auto-publishes this machine's capabilities and project slugs to **`#swarm/registry`** on Vercel Board (local filesystem paths stay private on the host). The main machine's Lead Watcher automatically syncs `#swarm/registry` into `~/swarm-hq/projects.json`.

You can also register the same project slug on **multiple worker machines** — Lead automatically sees all hosts that advertise it (`defaultMachine: "any"`) and workers can claim tasks in parallel or via `machine=<name>` / `os=<os>` labels.

## 3. Running & Managing the Worker Dispatcher

- **Apply / reload always-on background service (macOS `launchd` or Linux `systemd --user`):**
  ```bash
  mise run apply          # Role-aware apply (or `mise run apply:worker`)
  mise run status         # Verify dispatcher service and active Herdr agents
  mise run logs -- -f     # Tail dispatcher logs
  ```
- **Dry-run / development test:**
  ```bash
  node src/dispatcher.ts --once --dry-run
  ```
- **Foreground in a Herdr tab (live logs):**
  ```bash
  mise run dispatcher
  ```
- **Uninstall background service later:**
  ```bash
  node scripts/apply-worker.ts --unload
  ```

## 4. Routing Tasks to Specific Workers or Agents

Create tasks under `#projects/<slug>` with optional routing labels (or just ask Lead in `#inbox`):

```bash
# Default worker (claude opus medium, auto mode) on any matching machine
vercel board tasks create projects/example-app "Add health check endpoint"

# Target a specific worker machine
vercel board tasks create projects/example-app "Build macOS bundle" --label machine=worker-machine

# Target Antigravity CLI (agy) with its default model
vercel board tasks create projects/example-app "Refactor parser" --label agent=agy

# Target agy with an explicit model and high effort
vercel board tasks create projects/example-app "Audit auth flow" --label agent=agy --label effort=high
```

## 5. Monitoring in Sheprd

- Add your main machine and worker machines as saved SSH profiles in Herdr/Sheprd so all agents appear in one sidebar.
- Open the Board UI inside Sheprd:
  ```bash
  sheprd browser open https://<main-machine>.<tailnet>.ts.net:4748
  # (or http://127.0.0.1:4747 on a single-machine setup)
  ```
- Completed worker tabs close automatically; any worker tab remaining open in Sheprd is either actively working or `[BLOCKED]` / `[FAILED]` waiting for human review. Closing a parked tab in Sheprd automatically frees the parked slot and plain-tab repo lock.
