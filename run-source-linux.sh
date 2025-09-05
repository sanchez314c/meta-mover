#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== META Mover — Run from Source (Linux) ==="

# Generated ports
DEV_PORT=58594
HMR_PORT=62340
SPARE_PORT=63004

# Fix Electron sandbox permission issue on Linux
sudo sysctl -w kernel.unprivileged_userns_clone=1 2>/dev/null || true

# Kill zombie Electron processes from previous sessions
echo "Clearing zombie processes..."
pkill -f "electron.*meta-mover" 2>/dev/null || true
pkill -f "electron.*--dev" 2>/dev/null || true

# Release ports if occupied
for PORT in $DEV_PORT $HMR_PORT $SPARE_PORT; do
  PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "Releasing port $PORT (PIDs: $PIDS)"
    echo "$PIDS" | xargs kill -9 2>/dev/null || true
  fi
done

sleep 1

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

# Export ports for webpack and Electron
export DEV_PORT=$DEV_PORT
export HMR_PORT=$HMR_PORT
export SPARE_PORT=$SPARE_PORT
export PORT=$DEV_PORT

echo "Building META Mover from source (dev mode)..."
npm run build:dev

echo "Launching META Mover..."
# No --dev flag = isDevelopment is false, so Electron loads from built dist/ files
./node_modules/.bin/electron . --no-sandbox
