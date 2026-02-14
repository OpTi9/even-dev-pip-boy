#!/usr/bin/env bash

# =========================
# Even Hub Dev Launcher
# =========================

set -e

VITE_HOST="${VITE_HOST:-0.0.0.0}"
SIM_HOST="${SIM_HOST:-127.0.0.1}"
PORT="${PORT:-5173}"
URL="${URL:-http://${SIM_HOST}:${PORT}}"
APP_NAME="${APP_NAME:-}"

echo "Starting Even Hub development environment... ${URL}"

# --------------------------------------------------
# Helpers
# --------------------------------------------------

command_exists () {
  command -v "$1" >/dev/null 2>&1
}

discover_apps () {
  if [ ! -d "apps" ]; then
    return
  fi

  find apps -mindepth 1 -maxdepth 1 -type d ! -name '_*' ! -name '.*' -exec basename {} \; | sort
}

resolve_app_selection () {
  local apps=()
  while IFS= read -r app; do
    apps+=("$app")
  done < <(discover_apps)

  if [ "${#apps[@]}" -eq 0 ]; then
    echo "No apps found. Create at least one app folder under ./apps (for example apps/demo)." >&2
    exit 1
  fi

  if [ -n "${APP_NAME}" ]; then
    for app in "${apps[@]}"; do
      if [ "${app}" = "${APP_NAME}" ]; then
        echo "${APP_NAME}"
        return
      fi
    done

    echo "APP_NAME '${APP_NAME}' does not exist under ./apps." >&2
    echo "Available apps: ${apps[*]}" >&2
    exit 1
  fi

  if [ "${#apps[@]}" -eq 1 ]; then
    echo "${apps[0]}"
    return
  fi

  echo "Available apps:" >&2
  for i in "${!apps[@]}"; do
    printf "  %d) %s\n" "$((i + 1))" "${apps[$i]}" >&2
  done

  read -r -p "Select app [1-${#apps[@]}] (default 1): " app_index >&2
  if [ -z "${app_index}" ]; then
    app_index=1
  fi

  if ! [[ "${app_index}" =~ ^[0-9]+$ ]] || [ "${app_index}" -lt 1 ] || [ "${app_index}" -gt "${#apps[@]}" ]; then
    echo "Invalid app selection: ${app_index}" >&2
    exit 1
  fi

  echo "${apps[$((app_index - 1))]}"
}

# --------------------------------------------------
# Check Node / npm
# --------------------------------------------------

if ! command_exists node; then
  echo "Node.js is not installed."
  exit 1
fi

if ! command_exists npm; then
  echo "npm is not installed."
  exit 1
fi

# --------------------------------------------------
# Ensure local dependencies installed
# --------------------------------------------------

if [ ! -d "node_modules" ]; then
  echo "Installing project dependencies..."
  npm install
fi

# --------------------------------------------------
# Ensure Vite installed locally
# --------------------------------------------------

if [ ! -d "node_modules/vite" ]; then
  echo "Installing vite locally..."
  npm install --save-dev vite
fi

# --------------------------------------------------
# Start Vite server
# --------------------------------------------------

echo "Starting Vite dev server..."

SELECTED_APP="$(resolve_app_selection)"
echo "Selected app: ${SELECTED_APP}"

VITE_APP_NAME="${SELECTED_APP}" npx vite --host "${VITE_HOST}" --port "${PORT}" &

VITE_PID=$!

trap "kill ${VITE_PID}" EXIT

# --------------------------------------------------
# Wait for server to be reachable
# --------------------------------------------------

echo "Waiting for Vite server..."

until curl --output /dev/null --silent --head --fail "$URL"; do
  sleep 1
done

echo "Vite is ready."

# --------------------------------------------------
# Launch simulator
# --------------------------------------------------

echo "Launching Even Hub Simulator..."
if command_exists evenhub-simulator; then
  evenhub-simulator "${URL}"
else
  npx @evenrealities/evenhub-simulator "${URL}"
fi
