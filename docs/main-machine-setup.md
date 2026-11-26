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
2. Creates/updates `lead.workspaceDir` (default `~/swarm-hq`) with rendered `CLAUDE.md` and a symlink to `config/projects.json`.
3. Optionally starts the Lead agent in Herdr when passed `--start-lead`.

```bash
# Preview changes first
node scripts/apply-main.ts --dry-run --start-lead

# Apply and start Board UI + Lead agent
node scripts/apply-main.ts --start-lead
```

Verify locally:

```bash
curl -I http://127.0.0.1:4747
```

## 4. Optional: Expose Board UI Over Tailscale / Private Network

`board inspect` binds to `127.0.0.1:4747` by default. To access it from other devices (or inside Sheprd on another machine):

1. Reverse-proxy `127.0.0.1:4747` using Caddy (see [infra/caddy/board-snippet.Caddyfile](../infra/caddy/board-snippet.Caddyfile)) or `tailscale serve`.
2. Restrict firewall rules on the proxy port (e.g. `4748/tcp`) strictly to your private/Tailscale interface (`tailscale0`) — never expose `board inspect` to the public internet, since anyone reaching it acts with your Vercel Board credentials.
3. Make sure every hostname/port used to access the proxy is listed in `machines.<main>.allowedHosts` in `config/swarm.json`, then re-run `mise run apply:main`.
4. Open the Board UI in your browser or inside Sheprd:
   ```bash
   sheprd browser open http://<main-hostname>:4748
   ```
