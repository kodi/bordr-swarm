#!/usr/bin/env bash
set -euo pipefail

# Idempotent machine bootstrap for bordr-swarm.
# Works on Linux (main, worker, or both) and macOS (main, worker, or both).

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

echo ""
echo "[bootstrap] Done! Next steps:"
if [[ ! -f config/swarm.json ]]; then
  echo "  1. mise run init     # Interactive setup wizard (auth, minimal config, and service install)"
  echo "  2. mise run doctor   # Optional preflight check"
else
  echo "  1. mise run doctor   # Verify tools, auth, and Herdr"
  echo "  2. mise run apply    # Apply & start services for this machine's role"
fi
