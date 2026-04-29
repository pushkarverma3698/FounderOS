#!/usr/bin/env bash
# FounderOS — Shutdown Script
if [ -f /tmp/founderos.pids ]; then
  PIDS=$(cat /tmp/founderos.pids)
  kill $PIDS 2>/dev/null && echo "✅  FounderOS stopped." || echo "⚠️  Some processes already gone."
  rm /tmp/founderos.pids
else
  echo "No PID file found. Killing all related processes..."
  pkill -f "mlx_lm.server" 2>/dev/null
  pkill -f "bridges.telegram_gateway" 2>/dev/null
  pkill -f "core.scheduler" 2>/dev/null
  pkill -f "agents.hourly_ideator" 2>/dev/null
  echo "✅  Done."
fi

# Always release caffeinate so Mac can sleep normally again
pkill -f "caffeinate" 2>/dev/null || true
echo "☕  Caffeinate released — Mac sleep restored."
