#!/usr/bin/env bash
# Launch codex-bridge proxy + droid, clean up on exit
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_PORT="${CODEX_BRIDGE_PORT:-18080}"
BRIDGE_URL="http://127.0.0.1:${BRIDGE_PORT}/health"
BRIDGE_STARTED=0
BRIDGE_PID=""
MAX_BRIDGE_ATTEMPTS=50
BRIDGE_SLEEP_MS=100
DROID_CMD="${CODEX_DROID_CMD:-}"

resolve_droid_command() {
  if [ -n "$DROID_CMD" ]; then
    printf "%s\n" "$DROID_CMD"
    return 0
  fi

  type -P droid.exe >/dev/null 2>&1 && type -P droid.exe | head -n1 && return 0
  type -P droid >/dev/null 2>&1 && type -P droid | head -n1 && return 0
  type -P droid.cmd >/dev/null 2>&1 && type -P droid.cmd | head -n1 && return 0

  return 1
}

wait_for_bridge() {
  local attempt=0
  local probe_cmd=""
  if command -v curl >/dev/null 2>&1; then
    probe_cmd='curl -sS "$BRIDGE_URL" >/dev/null 2>&1'
  elif command -v wget >/dev/null 2>&1; then
    probe_cmd='wget -q -O - "$BRIDGE_URL" >/dev/null 2>&1'
  else
    echo "codex-bridge: no curl/wget available for health probe" >&2
    return 1
  fi

  local attempt=0
  while [ "$attempt" -lt "$MAX_BRIDGE_ATTEMPTS" ]; do
    if eval "$probe_cmd"; then
      return 0
    fi

    attempt=$((attempt + 1))
    sleep "$(awk "BEGIN { print $BRIDGE_SLEEP_MS / 1000 }")"
  done

  return 1
}

droid_command="$(resolve_droid_command)" || {
  echo "Unable to resolve droid executable. Set CODEX_DROID_CMD to your droid binary path." >&2
  exit 1
}

if ! wait_for_bridge; then
  node "$SCRIPT_DIR/bridge.mjs" &
  BRIDGE_PID=$!
  BRIDGE_STARTED=1

  # Wait for proxy to bind
  if ! wait_for_bridge; then
    echo "codex-bridge did not become available at $BRIDGE_URL"
  fi
fi

trap 'if [ "$BRIDGE_STARTED" -eq 1 ] && [ -n "$BRIDGE_PID" ]; then kill "$BRIDGE_PID" 2>/dev/null; fi' EXIT

"$droid_command" "$@"
