#!/usr/bin/env bash
# Install the login/wake trigger that syncs the queue and messages you.
#
# It does NOT open a browser. The founder's decision (2026-08-06): a laptop that
# hijacks the screen every time it wakes is worse than typing one command.
set -euo pipefail

CLIENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.founderos.apply-sync.plist"
VENV_PY="$CLIENT_DIR/.venv/bin/python"

if [[ ! -x "$VENV_PY" ]]; then
  echo "✗ No venv at $VENV_PY — run: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi
if [[ ! -f "$CLIENT_DIR/apply-profile.json" ]]; then
  echo "✗ No apply-profile.json — copy apply-profile.example.json and fill it in first." >&2
  exit 1
fi
: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN before installing}"
: "${TELEGRAM_CHAT_ID:?set TELEGRAM_CHAT_ID before installing}"

mkdir -p "$HOME/Library/LaunchAgents" "$CLIENT_DIR/.queue"

# RunAtLoad fires on login. The 30-minute StartInterval is what covers "woke
# from sleep": macOS has no supported per-agent wake event, and a launchd timer
# that was due during sleep runs on wake — which is the behaviour we want and
# the reason this is an interval rather than a WatchPath.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.founderos.apply-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>$VENV_PY</string>
    <string>-m</string>
    <string>mac_client.wake</string>
  </array>
  <key>WorkingDirectory</key><string>$CLIENT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TELEGRAM_BOT_TOKEN</key><string>$TELEGRAM_BOT_TOKEN</string>
    <key>TELEGRAM_CHAT_ID</key><string>$TELEGRAM_CHAT_ID</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>1800</integer>
  <key>StandardOutPath</key><string>$CLIENT_DIR/.queue/wake.log</string>
  <key>StandardErrorPath</key><string>$CLIENT_DIR/.queue/wake.err</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✓ Installed $PLIST"
echo "  Syncs on login and every 30 minutes (a timer due during sleep runs on wake)."
echo "  Logs: $CLIENT_DIR/.queue/wake.log"
echo "  Remove with: launchctl unload $PLIST && rm $PLIST"
