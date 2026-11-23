#!/usr/bin/env bash
# Starts the dedicated Chrome the Mac worker attaches to. Chrome 136+ refuses --remote-debugging-port on the default
# profile, so this uses its own user-data-dir. Sign-ins you make in this Chrome persist there.
set -euo pipefail
PORT="${MAC_WORKER_CDP_PORT:-9222}"
PROFILE="${MAC_WORKER_PROFILE:-$HOME/Library/Application Support/founderos-mac-worker/chrome}"
mkdir -p "$PROFILE"
exec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port="$PORT" --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check
