#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE_PATH="$SCRIPT_DIR/mower.service.template"
SERVICE_PATH="/etc/systemd/system/mower.service"
DEFAULT_USER="$(id -un)"
MOWER_USER="${MOWER_USER:-$DEFAULT_USER}"
MOWER_GROUP="${MOWER_GROUP:-$MOWER_USER}"
LAUNCHER_PATH="$REPO_DIR/pi-app/mower-launch.sh"

if [ ! -f "$TEMPLATE_PATH" ]; then
  echo "Missing template: $TEMPLATE_PATH" >&2
  exit 1
fi

if [ ! -x "$LAUNCHER_PATH" ]; then
  chmod +x "$LAUNCHER_PATH"
fi

TMP_PATH="$(mktemp)"
trap 'rm -f "$TMP_PATH"' EXIT

sed \
  -e "s|__MOWER_USER__|$MOWER_USER|g" \
  -e "s|__MOWER_GROUP__|$MOWER_GROUP|g" \
  -e "s|__MOWER_REPO_DIR__|$REPO_DIR|g" \
  -e "s|__MOWER_LAUNCHER__|$LAUNCHER_PATH|g" \
  "$TEMPLATE_PATH" > "$TMP_PATH"

install -m 0644 "$TMP_PATH" "$SERVICE_PATH"
systemctl daemon-reload
systemctl enable mower

echo "Installed $SERVICE_PATH"
echo "Manage it with:"
echo "  sudo systemctl start mower"
echo "  sudo systemctl stop mower"
echo "  sudo systemctl restart mower"
echo "  sudo systemctl status mower"
