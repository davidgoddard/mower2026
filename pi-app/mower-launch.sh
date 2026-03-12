#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${MOWER_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

if [ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
fi

find_bin() {
  local env_name="$1"
  shift
  local configured="${!env_name:-}"
  if [ -n "$configured" ] && [ -x "$configured" ]; then
    printf '%s\n' "$configured"
    return 0
  fi

  local candidate
  for candidate in "$@"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

NODE_BIN="$(find_bin MOWER_NODE_BIN "$(command -v node 2>/dev/null || true)" /usr/local/bin/node /usr/bin/node)"
NPM_BIN="$(find_bin MOWER_NPM_BIN "$(command -v npm 2>/dev/null || true)" /usr/local/bin/npm /usr/bin/npm)"

if [ ! -f "$REPO_DIR/dist/src/estimation/poseEstimator.js" ]; then
  "$NPM_BIN" run build --prefix "$REPO_DIR"
fi

cd "$REPO_DIR"
exec "$NODE_BIN" "$REPO_DIR/pi-app/core_server.js"
