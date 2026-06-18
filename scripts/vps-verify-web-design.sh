#!/usr/bin/env bash
# VPS verification for web design service wiring.
set -euo pipefail

if [ "${1:-}" = "--live-only" ]; then
  APP_DIR="${APP_DIR:-/opt/founderos}"
  cd "$APP_DIR"
  chmod +x scripts/vps-live-showcase.sh
  exec bash scripts/vps-live-showcase.sh
fi

APP_DIR="${APP_DIR:-/opt/founderos}"
BRANCH="${VERIFY_BRANCH:-main}"
cd "$APP_DIR"

echo "==> VPS verify: branch=$BRANCH"
git fetch --quiet origin "$BRANCH"
git reset --hard "origin/$BRANCH"
git clean -fd
git checkout -B "verify-$BRANCH" "origin/$BRANCH"

echo "==> Dependencies"
pnpm install --frozen-lockfile

# ── PRIORITY: live showcase deploy (must not be blocked by eval flakes) ─────
echo "==> LIVE SHOWCASE (priority)"
chmod +x scripts/vps-live-showcase.sh
bash scripts/vps-live-showcase.sh 2>&1 | tee /tmp/vps-live-showcase.log

echo "==> Gate (lint + wiring + tests)"
pnpm lint
pnpm verify:wiring
pnpm test

echo "==> Claude Code CLI"
if command -v claude >/dev/null 2>&1; then
  echo "    claude: $(which claude)"
  claude -p "Reply with exactly: CLAUDE_OK" 2>&1 | tail -5 || echo "!! claude -p failed"
else
  echo "!! claude NOT on PATH"
fi

echo "==> Ollama"
curl -sf http://127.0.0.1:11434/api/tags >/dev/null && echo "    ollama: up" || echo "!! ollama down"

echo "==> Manual E2E (web design) — non-fatal"
EVAL_OK=0
pnpm eval:webdesign || EVAL_OK=$?
if [ "$EVAL_OK" -ne 0 ]; then
  echo "!! eval:webdesign had failures (exit $EVAL_OK) — see above"
fi

echo "==> Production health"
curl -sf http://127.0.0.1:3001/health | head -c 500 || echo "!! /health down"
echo ""

echo "==> VPS verify complete (live showcase + gate)"
