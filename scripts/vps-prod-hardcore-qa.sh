#!/usr/bin/env bash
# FounderOS — production hardcore QA (same class as local stabilization campaign).
# Runs ON the VPS via GitHub Actions SSH. Idempotent.
#
#   DEPLOY_BRANCH=main PROD_QA_OUT=/tmp/founderos-prod-qa ./scripts/vps-prod-hardcore-qa.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/founderos}"
BRANCH="${DEPLOY_BRANCH:-main}"
OUT="${PROD_QA_OUT:-/tmp/founderos-prod-qa}"
RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
LOG="$OUT/hardcore-qa-${RUN_ID}.log"

mkdir -p "$OUT"
exec > >(tee -a "$LOG") 2>&1

echo "========================================================================"
echo "FounderOS PROD HARDCORE QA — branch=$BRANCH run=$RUN_ID"
echo "========================================================================"

cd "$APP_DIR"

# ── 1. Deploy latest + brain sync ────────────────────────────────────────────
export DEPLOY_BRANCH="$BRANCH"
chmod +x deploy/deploy.sh scripts/vps-prod-stabilize.sh 2>/dev/null || true
./deploy/deploy.sh

echo ""
echo "==> DB row counts (evidence)"
docker exec founderos-postgres psql -U founderos -d founderos -c \
  "SELECT 'turicks_brain' AS tbl, count(*) FROM brain.turicks_brain
   UNION ALL SELECT 'embedded', count(*) FROM brain.turicks_brain WHERE embedding IS NOT NULL
   UNION ALL SELECT 'knowledge_entries', count(*) FROM brain.knowledge_entries
   UNION ALL SELECT 'founder_context', count(*) FROM agents.founder_context;" || true

echo ""
echo "==> Sample turicks_brain query (live RAG path)"
node --env-file=.env --import tsx/esm -e "
import { searchTuricksBrainTool } from './src/tools/rag.js';
const r = await searchTuricksBrainTool.execute({ query: 'Turicks ICP ideal customer profile', top_k: 3 });
console.log(JSON.stringify({ success: r.success, preview: String(r.data ?? r.error ?? '').slice(0, 300) }, null, 2));
" 2>&1 || echo "!! RAG probe failed"

# ── 2. Office hardcore probes (same class as local probe-real-task + guards) ─
echo ""
echo "==> Office hardcore probes (Postgres checkpointer path)"
export PROD_QA_OUT="$OUT"
ALLOW_NETWORK=1 node --env-file=.env --import tsx/esm scripts/vps-prod-hardcore-probes.ts
PROBE_EXIT=$?

# ── 3. Hallucination stress (full internal-facts battery) ────────────────────
echo ""
echo "==> Hallucination stress suite"
ALLOW_NETWORK=1 node --env-file=.env --import tsx/esm scripts/hallucination-stress.ts 2>&1 | tee "$OUT/hallucination-stress-${RUN_ID}.log" || true

# ── 4. Telegram MTProto stabilization (real gateway path) ──────────────────
echo ""
echo "==> Telegram E2E stabilization (MTProto → live bot)"
if grep -q '^TELEGRAM_TESTER_SESSION=' .env 2>/dev/null; then
  ALLOW_NETWORK=1 ENGINEERING_SUBGRAPH=0 OFFICE_RECURSION_LIMIT=40 \
    node --env-file=.env --import tsx/esm scripts/e2e-telegram-qa.ts run stabilization --realistic 2>&1 \
    | tee "$OUT/e2e-stabilization-${RUN_ID}.log" || E2E_EXIT=$?
  E2E_EXIT=${E2E_EXIT:-0}
else
  echo "!! TELEGRAM_TESTER_SESSION missing — skipping MTProto E2E"
  E2E_EXIT=2
fi

# ── 5. Health + service evidence ─────────────────────────────────────────────
echo ""
echo "==> Final health"
curl -sf http://127.0.0.1:3001/health | tee "$OUT/health-${RUN_ID}.json"
echo ""
systemctl is-active founderos
journalctl -u founderos -n 20 --no-pager | tail -20

# ── Verdict ──────────────────────────────────────────────────────────────────
echo ""
echo "========================================================================"
if [ "$PROBE_EXIT" -eq 0 ] && [ "${E2E_EXIT:-0}" -eq 0 ]; then
  echo "✅ PROD HARDCORE QA PASS — probes + E2E stabilization green"
  echo "   log: $LOG"
  exit 0
elif [ "$PROBE_EXIT" -eq 0 ]; then
  echo "⚠️  PROD HARDCORE QA PARTIAL — office probes PASS, E2E exit=${E2E_EXIT:-?}"
  echo "   log: $LOG"
  exit 1
else
  echo "❌ PROD HARDCORE QA FAIL — office probes exit=$PROBE_EXIT"
  echo "   log: $LOG"
  exit 1
fi
