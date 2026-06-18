#!/usr/bin/env bash
# FounderOS — server-side deploy. Runs ON the VPS, invoked by GitHub Actions
# over SSH after CI passes (see .github/workflows/deploy.yml), or by hand.
#
#   ssh founderos@host 'cd /opt/founderos && ./deploy/deploy.sh'
#
# Idempotent and fail-loud: any step failing aborts the deploy and the OLD
# instance keeps running (systemd is only restarted at the very end).
set -euo pipefail

APP_DIR="/opt/founderos"
# main IS production (single-tenant — ADR-021). Override with DEPLOY_BRANCH if needed.
BRANCH="${DEPLOY_BRANCH:-main}"

cd "$APP_DIR"

# Recover from git permission / detached-HEAD drift before fetch/reset.
if [ -d .git/refs/heads/cursor ]; then
  rm -rf .git/refs/heads/cursor 2>/dev/null || true
fi
find .git -name '*.lock' -delete 2>/dev/null || true

echo "==> Fetching $BRANCH"
git fetch --quiet origin "$BRANCH"
# Detached checkout avoids creating refs/heads/cursor/* (permission drift on VPS).
git checkout --force --detach "origin/$BRANCH"

echo "==> Installing dependencies (frozen lockfile)"
pnpm install --frozen-lockfile

echo "==> Type check (lint) — abort deploy if red"
pnpm lint

echo "==> Building (backend + JARVIS)"
# Inject web gateway token into JARVIS build when configured (SSE ?token= + Bearer fetch).
if [ -f .env ] && grep -q '^WEB_GATEWAY_TOKEN=' .env; then
  TOKEN="$(grep '^WEB_GATEWAY_TOKEN=' .env | cut -d= -f2- | tr -d '"')"
  if [ -n "$TOKEN" ]; then
    export VITE_WEB_GATEWAY_TOKEN="$TOKEN"
    echo "    VITE_WEB_GATEWAY_TOKEN set from WEB_GATEWAY_TOKEN for JARVIS build"
  fi
fi
pnpm build:all

echo "==> Ensuring Postgres + Ollama are up"
docker compose -f deploy/stack.compose.yml up -d

# Wait for Postgres to accept connections before migrating.
for i in {1..30}; do
  if docker exec founderos-postgres pg_isready -U founderos >/dev/null 2>&1; then break; fi
  echo "    waiting for postgres ($i/30)"; sleep 1
done

# Wait for Ollama API to be ready, then pull the embed model if not cached.
echo "==> Waiting for Ollama"
for i in {1..30}; do
  if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then break; fi
  echo "    waiting for ollama ($i/30)"; sleep 2
done
echo "==> Pulling nomic-embed-text (no-op if already cached)"
docker exec founderos-ollama ollama pull nomic-embed-text

# Defensive: strip a stale Mac-style PERSONAL_ROOT placeholder if one slipped in.
# The prod .env is normally rendered from the PROD_DOTENV secret (which should
# omit PERSONAL_ROOT so path-guard falls back to os.homedir() = /home/founderos),
# but this keeps a hand-edited .env from breaking the personal dept.
if grep -q '^PERSONAL_ROOT=/Users/' .env 2>/dev/null; then
  sed -i '/^PERSONAL_ROOT=/d' .env
  echo "    patched: removed stale PERSONAL_ROOT placeholder from .env"
fi

echo "==> Running migrations"
pnpm db:migrate

# Populate the turicks_brain pgvector store from docs/ (embeds via local Ollama).
# Non-fatal: a transient Ollama hiccup must not block a deploy — the vector
# store can be re-synced by hand (pnpm brain:sync). Without this step the store
# stays empty and search_turicks_brain returns nothing (the 2026-06-15 prod bug).
echo "==> Syncing turicks-brain vector store (brain:sync)"
if pnpm brain:sync; then
  echo "    brain:sync OK"
else
  echo "!! brain:sync FAILED (non-fatal) — run it manually once Ollama is healthy" >&2
fi

echo "==> Restarting service (single-instance lock makes this safe)"
sudo systemctl restart founderos

echo "==> Waiting for health"
sleep 5
if curl -fsS http://127.0.0.1:3001/health >/dev/null; then
  echo "==> Deploy OK — /health is green"
else
  echo "!! /health did NOT come up — check: journalctl -u founderos -n 50" >&2
  exit 1
fi

if curl -fsS http://127.0.0.1:3001/api/v1/health >/dev/null; then
  echo "==> JARVIS web gateway OK — /api/v1/health"
else
  echo "!! /api/v1/health failed — JARVIS API may be down" >&2
  exit 1
fi

if curl -fsS http://127.0.0.1:3001/ | grep -qi 'html\|jarvis\|root'; then
  echo "==> JARVIS UI OK — GET / serves SPA"
else
  echo "!! GET / did not return JARVIS SPA — run pnpm build:jarvis on the box" >&2
  exit 1
fi
