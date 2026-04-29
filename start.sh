#!/usr/bin/env bash
# FounderOS — Master Startup Script (v3 — APScheduler edition)
# ==============================================================
# Replaces all individual agent while-True loops with a single scheduler.
# 
# Architecture:
#   3 permanent processes:
#     1. MLX-LM (Qwen 2.5 7B) — always-on local worker
#     2. Telegram Gateway — always-on command receiver
#     3. APScheduler — all 16 agent schedules in one resilient process
#
#   Previously: 11 fragile parallel while-True processes
#   Now: 3 resilient processes, SQLite-persisted schedules, IST timezone
#
# Usage: bash ~/Documents/Coding stuff/FounderOS/start.sh
# Stop:  bash ~/Documents/Coding stuff/FounderOS/stop.sh
# Logs:  tail -f /tmp/founderos_scheduler.log

set -e
echo "🏗️  Starting FounderOS..."
echo ""

# ── KEEP MAC AWAKE (prevents sleep killing all 3 processes) ──────────────────
# -d: no display sleep  -i: no system idle sleep  -m: no disk sleep  -u: declared user activity
caffeinate -dimu &
CAFFEINATE_PID=$!
echo "☕  Caffeinate active (PID $CAFFEINATE_PID) — Mac will stay awake."

# 0. Load environment variables
if [ -f ~/Documents/Coding\ stuff/FounderOS/.c-suite/.env ]; then
  # Strip comments (both line-start and inline) then export
  export $(grep -v '^#' ~/Documents/Coding\ stuff/FounderOS/.c-suite/.env | sed 's/#.*//' | xargs)
  echo "✅  Environment loaded."
else
  echo "⚠️  No .env file found."
  echo "    Run: cp ~/Documents/Coding stuff/FounderOS/.c-suite/.env.example ~/Documents/Coding stuff/FounderOS/.c-suite/.env"
  echo "    Then fill in your API keys."
  exit 1
fi

# Validate required keys
# NOTE: ANTHROPIC_API_KEY is OPTIONAL — cascade auto-falls to Gemini → OpenRouter → Local
MISSING=""
[ -z "$GOOGLE_API_KEY" ]     && MISSING="$MISSING GOOGLE_API_KEY"
[ -z "$TELEGRAM_BOT_TOKEN" ] && MISSING="$MISSING TELEGRAM_BOT_TOKEN"
[ -z "$TELEGRAM_CHAT_ID" ]   && MISSING="$MISSING TELEGRAM_CHAT_ID"

if [ -n "$MISSING" ]; then
  echo "⚠️  Missing required env vars: $MISSING"
  echo "    Fill these in .env before starting."
  kill $CAFFEINATE_PID 2>/dev/null
  exit 1
fi

# Warn if Anthropic key missing (non-blocking — cascade uses Gemini first)
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "⚠️  ANTHROPIC_API_KEY not set — CEO tier will use Gemini Pro (still free)."
else
  echo "✅  Anthropic API key detected — full CEO cascade available."
fi

# 1. Activate Python environment
source ~/mlx_env/bin/activate
echo "✅  Python env activated."

# Check key packages
python -c "import apscheduler" 2>/dev/null || {
  echo "📦  Installing APScheduler..."
  pip install apscheduler sqlalchemy -q
}

# ── PROCESS 1: Local MLX Worker (Qwen3-8B preferred, Qwen2.5-7B fallback) ────
# Qwen3-8B: best JSON/tool-calling on M4 16GB (4.1 GB weights, 9.4 GB headroom)
LOCAL_MODEL_ID="mlx-community/Qwen2.5-7B-Instruct-4bit"
QWEN3_SNAP=~/.cache/huggingface/hub/models--mlx-community--Qwen3-8B-4bit/snapshots
if [ -d "$QWEN3_SNAP" ] && [ "$(ls -A $QWEN3_SNAP 2>/dev/null)" ]; then
  LOCAL_MODEL_ID="mlx-community/Qwen3-8B-4bit"
  echo "🧠  Qwen3-8B detected — using best local model."
else
  echo "🧠  Qwen3-8B not ready — falling back to Qwen2.5-7B."
fi
echo "    Model: $LOCAL_MODEL_ID"
python -m mlx_lm.server \
  --model "$LOCAL_MODEL_ID" \
  --host 127.0.0.1 \
  --port 8000 &
MLX_PID=$!
echo "   MLX Server PID: $MLX_PID"
echo "   Endpoint: http://127.0.0.1:8000"
sleep 3

# ── PROCESS 2: Telegram Gateway ───────────────────────────────────────────────
echo ""
echo "📱  Starting Telegram Gateway..."
cd ~/Documents/Coding stuff/FounderOS/.c-suite
python -m bridges.telegram_gateway &
TELEGRAM_PID=$!
echo "   Telegram Gateway PID: $TELEGRAM_PID"
sleep 1

# ── PROCESS 3: APScheduler (replaces all 11 individual agent processes) ───────
echo ""
echo "📅  Starting APScheduler (16 agent schedules)..."
python -m core.scheduler > /tmp/founderos_scheduler.log 2>&1 &
SCHEDULER_PID=$!
echo "   Scheduler PID: $SCHEDULER_PID"
sleep 2

# ── STATUS DISPLAY ────────────────────────────────────────────────────────────
echo ""
echo "======================================================="
echo "  ✅  FounderOS ONLINE — $(date '+%A, %d %b %Y %H:%M IST')"
echo "======================================================="
echo ""
echo "  PROCESSES (3 resilient, replaces 11 fragile loops):"
echo "  [PID $MLX_PID]       MLX-LM — http://127.0.0.1:8000"
echo "  [PID $TELEGRAM_PID]  Telegram Gateway — listening"
echo "  [PID $SCHEDULER_PID] APScheduler — 16 jobs, IST timezone"
echo ""
echo "  AGENT SCHEDULE (next 24h highlights):"
echo "    [Daily  05:45] Farm Weather Brief"
echo "    [Daily  09:00] Booking Concierge Check"
echo "    [Daily  09:30] Social Handler Standup"
echo "    [Daily  18:30] Evening MD Scrum → #Boardroom"
echo "    [Daily  01:00] Auto-Researcher (nightly)"
echo "    [Mon    07:00] HR Roster Review → #Boardroom"
echo "    [Mon    08:00] Social Media Research"
echo "    [Wed    09:00] Revenue Team Brief → #Turicks_Floor"
echo "    [Fri    17:30] Team Therapist → #Boardroom"
echo "    [Sun    22:00] Cost Watchdog Audit → #Boardroom"
echo ""
echo "  TEST COMMANDS (Run from within .c-suite directory):"
echo "    cd .c-suite && python -m core.scheduler --list"
echo "    cd .c-suite && python -m agents.scrum_engine --now"
echo "    cd .c-suite && python -m agents.revenue_team --now"
echo "    cd .c-suite && python -m agents.hr_agent --review"
echo "    cd .c-suite && python -m agents.cost_watchdog --now"
echo "    cd .c-suite && python -m agents.team_therapist --now"
echo "    cd .c-suite && python -m agents.auto_researcher --now"
echo ""
echo "  LOGS: tail -f /tmp/founderos_scheduler.log"
echo "  STOP: bash ~/Documents/Coding stuff/FounderOS/stop.sh"
echo "======================================================="

# Save PIDs for stop script (includes caffeinate so stop.sh can kill it)
echo "$MLX_PID $TELEGRAM_PID $SCHEDULER_PID $CAFFEINATE_PID" > /tmp/founderos.pids

wait
