#!/usr/bin/env bash
# FounderOS — production stabilization (run ON the VPS via GitHub Actions SSH).
# Deploys a branch, syncs knowledge stores, verifies health + DB state.
#
# Usage (on VPS):
#   DEPLOY_BRANCH=beta ./scripts/vps-prod-stabilize.sh
#
# Idempotent — safe to re-run.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/founderos}"
BRANCH="${DEPLOY_BRANCH:-beta}"

cd "$APP_DIR"

echo "========================================================================"
echo "FounderOS prod stabilize — branch=$BRANCH"
echo "========================================================================"

# Recover from git permission / detached-HEAD drift before deploy.
if [ -d .git/refs/heads/cursor ]; then
  rm -rf .git/refs/heads/cursor 2>/dev/null || true
fi
find .git -name '*.lock' -delete 2>/dev/null || true
git checkout -B "$BRANCH" "origin/$BRANCH" 2>/dev/null || true

# Ensure prod keeps Telegram polling on (NODE_ENV=production default is true;
# strip an explicit false if someone set it during dev debugging).
if [ -f .env ] && grep -q '^TELEGRAM_POLLING_ENABLED=false' .env 2>/dev/null; then
  sed -i '/^TELEGRAM_POLLING_ENABLED=false/d' .env
  echo "==> Removed TELEGRAM_POLLING_ENABLED=false from prod .env"
fi

export DEPLOY_BRANCH="$BRANCH"
chmod +x deploy/deploy.sh
./deploy/deploy.sh

echo ""
echo "==> Post-deploy: knowledge store row counts"
docker exec founderos-postgres psql -U founderos -d founderos -tAc \
  "SELECT 'turicks_brain', count(*) FROM brain.turicks_brain;" 2>/dev/null || \
  docker exec founderos-postgres psql -U founderos -d founderos -tAc \
  "SELECT count(*) FROM brain.turicks_brain;" 2>/dev/null || echo "!! turicks_brain query failed"

docker exec founderos-postgres psql -U founderos -d founderos -tAc \
  "SELECT 'turicks_brain_embedded', count(*) FROM brain.turicks_brain WHERE embedding IS NOT NULL;" 2>/dev/null || true

docker exec founderos-postgres psql -U founderos -d founderos -tAc \
  "SELECT 'knowledge_entries', count(*) FROM brain.knowledge_entries;" 2>/dev/null || \
  docker exec founderos-postgres psql -U founderos -d founderos -tAc \
  "SELECT count(*) FROM knowledge_entries;" 2>/dev/null || true

docker exec founderos-postgres psql -U founderos -d founderos -tAc \
  "SELECT 'personal_rag', count(*) FROM brain.personal_rag;" 2>/dev/null || true

docker exec founderos-postgres psql -U founderos -d founderos -tAc \
  "SELECT 'founder_context', count(*) FROM agents.founder_context;" 2>/dev/null || true

echo ""
echo "==> Re-sync turicks-brain (idempotent)"
if pnpm brain:sync; then
  echo "    brain:sync OK"
else
  echo "!! brain:sync FAILED" >&2
  exit 1
fi

echo ""
echo "==> Seed founder context (idempotent)"
if pnpm exec tsx scripts/seed-founder-context.ts 2>/dev/null || \
   node --env-file=.env --import tsx/esm scripts/seed-founder-context.ts; then
  echo "    seed-founder-context OK"
else
  echo "!! seed-founder-context failed (non-fatal)" >&2
fi

echo ""
echo "==> personal-rag sync (if source exists)"
PERSONAL_SRC="${HOME}/Projects/personal-rag/data/wiki.md"
if [ -f "$PERSONAL_SRC" ]; then
  if pnpm personal:sync 2>/dev/null; then
    echo "    personal:sync OK"
  else
    echo "!! personal:sync failed (non-fatal)" >&2
  fi
else
  echo "    skip — no $PERSONAL_SRC"
fi

echo ""
echo "==> gws Gmail backend"
if command -v gws >/dev/null 2>&1; then
  gws auth status 2>&1 | head -5 || echo "!! gws auth not configured — run: gws auth login"
else
  echo "!! gws CLI not installed — npm install -g @googleworkspace/cli && gws auth login"
  echo "    Or set GMAIL_BACKEND=composio in PROD_DOTENV for rollback"
fi

echo ""
echo "==> Service status"
systemctl is-active founderos || true
journalctl -u founderos -n 15 --no-pager 2>/dev/null | tail -15 || true

echo ""
echo "==> Health probes"
curl -sf http://127.0.0.1:3001/health | head -c 800 || { echo "!! /health FAILED"; exit 1; }
echo ""
curl -sf http://127.0.0.1:3001/api/v1/health | head -c 400 || { echo "!! /api/v1/health FAILED"; exit 1; }
echo ""

EMBEDDED="$(docker exec founderos-postgres psql -U founderos -d founderos -tAc \
  "SELECT count(*) FROM brain.turicks_brain WHERE embedding IS NOT NULL;" 2>/dev/null | tr -d ' ')"
if [ -n "$EMBEDDED" ] && [ "$EMBEDDED" -gt 0 ] 2>/dev/null; then
  echo "========================================================================"
  echo "✅ PROD STABILIZE OK — turicks_brain embedded rows: $EMBEDDED"
  echo "========================================================================"
else
  echo "!! turicks_brain still has 0 embedded rows — RAG will fail" >&2
  exit 1
fi
