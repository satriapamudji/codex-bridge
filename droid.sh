#!/usr/bin/env bash
# Launch codex-bridge proxy + droid, clean up on exit
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

node "$SCRIPT_DIR/bridge.mjs" &
BRIDGE_PID=$!
trap "kill $BRIDGE_PID 2>/dev/null" EXIT

sleep 0.8
droid "$@"
