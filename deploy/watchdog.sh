#!/usr/bin/env bash
# FounderOS watchdog — self-heal a hung bot without human intervention.
# systemd (Restart=always) covers CRASHES; this covers alive-but-hung: after
# 3 consecutive /health failures it kills the main PID (systemd revives it in
# 5s). Alerts the founder on Telegram ONCE only if the restart did not recover.
set -uo pipefail
HEALTH_URL="http://127.0.0.1:3001/health"
STATE=/tmp/founderos-watchdog.fails
ALERTED=/tmp/founderos-watchdog.alerted

if curl -fsS -m 10 "$HEALTH_URL" >/dev/null 2>&1; then
  rm -f "$STATE" "$ALERTED"
  exit 0
fi
FAILS=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$FAILS" > "$STATE"
[ "$FAILS" -lt 3 ] && exit 0

MAINPID=$(systemctl show -p MainPID --value founderos)
if [ -n "$MAINPID" ] && [ "$MAINPID" != "0" ]; then
  echo "$(date -Is) health dead x$FAILS — killing PID $MAINPID for systemd restart"
  kill "$MAINPID"
fi
echo 0 > "$STATE"
sleep 30
if ! curl -fsS -m 10 "$HEALTH_URL" >/dev/null 2>&1 && [ ! -f "$ALERTED" ]; then
  BOT=$(grep -E "^TELEGRAM_BOT_TOKEN=" /opt/founderos/.env | cut -d= -f2- | tr -d "\"")
  CHAT=$(grep -E "^TELEGRAM_CHAT_ID=" /opt/founderos/.env | cut -d= -f2- | tr -d "\"")
  if [ -n "$BOT" ] && [ -n "$CHAT" ]; then
    curl -fsS -m 10 "https://api.telegram.org/bot${BOT}/sendMessage" -d chat_id="$CHAT" -d text="🚨 FounderOS watchdog: bot unresponsive after auto-restart — manual attention needed." >/dev/null 2>&1
  fi
  touch "$ALERTED"
fi
