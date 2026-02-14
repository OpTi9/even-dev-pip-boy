#!/usr/bin/env bash

# =========================
# Even Hub Dev Launcher
# =========================

set -e

HOST="10.0.1.72"
PORT="5173"
URL="http://${HOST}:${PORT}"

echo "Starting Even Hub development environment... $URL"

# --------------------------------------------------
# Helpers
# --------------------------------------------------

command_exists () {
  command -v "$1" >/dev/null 2>&1
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
# Ensure evenhub simulator installed globally
# --------------------------------------------------

if ! command_exists evenhub-simulator; then
  echo "Installing evenhub-simulator globally..."
  npm install -g @evenrealities/evenhub-simulator
fi

# --------------------------------------------------
# Start Vite server
# --------------------------------------------------

echo "Starting Vite dev server..."

npx vite --host ${HOST} --port ${PORT} &

VITE_PID=$!

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

evenhub-simulator "$URL"

# --------------------------------------------------
# Cleanup on exit
# --------------------------------------------------

trap "kill $VITE_PID" EXIT

