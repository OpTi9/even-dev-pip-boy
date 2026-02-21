#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$ROOT_DIR/.codexstack"
LOG_DIR="$STATE_DIR/logs"
VITE_BIN="$ROOT_DIR/node_modules/.bin/vite"

CODEX_TS_HOST="${CODEX_TS_HOST:-aza-hp-elitebook.tail6c15d9.ts.net}"
CODEX_VITE_PORT="${CODEX_VITE_PORT:-5175}"
CODEX_APP_SERVER_HOST="${CODEX_APP_SERVER_HOST:-0.0.0.0}"
CODEX_APP_SERVER_PORT="${CODEX_APP_SERVER_PORT:-9999}"
CODEX_ALLOWED_HOSTS="${CODEX_ALLOWED_HOSTS:-$CODEX_TS_HOST}"
CODEX_KEEP_EXISTING="${CODEX_KEEP_EXISTING:-0}"
CODEX_APP_SERVER_RUST_LOG="${CODEX_APP_SERVER_RUST_LOG:-warn}"
CODEX_APPROVAL_POLICY="${CODEX_APPROVAL_POLICY:-never}"
CODEX_SANDBOX_MODE="${CODEX_SANDBOX_MODE:-danger-full-access}"

APP_SERVER_PID_FILE="$STATE_DIR/app-server.pid"
VITE_PID_FILE="$STATE_DIR/vite.pid"
APP_SERVER_URL="ws://${CODEX_APP_SERVER_HOST}:${CODEX_APP_SERVER_PORT}"

mkdir -p "$LOG_DIR"

is_running() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

read_pid() {
  local file="$1"
  if [ -f "$file" ]; then
    tr -d '[:space:]' < "$file"
  fi
}

find_app_server_pid() {
  local pid args pids

  for pid in $(pgrep -f "app-server" 2>/dev/null || true); do
    args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    if [ -z "$args" ]; then
      continue
    fi

    if [[ "$args" == *"$APP_SERVER_URL"* ]] && { [[ "$args" == *"codex app-server"* ]] || [[ "$args" == *"codex-app-server"* ]]; }; then
      echo "$pid"
      return 0
    fi
  done

  # Fallback: discover by listening port. Some codex wrappers may re-parent/fork
  # and not preserve the original command-line shape.
  pids="$(lsof -ti ":${CODEX_APP_SERVER_PORT}" 2>/dev/null || true)"
  for pid in $pids; do
    args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    if [ -z "$args" ]; then
      continue
    fi
    if [[ "$args" == *"codex"* ]] || [[ "$args" == *"app-server"* ]]; then
      echo "$pid"
      return 0
    fi
  done

  return 1
}

adopt_existing_app_server_pid() {
  local pid
  pid="$(find_app_server_pid || true)"
  if [ -n "${pid:-}" ] && is_running "$pid"; then
    echo "$pid" > "$APP_SERVER_PID_FILE"
    return 0
  fi
  return 1
}

find_vite_pid_for_port() {
  local pid args pids

  for pid in $(pgrep -f "$ROOT_DIR/node_modules/.bin/vite" 2>/dev/null || true); do
    args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    if [ -n "$args" ] && [[ "$args" == *"--port $CODEX_VITE_PORT"* ]]; then
      echo "$pid"
      return 0
    fi
  done

  pids="$(lsof -ti ":${CODEX_VITE_PORT}" 2>/dev/null || true)"
  for pid in $pids; do
    args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    if [ -n "$args" ] && [[ "$args" == *"vite"* ]]; then
      echo "$pid"
      return 0
    fi
  done

  return 1
}

adopt_existing_vite_pid() {
  local pid
  pid="$(find_vite_pid_for_port || true)"
  if [ -n "${pid:-}" ] && is_running "$pid"; then
    echo "$pid" > "$VITE_PID_FILE"
    return 0
  fi
  return 1
}

stop_pid() {
  local file="$1"
  local name="$2"
  local pid

  pid="$(read_pid "$file" || true)"
  if [ -z "${pid:-}" ]; then
    echo "$name not running (no pid file)"
    return
  fi

  if ! is_running "$pid"; then
    echo "$name not running (stale pid $pid)"
    rm -f "$file"
    return
  fi

  kill "$pid" 2>/dev/null || true
  sleep 1
  if is_running "$pid"; then
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$file"
  echo "Stopped $name (PID $pid)"
}

stop_conflicting_processes() {
  if [ "$CODEX_KEEP_EXISTING" = "1" ]; then
    return
  fi

  local app_server_pid vite_pid

  app_server_pid="$(find_app_server_pid || true)"
  if [ -n "${app_server_pid:-}" ] && is_running "$app_server_pid"; then
    kill "$app_server_pid" 2>/dev/null || true
    sleep 1
    if is_running "$app_server_pid"; then
      kill -9 "$app_server_pid" 2>/dev/null || true
    fi
  fi

  vite_pid="$(find_vite_pid_for_port || true)"
  if [ -n "${vite_pid:-}" ] && is_running "$vite_pid"; then
    kill "$vite_pid" 2>/dev/null || true
    sleep 1
    if is_running "$vite_pid"; then
      kill -9 "$vite_pid" 2>/dev/null || true
    fi
  fi

  rm -f "$APP_SERVER_PID_FILE" "$VITE_PID_FILE"
}

start_app_server() {
  local existing_pid
  existing_pid="$(read_pid "$APP_SERVER_PID_FILE" || true)"
  if [ -n "${existing_pid:-}" ] && is_running "$existing_pid"; then
    echo "app-server already running (PID $existing_pid)"
    return
  fi

  if adopt_existing_app_server_pid; then
    existing_pid="$(read_pid "$APP_SERVER_PID_FILE")"
    echo "app-server already running (PID $existing_pid)"
    return
  fi

  echo "Starting codex app-server on $APP_SERVER_URL"

  if [ -n "${CODEX_APP_SERVER_CMD:-}" ]; then
    (
      cd "$ROOT_DIR"
      RUST_LOG="$CODEX_APP_SERVER_RUST_LOG" \
      bash -lc "$CODEX_APP_SERVER_CMD --listen $APP_SERVER_URL" >> "$LOG_DIR/app-server.log" 2>&1
    ) &
  elif command -v codex >/dev/null 2>&1; then
    (
      cd "$ROOT_DIR"
      RUST_LOG="$CODEX_APP_SERVER_RUST_LOG" \
      codex app-server --listen "$APP_SERVER_URL" >> "$LOG_DIR/app-server.log" 2>&1
    ) &
  elif command -v codex-app-server >/dev/null 2>&1; then
    (
      cd "$ROOT_DIR"
      RUST_LOG="$CODEX_APP_SERVER_RUST_LOG" \
      codex-app-server --listen "$APP_SERVER_URL" >> "$LOG_DIR/app-server.log" 2>&1
    ) &
  else
    echo "Could not find 'codex' or 'codex-app-server' in PATH."
    echo "Set CODEX_APP_SERVER_CMD to the command to start your app-server, for example:"
    echo "  CODEX_APP_SERVER_CMD='codex app-server' npm run codex:up"
    return 1
  fi

  local pid="$!"
  echo "$pid" > "$APP_SERVER_PID_FILE"
  sleep 2

  if adopt_existing_app_server_pid; then
    existing_pid="$(read_pid "$APP_SERVER_PID_FILE")"
    echo "app-server running (PID $existing_pid)"
    return
  fi

  if ! is_running "$pid"; then
    echo "app-server failed to start. Check $LOG_DIR/app-server.log"
    tail -n 80 "$LOG_DIR/app-server.log" || true
    return 1
  fi

  echo "app-server running (PID $pid)"
}

start_vite() {
  local existing_pid
  existing_pid="$(read_pid "$VITE_PID_FILE" || true)"
  if [ -n "${existing_pid:-}" ] && is_running "$existing_pid"; then
    echo "vite already running (PID $existing_pid)"
    return
  fi

  if adopt_existing_vite_pid; then
    existing_pid="$(read_pid "$VITE_PID_FILE")"
    echo "vite already running on port $CODEX_VITE_PORT (PID $existing_pid)"
    return
  fi

  if [ ! -x "$VITE_BIN" ]; then
    echo "Vite binary not found at $VITE_BIN"
    echo "Run 'npm install' in $ROOT_DIR."
    return 1
  fi

  echo "Starting Vite codex app on port $CODEX_VITE_PORT"
  (
    cd "$ROOT_DIR"
    VITE_APP_NAME=codex \
    VITE_HOST=0.0.0.0 \
    VITE_ALLOWED_HOSTS="$CODEX_ALLOWED_HOSTS" \
    VITE_CODEX_WS_PORT="$CODEX_APP_SERVER_PORT" \
    VITE_CODEX_APPROVAL_POLICY="$CODEX_APPROVAL_POLICY" \
    VITE_CODEX_SANDBOX_MODE="$CODEX_SANDBOX_MODE" \
    CODEX_APP_SERVER_URL="$APP_SERVER_URL" \
    "$VITE_BIN" --host 0.0.0.0 --strictPort --port "$CODEX_VITE_PORT" >> "$LOG_DIR/vite.log" 2>&1
  ) &

  local pid="$!"
  echo "$pid" > "$VITE_PID_FILE"
  sleep 2

  if adopt_existing_vite_pid; then
    existing_pid="$(read_pid "$VITE_PID_FILE")"
    echo "vite running (PID $existing_pid)"
    return
  fi

  if ! is_running "$pid"; then
    echo "vite failed to start. Check $LOG_DIR/vite.log"
    tail -n 80 "$LOG_DIR/vite.log" || true
    return 1
  fi

  echo "vite running (PID $pid)"
}

show_status() {
  local app_server_pid vite_pid

  app_server_pid="$(read_pid "$APP_SERVER_PID_FILE" || true)"
  vite_pid="$(read_pid "$VITE_PID_FILE" || true)"

  if [ -z "${app_server_pid:-}" ] || ! is_running "$app_server_pid"; then
    adopt_existing_app_server_pid || true
    app_server_pid="$(read_pid "$APP_SERVER_PID_FILE" || true)"
  fi

  if [ -z "${vite_pid:-}" ] || ! is_running "$vite_pid"; then
    adopt_existing_vite_pid || true
    vite_pid="$(read_pid "$VITE_PID_FILE" || true)"
  fi

  if [ -n "${app_server_pid:-}" ] && is_running "$app_server_pid"; then
    echo "app-server: running (PID $app_server_pid) on $APP_SERVER_URL"
  else
    echo "app-server: stopped"
  fi

  if [ -n "${vite_pid:-}" ] && is_running "$vite_pid"; then
    echo "vite: running (PID $vite_pid) on port $CODEX_VITE_PORT"
  else
    echo "vite: stopped"
  fi

  echo "qr_url_base: http://${CODEX_TS_HOST}:${CODEX_VITE_PORT}/"
  echo "codex_ws_url: ws://${CODEX_TS_HOST}:${CODEX_APP_SERVER_PORT}/"
}

show_qr() {
  local cache_buster url
  cache_buster="$(date +%s)"
  url="http://${CODEX_TS_HOST}:${CODEX_VITE_PORT}/?v=${cache_buster}"
  echo "Generating QR for $url"
  npx @evenrealities/evenhub-cli qr --url "$url"
}

show_logs() {
  echo "app-server log: $LOG_DIR/app-server.log"
  echo "vite log:       $LOG_DIR/vite.log"
  tail -n 60 "$LOG_DIR/app-server.log" || true
  echo "----"
  tail -n 80 "$LOG_DIR/vite.log" || true
}

up_stack() {
  local with_qr="true"
  if [ "${1:-}" = "--no-qr" ]; then
    with_qr="false"
  fi

  : > "$LOG_DIR/app-server.log"
  : > "$LOG_DIR/vite.log"

  stop_conflicting_processes

  if ! start_app_server; then
    return 1
  fi

  if ! start_vite; then
    stop_pid "$APP_SERVER_PID_FILE" "app-server" || true
    return 1
  fi

  show_status

  if [ "$with_qr" = "true" ]; then
    show_qr
  else
    echo "Run './start-codex-stack.sh qr' when you need a QR."
  fi
}

down_stack() {
  stop_pid "$APP_SERVER_PID_FILE" "app-server"
  stop_pid "$VITE_PID_FILE" "vite"
}

usage() {
  cat <<'USAGE'
Usage:
  ./start-codex-stack.sh up [--no-qr]   Start codex app-server + vite, optionally show QR (default: show QR)
  ./start-codex-stack.sh down           Stop app-server + vite started by this script
  ./start-codex-stack.sh restart        Restart both services and show QR
  ./start-codex-stack.sh status         Show process and URL status
  ./start-codex-stack.sh qr             Show QR only
  ./start-codex-stack.sh logs           Tail recent app-server + vite logs

Environment overrides:
  CODEX_TS_HOST, CODEX_VITE_PORT, CODEX_APP_SERVER_HOST, CODEX_APP_SERVER_PORT
  CODEX_ALLOWED_HOSTS, CODEX_KEEP_EXISTING, CODEX_APP_SERVER_CMD, CODEX_APP_SERVER_RUST_LOG
  CODEX_APPROVAL_POLICY, CODEX_SANDBOX_MODE
USAGE
}

case "${1:-}" in
  up)
    up_stack "${2:-}"
    ;;
  down)
    down_stack
    ;;
  restart)
    down_stack
    up_stack
    ;;
  status)
    show_status
    ;;
  qr)
    show_qr
    ;;
  logs)
    show_logs
    ;;
  *)
    usage
    exit 1
    ;;
esac
