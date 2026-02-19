#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_SUBMODULE_PATH="services/claude-code-telegram"
BOT_DIR="$ROOT_DIR/$BOT_SUBMODULE_PATH"
STATE_DIR="$ROOT_DIR/.g2stack"
LOG_DIR="$STATE_DIR/logs"
BOT_PYTHON="$BOT_DIR/.venv/bin/python"
VITE_BIN="$ROOT_DIR/node_modules/.bin/vite"

G2_TS_HOST="${G2_TS_HOST:-aza-hp-elitebook.tail6c15d9.ts.net}"
G2_CALLBACK_HOST="${G2_CALLBACK_HOST:-127.0.0.1}"
G2_PORT="${G2_PORT:-5174}"
G2_BOT_PORT="${G2_BOT_PORT:-8080}"
G2_KEEP_EXISTING="${G2_KEEP_EXISTING:-0}"
G2_DEFAULT_WORKING_DIRECTORY=""

BOT_PID_FILE="$STATE_DIR/bot.pid"
VITE_PID_FILE="$STATE_DIR/vite.pid"
BOT_ENV_FILE="$BOT_DIR/.env"
LEGACY_BOT_ENV_FILE="$HOME/Desktop/claude-code-telegram/.env"
BOT_PYTHON=""
BOT_POETRY_ENV=(
  "POETRY_VIRTUALENVS_IN_PROJECT=true"
  "POETRY_VIRTUALENVS_CREATE=true"
)

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

ensure_submodule() {
  if [ ! -d "$BOT_DIR" ]; then
    echo "Initializing submodule: $BOT_SUBMODULE_PATH"
    git -C "$ROOT_DIR" submodule update --init --recursive "$BOT_SUBMODULE_PATH"
  fi
}

ensure_bot_env() {
  if [ -f "$BOT_ENV_FILE" ]; then
    return
  fi

  if [ -f "$LEGACY_BOT_ENV_FILE" ]; then
    cp "$LEGACY_BOT_ENV_FILE" "$BOT_ENV_FILE"
    echo "Copied bot env from $LEGACY_BOT_ENV_FILE"
    return
  fi

  if [ -f "$BOT_DIR/.env.example" ]; then
    cp "$BOT_DIR/.env.example" "$BOT_ENV_FILE"
    echo "Created $BOT_ENV_FILE from .env.example"
    echo "Populate required bot secrets, then retry."
    exit 1
  fi

  echo "Missing bot .env and .env.example in $BOT_DIR"
  exit 1
}

upsert_env_line() {
  local key="$1"
  local value="$2"
  local file="$3"

  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

read_env_value() {
  local key="$1"
  local file="$2"
  local line value first last

  if [ ! -f "$file" ]; then
    return 0
  fi

  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  if [ -z "${line:-}" ]; then
    return 0
  fi

  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  if [ "${#value}" -ge 2 ]; then
    first="${value:0:1}"
    last="${value: -1}"
    if [ "$first" = '"' ] && [ "$last" = '"' ]; then
      value="${value:1:${#value}-2}"
    elif [ "$first" = "'" ] && [ "$last" = "'" ]; then
      value="${value:1:${#value}-2}"
    fi
  fi

  printf '%s' "$value"
}

resolve_g2_default_working_directory() {
  local value=""

  value="$(read_env_value "APPROVED_DIRECTORY" "$BOT_ENV_FILE")"
  if [ -z "${value:-}" ] && [ -f "$LEGACY_BOT_ENV_FILE" ]; then
    value="$(read_env_value "APPROVED_DIRECTORY" "$LEGACY_BOT_ENV_FILE")"
  fi
  if [ -z "${value:-}" ]; then
    value="$HOME/Desktop"
  fi

  G2_DEFAULT_WORKING_DIRECTORY="$value"
}

configure_bot_env() {
  upsert_env_line "ENABLE_API_SERVER" "true" "$BOT_ENV_FILE"
  upsert_env_line "API_SERVER_PORT" "$G2_BOT_PORT" "$BOT_ENV_FILE"
  upsert_env_line "ENABLE_EVEN_G2" "true" "$BOT_ENV_FILE"
  upsert_env_line "EVEN_G2_URL" "http://${G2_CALLBACK_HOST}:${G2_PORT}" "$BOT_ENV_FILE"

  if [ -f "$LEGACY_BOT_ENV_FILE" ]; then
    if [ -w "$LEGACY_BOT_ENV_FILE" ]; then
      upsert_env_line "ENABLE_API_SERVER" "true" "$LEGACY_BOT_ENV_FILE"
      upsert_env_line "API_SERVER_PORT" "$G2_BOT_PORT" "$LEGACY_BOT_ENV_FILE"
      upsert_env_line "ENABLE_EVEN_G2" "true" "$LEGACY_BOT_ENV_FILE"
      upsert_env_line "EVEN_G2_URL" "http://${G2_CALLBACK_HOST}:${G2_PORT}" "$LEGACY_BOT_ENV_FILE"
    else
      echo "Skipping legacy env update (not writable): $LEGACY_BOT_ENV_FILE" >&2
    fi
  fi
}

ensure_bot_deps() {
  local venv_path

  if ! command -v poetry >/dev/null 2>&1; then
    echo "poetry not found in PATH. Install poetry first."
    exit 1
  fi

  (
    cd "$BOT_DIR"
    export "${BOT_POETRY_ENV[@]}"
    venv_path="$(poetry env info -p 2>/dev/null || true)"
    if [ -n "${venv_path:-}" ] && [ -x "$venv_path/bin/python" ] && "$venv_path/bin/python" -c "import structlog" >/dev/null 2>&1; then
      printf '%s\n' "$venv_path/bin/python" > "$STATE_DIR/bot-python-path"
      return 0
    fi

    echo "Installing bot dependencies (first run)..."
    poetry install --no-interaction --no-root >> "$LOG_DIR/bot.log" 2>&1

    venv_path="$(poetry env info -p 2>/dev/null || true)"
    if [ -z "${venv_path:-}" ] || [ ! -x "$venv_path/bin/python" ]; then
      echo "Failed to resolve Poetry virtualenv path after install."
      exit 1
    fi
    printf '%s\n' "$venv_path/bin/python" > "$STATE_DIR/bot-python-path"
  )

  BOT_PYTHON="$(cat "$STATE_DIR/bot-python-path")"
  if [ ! -x "$BOT_PYTHON" ]; then
    echo "Resolved bot python path is invalid: $BOT_PYTHON"
    exit 1
  fi
}

find_bot_pid() {
  local pid cwd
  # Prefer bot process started from the subrepo working directory.
  for pid in $(pgrep -f "python -m src.main" 2>/dev/null || true); do
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    if [ "$cwd" = "$BOT_DIR" ]; then
      echo "$pid"
      return 0
    fi
  done
  # Fallback: any running src.main bot process (helps avoid duplicate bots on port 8080).
  for pid in $(pgrep -f "python -m src.main" 2>/dev/null || true); do
    if is_running "$pid"; then
      echo "$pid"
      return 0
    fi
  done
  return 1
}

adopt_existing_bot_pid() {
  local pid
  pid="$(find_bot_pid || true)"
  if [ -n "${pid:-}" ] && is_running "$pid"; then
    echo "$pid" > "$BOT_PID_FILE"
    return 0
  fi
  return 1
}

find_vite_pid_for_port() {
  local pids pid args
  # Primary: match Vite process command line under this repo with the target port.
  for pid in $(pgrep -f "$ROOT_DIR/node_modules/.bin/vite" 2>/dev/null || true); do
    args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    if [ -n "$args" ] && [[ "$args" == *"--port $G2_PORT"* ]]; then
      echo "$pid"
      return 0
    fi
  done

  # Fallback: discover by listening port if command match is unavailable.
  pids="$(lsof -ti ":${G2_PORT}" 2>/dev/null || true)"
  for pid in $pids; do
    args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    if [ -n "$args" ] && [[ "$args" == *"vite"* ]]; then
      echo "$pid"
      return 0
    fi
  done
  return 1
}

stop_pids_matching() {
  local pattern="$1"
  local pids pid
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
  for pid in $pids; do
    if is_running "$pid"; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}

stop_conflicting_processes() {
  if [ "$G2_KEEP_EXISTING" = "1" ]; then
    return
  fi

  # Avoid split-brain by ensuring only one bot/vite instance for this stack.
  stop_pids_matching "python -m src.main"
  stop_pids_matching "$ROOT_DIR/node_modules/.bin/vite.*--port $G2_PORT"
  stop_pids_matching "node .*node_modules/.bin/vite.*--port $G2_PORT"

  rm -f "$BOT_PID_FILE" "$VITE_PID_FILE"
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

start_bot() {
  local existing_pid
  existing_pid="$(read_pid "$BOT_PID_FILE" || true)"
  if [ -n "${existing_pid:-}" ] && is_running "$existing_pid"; then
    echo "Bot already running (PID $existing_pid)"
    return
  fi

  if adopt_existing_bot_pid; then
    existing_pid="$(read_pid "$BOT_PID_FILE")"
    echo "Bot already running (PID $existing_pid)"
    return
  fi

  if [ -z "${BOT_PYTHON:-}" ] || [ ! -x "$BOT_PYTHON" ]; then
    if [ -f "$STATE_DIR/bot-python-path" ]; then
      BOT_PYTHON="$(cat "$STATE_DIR/bot-python-path")"
    fi
  fi
  if [ -z "${BOT_PYTHON:-}" ] || [ ! -x "$BOT_PYTHON" ]; then
    echo "Bot python runtime not resolved."
    echo "Run './start-g2-stack.sh up' again to bootstrap dependencies."
    return 1
  fi

  echo "Starting bot from $BOT_DIR"
  (
    cd "$BOT_DIR"
    "$BOT_PYTHON" -m src.main >> "$LOG_DIR/bot.log" 2>&1
  ) &

  local pid="$!"
  echo "$pid" > "$BOT_PID_FILE"
  sleep 2
  if ! is_running "$pid"; then
    if adopt_existing_bot_pid; then
      existing_pid="$(read_pid "$BOT_PID_FILE")"
      echo "Bot running (PID $existing_pid)"
      return
    fi
    echo "Bot failed to start. Check $LOG_DIR/bot.log"
    tail -n 60 "$LOG_DIR/bot.log" || true
    return 1
  fi
  echo "Bot running (PID $pid)"
}

start_vite() {
  local existing_pid
  existing_pid="$(read_pid "$VITE_PID_FILE" || true)"
  if [ -n "${existing_pid:-}" ] && is_running "$existing_pid"; then
    echo "Vite already running (PID $existing_pid)"
    return
  fi

  if adopt_existing_vite_pid; then
    existing_pid="$(read_pid "$VITE_PID_FILE")"
    echo "Vite already running on port $G2_PORT (PID $existing_pid)"
    return
  fi

  if [ ! -x "$VITE_BIN" ]; then
    echo "Vite binary not found at $VITE_BIN"
    echo "Run 'npm install' in $ROOT_DIR."
    return 1
  fi

  echo "Starting Vite on port $G2_PORT"
  (
    cd "$ROOT_DIR"
    VITE_APP_NAME=g2claude \
    VITE_HOST=0.0.0.0 \
    VITE_ALLOWED_HOSTS="$G2_TS_HOST" \
    G2_BOT_PORT="$G2_BOT_PORT" \
    G2_DEFAULT_WORKING_DIRECTORY="$G2_DEFAULT_WORKING_DIRECTORY" \
    "$VITE_BIN" --host 0.0.0.0 --strictPort --port "$G2_PORT" >> "$LOG_DIR/vite.log" 2>&1
  ) &

  local pid="$!"
  echo "$pid" > "$VITE_PID_FILE"
  sleep 2

  if adopt_existing_vite_pid; then
    existing_pid="$(read_pid "$VITE_PID_FILE")"
    echo "Vite running (PID $existing_pid)"
    return
  fi

  if ! is_running "$pid"; then
    echo "Vite failed to start. Check $LOG_DIR/vite.log"
    tail -n 80 "$LOG_DIR/vite.log" || true
    return 1
  fi
  echo "Vite running (PID $pid)"
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

show_status() {
  local bot_pid vite_pid
  bot_pid="$(read_pid "$BOT_PID_FILE" || true)"
  vite_pid="$(read_pid "$VITE_PID_FILE" || true)"

  if [ -z "${bot_pid:-}" ] || ! is_running "$bot_pid"; then
    adopt_existing_bot_pid || true
    bot_pid="$(read_pid "$BOT_PID_FILE" || true)"
  fi

  if [ -z "${vite_pid:-}" ] || ! is_running "$vite_pid"; then
    adopt_existing_vite_pid || true
    vite_pid="$(read_pid "$VITE_PID_FILE" || true)"
  fi

  if [ -n "${bot_pid:-}" ] && is_running "$bot_pid"; then
    echo "bot: running (PID $bot_pid)"
  else
    echo "bot: stopped"
  fi

  if [ -n "${vite_pid:-}" ] && is_running "$vite_pid"; then
    echo "vite: running (PID $vite_pid) on port $G2_PORT"
  else
    echo "vite: stopped"
  fi

  echo "qr_url: http://${G2_TS_HOST}:${G2_PORT}/"
  echo "callback_url: http://${G2_CALLBACK_HOST}:${G2_PORT}"
}

show_qr() {
  local url="http://${G2_TS_HOST}:${G2_PORT}/"
  echo "Generating QR for $url"
  npx @evenrealities/evenhub-cli qr --url "$url"
}

show_logs() {
  echo "Bot log:  $LOG_DIR/bot.log"
  echo "Vite log: $LOG_DIR/vite.log"
  tail -n 40 "$LOG_DIR/bot.log" || true
  echo "----"
  tail -n 60 "$LOG_DIR/vite.log" || true
}

up_stack() {
  local with_qr="true"
  if [ "${1:-}" = "--no-qr" ]; then
    with_qr="false"
  fi

  : > "$LOG_DIR/bot.log"
  : > "$LOG_DIR/vite.log"

  stop_conflicting_processes
  ensure_submodule
  ensure_bot_env
  ensure_bot_deps
  configure_bot_env
  resolve_g2_default_working_directory
  if ! start_bot; then
    return 1
  fi
  if ! start_vite; then
    stop_pid "$BOT_PID_FILE" "bot" || true
    return 1
  fi
  show_status

  if [ "$with_qr" = "true" ]; then
    show_qr
  else
    echo "Run './start-g2-stack.sh qr' when you need a QR."
  fi
}

down_stack() {
  stop_pid "$BOT_PID_FILE" "bot"
  stop_pid "$VITE_PID_FILE" "vite"
}

usage() {
  cat <<'EOF'
Usage:
  ./start-g2-stack.sh up [--no-qr]   Start bot + vite, optionally show QR (default: show QR)
  ./start-g2-stack.sh down           Stop bot + vite started by this script
  ./start-g2-stack.sh restart        Restart both services and show QR
  ./start-g2-stack.sh status         Show process and URL status
  ./start-g2-stack.sh qr             Show QR only
  ./start-g2-stack.sh logs           Tail recent bot + vite logs
EOF
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
