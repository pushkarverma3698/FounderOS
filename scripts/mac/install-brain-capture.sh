#!/bin/bash
# FounderOS: install the Mac brain capture (AG-027). Run once on the Mac.
#   1. renders deploy/mac/com.founderos.brain-capture.plist into ~/Library/LaunchAgents and loads it
#   2. removes the brain-auto-ingest.sh line from the crontab, after saving a backup of the crontab
# Env overrides (tests): INSTALL_HOME, INSTALL_SKIP_LAUNCHCTL=1.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
HOME_DIR="${INSTALL_HOME:-$HOME}"
LABEL="com.founderos.brain-capture"
AGENT_DIR="$HOME_DIR/Library/LaunchAgents"
TARGET="$AGENT_DIR/$LABEL.plist"

mkdir -p "$AGENT_DIR" "$HOME_DIR/.claude"
chmod +x "$REPO/scripts/mac/brain-capture.sh"
sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME_DIR#g" "$REPO/deploy/mac/$LABEL.plist" > "$TARGET"
echo "wrote $TARGET"

if [ "${INSTALL_SKIP_LAUNCHCTL:-0}" != "1" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$TARGET"
  echo "loaded $LABEL (every 1800 s). Log: $HOME_DIR/.claude/brain-capture.log"
fi

if command -v crontab >/dev/null 2>&1; then
  CURRENT="$(crontab -l 2>/dev/null || true)"
  if printf '%s\n' "$CURRENT" | grep -q 'brain-auto-ingest\.sh'; then
    BACKUP="$HOME_DIR/.claude/crontab-backup-$(date +%Y%m%d-%H%M%S).txt"
    printf '%s\n' "$CURRENT" > "$BACKUP"
    printf '%s\n' "$CURRENT" | grep -v 'brain-auto-ingest\.sh' | crontab -
    echo "removed the brain-auto-ingest.sh crontab line; backup at $BACKUP"
  else
    echo "no brain-auto-ingest.sh crontab line to remove"
  fi
fi
