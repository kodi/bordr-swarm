# Worker Machine Setup Guide

A **worker machine** (macOS or Linux) runs **Herdr**, optional **Sheprd**, and the local **Worker Dispatcher** daemon that claims tasks from Vercel Board and spawns ephemeral coding agents (`claude` by default, or `agy` when labeled `agent=agy`).

## 1. Install Tools & Auth

```bash
git clone https://github.com/kodi/bordr-swarm.git ~/projects/bordr-swarm
cd ~/projects/bordr-swarm

# Install mise-managed Node, Vercel CLI, @vercel/board, and the vercel/board agent skill
./scripts/bootstrap.sh

# Authenticate Vercel CLI (one-time)
mise exec -- vercel login

# Verify all tools, Board auth, Herdr server, and configs in one command
mise run doctor
```

> **PATH note:** If an older `vercel` binary exists in npm/pnpm global bins, make sure `mise` shims come first in `PATH` (`~/.local/share/mise/shims`) and confirm `vercel --version` is `>= 66.6.0`.

## 2. Configure Local Swarm Files

```bash
cp config/swarm.example.json config/swarm.json
cp config/projects.example.json config/projects.json
```

In `config/swarm.json`:

- Define your worker machine under `machines` with `os` (`"macos"` or `"linux"`), `hostname`, `maxWorkers` (e.g. `2`), and optional custom `labels`.
- Customize `workerDefaults.agents` if you want to adjust default models/efforts/flags for `claude`, `agy`, or additional Herdr-supported agent CLIs.

In `config/projects.json`:

- Map each project slug (`#projects/<slug>`) to its local repository checkout path on each machine.

Run preflight checks:

```bash
mise run doctor
```

## 3. Running the Worker Dispatcher

- **Dry-run / development test:**
  ```bash
  node src/dispatcher.ts --once --dry-run
  ```
- **Foreground in a Herdr tab (live logs):**
  ```bash
  mise run dispatcher
  ```
- **Always-on background service (macOS `launchd` or Linux `systemd --user`):**
  ```bash
  # Preview first
  node scripts/apply-worker.ts --dry-run

  # Install & start
  mise run apply:worker

  # Uninstall later if needed
  node scripts/apply-worker.ts --unload
  ```

## 4. Routing Tasks to Specific Workers or Agents

Create tasks under `#projects/<slug>` with optional routing labels:

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
  sheprd browser open http://<main-hostname>:4748
  ```
- Completed worker tabs close automatically; any worker tab remaining open in Sheprd is either actively working or `[BLOCKED]` / `[FAILED]` waiting for human review. Closing a parked tab in Sheprd automatically frees the parked slot and plain-tab repo lock.
