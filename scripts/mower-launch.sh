#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${MOWER_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
SERVER_ENTRY="$REPO_DIR/dist/server/main.js"

resolve_home_dir() {
  if [ -n "${HOME:-}" ] && [ -d "${HOME:-}" ]; then
    printf '%s\n' "$HOME"
    return 0
  fi

  local user_name
  user_name="$(id -un 2>/dev/null || true)"
  if [ -n "$user_name" ]; then
    getent passwd "$user_name" | cut -d: -f6
    return 0
  fi

  return 1
}

find_nvm_bin() {
  local binary_name="$1"

  if [ -n "${NVM_BIN:-}" ] && [ -x "$NVM_BIN/$binary_name" ]; then
    printf '%s\n' "$NVM_BIN/$binary_name"
    return 0
  fi

  if [ -n "${NVM_DIR:-}" ] && [ -x "$NVM_DIR/current/bin/$binary_name" ]; then
    printf '%s\n' "$NVM_DIR/current/bin/$binary_name"
    return 0
  fi

  if [ -n "${NVM_DIR:-}" ]; then
    local candidate
    for candidate in "$NVM_DIR"/versions/node/*/bin/"$binary_name"; do
      if [ -x "$candidate" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
  fi

  return 1
}

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

NODE_BIN="$(find_bin MOWER_NODE_BIN "$(command -v node 2>/dev/null || true)" "$(find_nvm_bin node || true)" /usr/local/bin/node /usr/bin/node || true)"
if [ -z "$NODE_BIN" ]; then
  if [ -z "${NVM_DIR:-}" ]; then
    HOME_DIR="$(resolve_home_dir || true)"
    if [ -n "${HOME_DIR:-}" ] && [ -s "$HOME_DIR/.nvm/nvm.sh" ]; then
      NVM_DIR="$HOME_DIR/.nvm"
    fi
  fi

  if [ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
  fi

  NODE_BIN="$(find_bin MOWER_NODE_BIN "$(command -v node 2>/dev/null || true)" "$(find_nvm_bin node || true)" /usr/local/bin/node /usr/bin/node || true)"
fi

if [ -z "$NODE_BIN" ]; then
  echo "mower-launch: unable to find a usable node binary; set MOWER_NODE_BIN if needed" >&2
  exit 1
fi

if [ ! -f "$SERVER_ENTRY" ]; then
  echo "mower-launch: missing built server at $SERVER_ENTRY" >&2
  echo "mower-launch: run 'npm run build' before starting the service" >&2
  exit 1
fi

cd "$REPO_DIR"
exec "$NODE_BIN" "$SERVER_ENTRY"
