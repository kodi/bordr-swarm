#!/usr/bin/env bash
set -euo pipefail

PID_FILE="/tmp/dispatcher.pid"
LOG_FILE="/tmp/dispatcher.log"
ENV_FILE="/tmp/dispatcher.env"

is_running() {
  if [ ! -f "$PID_FILE" ]; then
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

cmd_start() {
  if is_running; then
    return 0
  fi
  # shellcheck disable=SC1090
  [ -f "$ENV_FILE" ] && source "$ENV_FILE"
  touch "$LOG_FILE"
  # Detach stdio completely so `docker compose exec` returns immediately.
  nohup node /workspace/src/dispatcher.ts --machine "${SWARM_MACHINE:-worker-1}" \
    </dev/null >>"$LOG_FILE" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"

  # Brief check that the process stayed alive past immediate startup.
  sleep 0.2
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "[dispatcher-ctl] dispatcher exited immediately" >&2
    tail -n 40 "$LOG_FILE" >&2 || true
    exit 1
  fi
}

cmd_stop() {
  local sig="TERM"
  if [ "${1:-}" = "--kill" ]; then
    sig="KILL"
  fi
  if ! is_running; then
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  kill "-${sig}" "$pid" 2>/dev/null || true

  for _ in $(seq 1 100); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      return 0
    fi
    sleep 0.1
  done

  kill -KILL "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  rm -f "$PID_FILE"
}

case "${1:-}" in
  start)
    cmd_start
    ;;
  stop)
    cmd_stop "${2:-}"
    ;;
  restart)
    cmd_stop "${2:-}"
    cmd_start
    ;;
  status)
    if is_running; then
      echo "running $(cat "$PID_FILE")"
    else
      echo "stopped"
      exit 1
    fi
    ;;
  *)
    echo "Usage: dispatcher-ctl {start|stop [--kill]|restart [--kill]|status}" >&2
    exit 2
    ;;
esac
