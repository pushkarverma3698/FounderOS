#!/usr/bin/env bash
# One-shot VPS fix: OpenRouter deprecated preview-05-20 slug (400 invalid model ID).
# Run on the Hetzner box as founderos: bash scripts/vps-fix-agent-model.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/founderos}"
cd "$APP_DIR"

OLD='openrouter:google/gemini-2.5-flash-preview-05-20'
NEW='openrouter:google/gemini-2.5-flash'

if [ ! -f .env ]; then
  echo "!! .env missing in $APP_DIR"
  exit 1
fi

if grep -q "^AGENT_MODEL=${OLD}" .env 2>/dev/null; then
  sed -i "s|^AGENT_MODEL=${OLD}|AGENT_MODEL=${NEW}|" .env
  echo "==> Updated AGENT_MODEL to ${NEW}"
elif grep -q '^AGENT_MODEL=' .env; then
  echo "==> AGENT_MODEL already set (not deprecated slug):"
  grep '^AGENT_MODEL=' .env
else
  echo "AGENT_MODEL=${NEW}" >> .env
  echo "==> Appended AGENT_MODEL=${NEW}"
fi

chmod 600 .env
echo "==> Restarting founderos (passwordless sudo required)"
sudo systemctl restart founderos
sleep 3
curl -sf localhost:3001/health | head -c 400 || echo "!! /health not up yet"
echo ""
echo "==> Done. Verify routing: pnpm eval:webdesign (on beta/verify checkout)"
