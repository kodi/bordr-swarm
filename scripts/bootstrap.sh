#!/usr/bin/env bash
set -euo pipefail

# Idempotent machine bootstrap for bordr-swarm.
# Works on Linux (main or worker machine) and macOS (main or worker machine).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v mise >/dev/null 2>&1; then
  echo "[bootstrap] Installing mise..."
  curl -fsSL https://mise.run | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "[bootstrap] Trusting and installing mise tools (node, vercel, @vercel/board)..."
mise trust "$REPO_ROOT/mise.toml"
mise install

echo "[bootstrap] Installing npm dependencies (zod, TypeScript 7, oxlint, oxfmt, lefthook)..."
mise exec -- npm install

echo "[bootstrap] Installing vercel/board agent skill..."
mise exec -- npx -y skills add vercel/board

if [[ ! -f config/swarm.json ]]; then
  echo "[bootstrap] Note: copy config/swarm.example.json -> config/swarm.json"
fi
if [[ ! -f config/projects.json ]]; then
  echo "[bootstrap] Note: copy config/projects.example.json -> config/projects.json"
fi

echo "[bootstrap] Done! Next steps:"
echo "  1. vercel login (if not already authenticated)"
echo "  2. Edit config/swarm.json and config/projects.json"
echo "  3. mise run doctor"
