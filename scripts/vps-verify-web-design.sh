#!/usr/bin/env bash
# VPS verification for web design service wiring.
# Run ON the Hetzner box (or via .github/workflows/vps-verify.yml).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/founderos}"
BRANCH="${VERIFY_BRANCH:-feat/web-design-service-cb8b}"
cd "$APP_DIR"

echo "==> VPS verify: branch=$BRANCH"
git fetch --quiet origin "$BRANCH"
git checkout -B "verify-$BRANCH" "origin/$BRANCH"

echo "==> Dependencies"
pnpm install --frozen-lockfile

echo "==> Gate (lint + wiring + tests)"
pnpm lint
pnpm verify:wiring
pnpm test

echo "==> Claude Code CLI"
if command -v claude >/dev/null 2>&1; then
  echo "    claude: $(which claude)"
  claude -p "Reply with exactly: CLAUDE_OK" 2>&1 | tail -5 || echo "!! claude -p failed (auth may be missing)"
else
  echo "!! claude NOT on PATH — install: sudo npm install -g @anthropic-ai/claude-code"
fi

echo "==> Ollama"
if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "    ollama: up"
else
  echo "!! ollama down — docker compose -f deploy/stack.compose.yml up -d"
fi

echo "==> Manual E2E (web design)"
pnpm eval:webdesign

echo "==> Production health (live service)"
if curl -sf http://127.0.0.1:3001/health >/dev/null; then
  curl -s http://127.0.0.1:3001/health | head -c 500
  echo ""
else
  echo "!! /health not responding — is founderos.service running?"
fi

echo "==> VPS verify complete"

echo "==> Cinematic build probe (real claude_code artifacts)"
if [ -f scripts/probe-cinematic-build.ts ]; then
  node --env-file=.env --import tsx/esm scripts/probe-cinematic-build.ts 2>&1 | tee /tmp/probe-cinematic-build.log
  tail -40 /tmp/probe-cinematic-build.log
else
  echo "!! probe-cinematic-build.ts not on this branch — skip"
fi
