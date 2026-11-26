# Main Machine Setup Guide

The **main machine** (e.g. an always-on Linux box or macOS host) runs the **Vercel Board Inspector UI**, the **Lead Watcher** daemon, and the **Lead Agent**.

> **Just trying it on one computer?** You don't need a separate main box — run `mise run init` and choose role **`both`** to run Main + Worker on the same machine at `http://127.0.0.1:4747`.

## 1. Install Tools & Run Setup Wizard

```bash
git clone https://github.com/kodi/bordr-swarm.git ~/bordr-swarm
cd ~/bordr-swarm

# Install mise-managed Node, Vercel CLI, @vercel/board, and the vercel/board agent skill
./scripts/bootstrap.sh

# Interactive setup: authenticates Vercel CLI, detects Tailscale/OS/handle,
# writes minimal config/swarm.json, and offers to apply services immediately
mise run init
```

Choose role **`main`** (or **`both`** if this machine will also execute worker tasks).

> **Linux security tip:** Run agent services under a dedicated unprivileged user (e.g. `agent` or `work`, with `sudo loginctl enable-linger <user>` so `systemd --user` services persist across SSH logouts). Never grant that user `sudo` or `docker` group membership. `mise run doctor` checks linger status automatically.

## 2. Verify & Apply Services

If you skipped applying during `mise run init` (or edited `config/swarm.json` later):

```bash
# Verify tools, auth, Herdr server, systemd linger, and Tailscale
mise run doctor

# Preview or apply all services for this machine's role
mise run apply -- --dry-run
mise run apply

# Check service status, Board UI health, and live Herdr agents
mise run status

# View logs (lead-watcher or ui; add -f to follow)
mise run logs lead-watcher
mise run logs ui

# Upgrade @vercel/board & Vercel CLI and restart the Board UI service on demand
mise run ui:update
mise run ui:update -- --restart-only
```

`mise run apply` (via `apply:main`) idempotently:

1. Installs and enables the Board Inspector UI background service (`systemd --user` on Linux, `launchd` on macOS), automatically passing `--allow-host` for both `allowedHosts` and any detected Tailscale MagicDNS hostname.
2. Installs and enables the deterministic **Lead Watcher** service (`bordr-lead-watcher.service` on Linux, `dev.swarm.lead-watcher` on macOS) that watches `#inbox`, `@lead` mentions, and `blocked` tasks with **0 idle LLM tokens**, syncs `#swarm/registry` into `~/swarm-hq/projects.json`, and spawns **ephemeral per-thread Lead tabs** (`lead-<shortId>`) in Herdr on demand, auto-closing each tab once idle.
3. Creates/updates `lead.workspaceDir` (default `~/swarm-hq`) with rendered `CLAUDE.md` — you do **not** need a `config/projects.json` on a main-only host. Every new ephemeral Lead session automatically picks up the latest `CLAUDE.md` and `projects.json`.
4. Closes any legacy persistent `lead` tab left over from older versions (on first-ever run on a new host, if Claude prompts for `~/swarm-hq` folder trust when the first event arrives, Lead Watcher parks it as `[BLOCKED] lead-<shortId>` in **Sheprd** until you approve it once).

## 3. Optional: Expose Board UI Over Tailscale (HTTPS Recommended)

`board inspect` binds to `127.0.0.1:4747` by default. Because its web UI uses `crypto.randomUUID()`, browsers require a **Secure Context** (`https://` or `http://localhost`) to post messages — plain `http://<hostname>:4748` is read-only in modern browsers.

On a headless/remote main host, the cleanest way to expose it privately over HTTPS is **`tailscale serve`** (zero public exposure, automatic Let's Encrypt cert):

1. `apply:main` automatically detects your Tailscale MagicDNS FQDN (`<main-machine>.<tailnet>.ts.net`) and adds it to `--allow-host`.
2. Enable `tailscale serve` once (as an admin/sudo user):
   ```bash
   sudo tailscale serve --bg --https=4748 http://127.0.0.1:4747
   ```
3. Open the Board UI in your browser or inside Sheprd:
   ```bash
   sheprd browser open https://<main-machine>.<tailnet>.ts.net:4748
   ```

_(If you prefer Caddy instead of `tailscale serve`, configure TLS on your private network and see [infra/caddy/board-snippet.Caddyfile](../infra/caddy/board-snippet.Caddyfile). Never expose `board inspect` to the public internet, since anyone reaching it acts with your Vercel Board credentials.)_

## 4. Optional: Enable Read-Only GitHub Inspection for Lead (`gh`)

Worker machines automatically advertise each project's GitHub `owner/repo` in `#swarm/registry` (auto-detected from `origin` or set via `mise run project:add -- <path> --repo <owner/name>`), which Lead Watcher syncs into `~/swarm-hq/projects.json`.

If you install and authenticate the GitHub CLI on the main machine (`gh auth login`), Lead can run read-only `gh` commands on demand to inspect `README.md`, `AGENTS.md`, or repository files when an `#inbox` request is ambiguous—without cloning worker repos onto the main host. If `gh` is not installed, Lead falls back to outcome-level tickets cleanly.
