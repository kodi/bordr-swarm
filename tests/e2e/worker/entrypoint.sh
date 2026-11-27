#!/usr/bin/env bash
set -euo pipefail

MACHINE="${SWARM_MACHINE:-worker-1}"
WORKER_RUNTIME="${SWARM_RUNTIME:-herdr}"
STATE_DIR="/var/lib/swarm"
REPOS_DIR="${STATE_DIR}/repos"
DEMO_REPO_DIR="${REPOS_DIR}/demo-app"
REVIEWED_REPO_DIR="${REPOS_DIR}/reviewed-app"
WORKTREE_REPO_DIR="${REPOS_DIR}/worktree-app"
CONFIG_DIR="${STATE_DIR}/config"
mkdir -p "$DEMO_REPO_DIR" "$REVIEWED_REPO_DIR" "$WORKTREE_REPO_DIR" "$CONFIG_DIR"

seed_repo() {
  local repo_dir="$1"
  local repo_name="$2"
  if [ ! -d "${repo_dir}/.git" ]; then
    git -C "$repo_dir" init -b main
    git -C "$repo_dir" config user.name "Swarm Test"
    git -C "$repo_dir" config user.email "swarm-test@example.com"
    printf '# %s\n' "$repo_name" > "${repo_dir}/README.md"
    git -C "$repo_dir" add README.md
    git -C "$repo_dir" commit -m "chore: initial commit"
  fi
}

# Seed real local Git repositories inside the worker container if not already initialized.
seed_repo "$DEMO_REPO_DIR" "demo-app"
seed_repo "$REVIEWED_REPO_DIR" "reviewed-app"
seed_repo "$WORKTREE_REPO_DIR" "worktree-app"

if [ "$WORKER_RUNTIME" = "rex" ]; then
  RUNTIME_JSON='{ "kind": "rex" }'
else
  RUNTIME_JSON='{ "kind": "herdr", "target": "local" }'
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
    "startupTimeoutSeconds": ${SWARM_STARTUP_TIMEOUT_SECONDS:-20},
    "closeTabOnComplete": true,
    "keepTabOnBlockedOrFailed": true
  },
  "machines": {
    "${MACHINE}": {
      "role": "worker",
      "os": "linux",
      "hostname": "${MACHINE}",
      "runtime": ${RUNTIME_JSON},
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
        "${MACHINE}": "${DEMO_REPO_DIR}"
      }
    },
    "reviewed-app": {
      "defaultMachine": "any",
      "baseBranch": "main",
      "reviewer": {
        "enabled": true,
        "agent": "claude",
        "maxRounds": 2,
        "skipIfNoDiff": true
      },
      "paths": {
        "${MACHINE}": "${REVIEWED_REPO_DIR}"
      }
    },
    "worktree-app": {
      "defaultMachine": "any",
      "baseBranch": "main",
      "useWorktree": true,
      "paths": {
        "${MACHINE}": "${WORKTREE_REPO_DIR}"
      }
    }
  }
}
EOF

HERDR_PID=""
if [ "$WORKER_RUNTIME" = "rex" ]; then
  if [ -f "${STATE_DIR}/.reset-rex" ]; then
    rex server stop >/dev/null 2>&1 || true
    rm -rf /root/.local/state/rex "${STATE_DIR}/.reset-rex"
  fi
  rex server start >/tmp/rex-server.log 2>&1
  for _ in $(seq 1 60); do
    if rex whoami --json >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  rex whoami --json >/dev/null 2>&1 || {
    echo "[worker-entrypoint] rex server failed to start:" >&2
    cat /tmp/rex-server.log >&2 || true
    exit 1
  }
else
  # Clear Herdr session state on startup when requested by the test harness (avoids Herdr
  # flushing a stale session.json on container shutdown and resurrecting tabs on boot).
  if [ -f "${STATE_DIR}/.reset-herdr" ]; then
    rm -rf /root/.config/herdr/session.json /root/.config/herdr/session-snapshots "${STATE_DIR}/.reset-herdr"
  fi

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
fi

export SWARM_CONFIG_PATH="${CONFIG_DIR}/swarm.json"
export PROJECTS_CONFIG_PATH="${CONFIG_DIR}/projects.json"
export DISPATCHER_STATE_PATH="${STATE_DIR}/dispatcher-${MACHINE}.json"

# Persist dispatcher env so `dispatcher-ctl start` from `docker compose exec` inherits identical settings.
cat > /tmp/dispatcher.env <<EOF
export SWARM_MACHINE='${MACHINE}'
export SWARM_RUNTIME='${WORKER_RUNTIME}'
export SWARM_CONFIG_PATH='${SWARM_CONFIG_PATH}'
export PROJECTS_CONFIG_PATH='${PROJECTS_CONFIG_PATH}'
export DISPATCHER_STATE_PATH='${DISPATCHER_STATE_PATH}'
export BOARD_URL='${BOARD_URL}'
export BOARD_TOKEN='${BOARD_TOKEN:-}'
export BOARD_CLI_BIN='${BOARD_CLI_BIN:-vb}'
EOF

# Stream dispatcher logs to container stdout across independent dispatcher restarts.
touch /tmp/dispatcher.log
tail -n 0 -F /tmp/dispatcher.log &
TAIL_PID=$!

/usr/local/bin/dispatcher-ctl start

shutdown() {
  /usr/local/bin/dispatcher-ctl stop || true
  if [ "$WORKER_RUNTIME" = "rex" ]; then
    rex server stop >/dev/null 2>&1 || true
  elif [ -n "$HERDR_PID" ]; then
    kill "$HERDR_PID" 2>/dev/null || true
    wait "$HERDR_PID" 2>/dev/null || true
  fi
  kill "$TAIL_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# Keep PID 1 alive so tests can stop/restart only `dispatcher.ts` while the terminal server stays up.
while true; do
  sleep 3600 &
  wait $! || true
done
