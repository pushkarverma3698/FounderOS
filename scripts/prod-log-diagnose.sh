#!/usr/bin/env bash
# Quick prod diagnosis: DB state + recent log patterns for hallucination class bugs.
# Run on the VPS: cd /opt/founderos && bash scripts/prod-log-diagnose.sh
set -euo pipefail

cd "$(dirname "$0")/.."
DAYS="${1:-2}"
PG="docker exec founderos-postgres psql -U founderos -d founderos -t -A"

echo "=== FounderOS prod diagnose ($(date -u +%Y-%m-%dT%H:%M:%SZ)) ==="
echo ""

echo "--- Service ---"
systemctl is-active founderos 2>/dev/null || echo "founderos: unknown"
echo ""

echo "--- DB row counts ---"
$PG -c "
SELECT
  'knowledge_entries=' || (SELECT count(*)::text FROM brain.knowledge_entries) ||
  ' turicks_brain=' || (SELECT count(*)::text FROM brain.turicks_brain) ||
  ' null_emb=' || (SELECT count(*)::text FROM brain.turicks_brain WHERE embedding IS NULL) ||
  ' personal_rag=' || (SELECT count(*)::text FROM brain.personal_rag);
"
echo ""

echo "--- founder_context (turicks) ---"
$PG -c "SELECT data FROM agents.founder_context WHERE tenant_id = 'turicks';" | head -5
echo ""

echo "--- Recent empty knowledge searches (last ${DAYS}d) ---"
journalctl -u founderos --since "${DAYS} days ago" -o cat --no-pager 2>/dev/null \
  | grep -F 'No knowledge entries found' | tail -10 || echo "(none)"
echo ""

echo "--- Recent 'No memory found' (last ${DAYS}d) ---"
journalctl -u founderos --since "${DAYS} days ago" -o cat --no-pager 2>/dev/null \
  | grep -F 'No memory found' | tail -10 || echo "(none)"
echo ""

echo "--- Recent guard.retry / guard.blocked seams (last ${DAYS}d) ---"
journalctl -u founderos --since "${DAYS} days ago" -o cat --no-pager 2>/dev/null \
  | grep -E '"seam":"guard\.(retry|blocked)"' | tail -10 || echo "(none)"
echo ""

echo "--- Log review harvest (last ${DAYS}d) ---"
journalctl -u founderos --since "${DAYS} days ago" -o cat --no-pager 2>/dev/null \
  | grep -E '"seam"|"level":(4|5)0' \
  | pnpm -s logreview --days="${DAYS}" --out=/tmp/founderos-digest.json 2>/dev/null \
  | tail -20 || echo "(logreview failed or no trace lines)"
echo ""
echo "Full digest: /tmp/founderos-digest.json"
