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

echo "==> Fetching $BRANCH"
git fetch --quiet origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "==> Installing dependencies (frozen lockfile)"
pnpm install --frozen-lockfile

echo "==> Type check (lint) — abort deploy if red"
pnpm lint

echo "==> Building"
pnpm build

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
