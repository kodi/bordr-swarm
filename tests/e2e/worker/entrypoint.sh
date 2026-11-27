#!/usr/bin/env bash
set -euo pipefail

MACHINE="${SWARM_MACHINE:-worker-1}"
STATE_DIR="/var/lib/swarm"
REPO_DIR="${STATE_DIR}/repos/demo-app"
CONFIG_DIR="${STATE_DIR}/config"
mkdir -p "$REPO_DIR" "$CONFIG_DIR"

# Seed a real local Git repository inside the worker container if not already initialized.
if [ ! -d "${REPO_DIR}/.git" ]; then
  git -C "$REPO_DIR" init -b main
  git -C "$REPO_DIR" config user.name "Swarm Test"
  git -C "$REPO_DIR" config user.email "swarm-test@example.com"
  printf '# demo-app\n' > "${REPO_DIR}/README.md"
  git -C "$REPO_DIR" add README.md
  git -C "$REPO_DIR" commit -m "chore: initial commit"
fi

# Generate per-worker swarm.json and projects.json (fast polling for E2E speed).
cat > "${CONFIG_DIR}/swarm.json" <<EOF
{
  "board": {
    "url": "${BOARD_URL}",
    "humanHandle": "@owner",
    "leaseDuration": "${SWARM_LEASE_DURATION:-1m}",
    "leaseRenewIntervalSeconds": ${SWARM_LEASE_RENEW_SECONDS:-20}
  },
  "workerDefaults": {
    "defaultAgent": "claude",
    "pollIntervalSeconds": ${SWARM_POLL_INTERVAL_SECONDS:-3},
    "idleTimeoutSeconds": ${SWARM_IDLE_TIMEOUT_SECONDS:-10},
    "closeTabOnComplete": true,
    "keepTabOnBlockedOrFailed": true
  },
  "machines": {
    "${MACHINE}": {
      "role": "worker",
      "os": "linux",
      "hostname": "${MACHINE}",
      "herdrTarget": "local",
      "maxWorkers": ${SWARM_MAX_WORKERS:-2}
    }
  }
}
EOF

cat > "${CONFIG_DIR}/projects.json" <<EOF
{
  "projects": {
    "demo-app": {
      "defaultMachine": "any",
      "baseBranch": "main",
      "paths": {
        "${MACHINE}": "${REPO_DIR}"
      }
    }
  }
}
EOF

# Start real headless Herdr server in the background and wait for its Unix socket.
herdr server >/tmp/herdr-server.log 2>&1 &
HERDR_PID=$!

for _ in $(seq 1 60); do
  if herdr workspace list >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
herdr workspace list >/dev/null 2>&1 || {
  echo "[worker-entrypoint] herdr server failed to start:" >&2
  cat /tmp/herdr-server.log >&2 || true
  exit 1
}

export SWARM_CONFIG_PATH="${CONFIG_DIR}/swarm.json"
export PROJECTS_CONFIG_PATH="${CONFIG_DIR}/projects.json"
export DISPATCHER_STATE_PATH="${STATE_DIR}/dispatcher-${MACHINE}.json"

# Forward signals cleanly to dispatcher so graceful-stop persistence is exercised on `docker compose stop`.
exec node /workspace/src/dispatcher.ts --machine "${MACHINE}"
