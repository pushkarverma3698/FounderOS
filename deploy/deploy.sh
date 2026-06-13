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

echo "==> Ensuring Postgres is up"
docker compose -f deploy/postgres.compose.yml up -d
# Wait for the DB to accept connections before migrating.
for i in {1..30}; do
  if docker exec founderos-postgres pg_isready -U founderos >/dev/null 2>&1; then break; fi
  echo "    waiting for postgres ($i/30)"; sleep 1
done

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
