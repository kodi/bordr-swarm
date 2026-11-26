# Main Machine Setup Guide

The **main machine** (e.g. an always-on Linux box or macOS host) runs the **Vercel Board Inspector UI** and the **Lead Agent**.

Machine names, OS (`"linux"` or `"macos"`), hostnames, and reverse-proxy `allowedHosts` are all configured declaratively in `config/swarm.json`.

## 1. Install Tools & Auth

```bash
git clone https://github.com/kodi/bordr-swarm.git ~/bordr-swarm
cd ~/bordr-swarm

# Install mise-managed Node, Vercel CLI, @vercel/board, and the vercel/board agent skill
./scripts/bootstrap.sh

# Authenticate Vercel CLI (one-time)
mise exec -- vercel login

# Verify all tools, Board auth, Herdr server, and configs in one command
mise run doctor
```

> **Linux security tip:** Run agent services under a dedicated unprivileged user (e.g. `agent` or `work`, with `loginctl enable-linger <user>` so `systemd --user` services persist across reboots). Never grant that user `sudo` or `docker` group membership.

## 2. Configure Local Swarm Files

```bash
cp config/swarm.example.json config/swarm.json
cp config/projects.example.json config/projects.json
```

In `config/swarm.json`:

- Set `lead.machine` to your main machine's key (default `"main-machine"`, or rename it to match your host).
- Set `machines.<name>.os` to `"linux"` or `"macos"`, plus `hostname` and `allowedHosts` (any hostname / Tailscale MagicDNS / IP:port you use to access the Board UI through a reverse proxy).
- Set `board.humanHandle` to your handle (e.g. `"@alice"`) for escalations.

Run preflight checks:

```bash
mise run doctor
```

## 3. Apply Main Machine Services

`mise run apply:main` idempotently:

1. Installs and enables the Board Inspector UI background service (`systemd --user` on Linux, `launchd` on macOS) with `--allow-host` populated from `config/swarm.json`.
2. Installs and enables the deterministic **Lead Watcher** service (`bordr-lead-watcher.service` on Linux, `dev.swarm.lead-watcher` on macOS) that watches `#inbox`, `@lead` mentions, and `blocked` tasks with **0 idle LLM tokens** and wakes Lead in Herdr only when real events arrive.
3. Creates/updates `lead.workspaceDir` (default `~/swarm-hq`) with rendered `CLAUDE.md` and a symlink to `config/projects.json`.
4. Optionally pre-starts the Lead agent in Herdr when passed `--start-lead` (recommended on first run so you can approve Claude's one-time folder-trust prompt in Sheprd).

```bash
# Preview changes first
mise run apply:main -- --dry-run

# Apply everything (Board UI + Lead Watcher + Lead agent)
mise run apply:main

# Check service status, Board UI health, and live Herdr agents
mise run status

# View logs (lead-watcher or ui; add -f to follow)
mise run logs lead-watcher
mise run logs ui
```

## 4. Optional: Expose Board UI Over Tailscale (HTTPS Recommended)

`board inspect` binds to `127.0.0.1:4747` by default. Because its web UI uses `crypto.randomUUID()`, browsers require a **Secure Context** (`https://` or `http://localhost`) to post messages — plain `http://<hostname>:4748` is read-only in modern browsers.

The cleanest way to expose it privately over HTTPS is **`tailscale serve`** (zero public exposure, automatic Let's Encrypt cert):

1. Check your Tailscale MagicDNS hostname (`tailscale status --json | jq -r .Self.DNSName`, e.g. `main-machine.your-tailnet.ts.net`).
2. Add that hostname and `hostname:4748` to `machines.<main>.allowedHosts` in `config/swarm.json` (and update `board.viewerUrl`), then run `mise run apply:main`.
3. Enable `tailscale serve`:
   ```bash
   sudo tailscale serve --bg --https=4748 http://127.0.0.1:4747
   ```
4. Open the Board UI in your browser or inside Sheprd:
   ```bash
   sheprd browser open https://<main-machine>.<tailnet>.ts.net:4748
   ```

_(If you prefer Caddy instead of `tailscale serve`, configure TLS on your private network and see [infra/caddy/board-snippet.Caddyfile](../infra/caddy/board-snippet.Caddyfile). Never expose `board inspect` to the public internet, since anyone reaching it acts with your Vercel Board credentials.)_
