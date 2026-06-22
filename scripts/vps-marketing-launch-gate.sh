#!/usr/bin/env bash
# FounderOS — Marketing Launch Readiness Gate (run ON the VPS).
#
# Verifies the full stack needed to start Phase D-Bis GTM:
#   deploy + real brain (RAG + founder context) + office probes + integrations + showcase
#
#   DEPLOY_BRANCH=main bash scripts/vps-marketing-launch-gate.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/founderos}"
BRANCH="${DEPLOY_BRANCH:-main}"
OUT="${LAUNCH_GATE_OUT:-/tmp/founderos-launch-gate}"
RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
LOG="$OUT/launch-gate-${RUN_ID}.log"

mkdir -p "$OUT"
exec > >(tee -a "$LOG") 2>&1

FAIL=0
WARN=0

warn() { echo "⚠️  WARN: $*"; WARN=$((WARN + 1)); }
fail() { echo "❌ FAIL: $*"; FAIL=$((FAIL + 1)); }

echo "========================================================================"
echo "FounderOS MARKETING LAUNCH GATE — branch=$BRANCH run=$RUN_ID"
echo "========================================================================"

cd "$APP_DIR"

# ── 1. Full stabilize (deploy + brain + founder context) ─────────────────────
export DEPLOY_BRANCH="$BRANCH"
chmod +x deploy/deploy.sh scripts/vps-prod-stabilize.sh scripts/vps-prod-hardcore-probes.ts 2>/dev/null || true

if ! DEPLOY_BRANCH="$BRANCH" bash scripts/vps-prod-stabilize.sh; then
  fail "vps-prod-stabilize.sh did not pass"
else
  echo "✅ Stabilize OK"
fi

# ── 2. DB evidence (real brain) ──────────────────────────────────────────────
echo ""
echo "==> Brain row counts"
docker exec founderos-postgres psql -U founderos -d founderos -c \
  "SELECT 'turicks_brain' AS tbl, count(*) FROM brain.turicks_brain
   UNION ALL SELECT 'embedded', count(*) FROM brain.turicks_brain WHERE embedding IS NOT NULL
   UNION ALL SELECT 'knowledge_entries', count(*) FROM brain.knowledge_entries
   UNION ALL SELECT 'founder_context', count(*) FROM agents.founder_context;" || fail "DB count query failed"

EMBEDDED="$(docker exec founderos-postgres psql -U founderos -d founderos -tAc \
  "SELECT count(*) FROM brain.turicks_brain WHERE embedding IS NOT NULL;" 2>/dev/null | tr -d ' ')"
if [ -z "$EMBEDDED" ] || [ "$EMBEDDED" -le 0 ] 2>/dev/null; then
  fail "turicks_brain has 0 embedded rows"
else
  echo "✅ turicks_brain embedded: $EMBEDDED"
fi

# Live RAG probe
echo ""
echo "==> Live RAG probe (ICP path)"
node --env-file=.env --import tsx/esm -e "
import { searchTuricksBrainTool } from './src/tools/rag.js';
const r = await searchTuricksBrainTool.execute({ query: 'Turicks ICP ideal customer profile positioning', top_k: 3 });
if (!r.success) { console.error('RAG FAIL:', r.error); process.exit(1); }
const text = String(r.data ?? '');
if (!/positioning|ICP|dev-tool|startup/i.test(text)) { console.error('RAG weak:', text.slice(0,200)); process.exit(1); }
console.log('✅ RAG OK:', text.slice(0, 180).replace(/\n/g, ' '));
" || fail "Live RAG probe failed"

# Founder context freshness (Phase D-Bis keywords)
echo ""
echo "==> Founder context probe"
node --env-file=.env --import tsx/esm scripts/probe-founder-context-fresh.ts || fail "Founder context stale or missing"

# ── 3. Office hardcore probes (same as local stabilization) ──────────────────
echo ""
echo "==> Office hardcore probes"
export PROD_QA_OUT="$OUT"
if ALLOW_NETWORK=1 node --env-file=.env --import tsx/esm scripts/vps-prod-hardcore-probes.ts; then
  echo "✅ Office probes PASS"
else
  fail "Office hardcore probes failed"
fi

# ── 4. Outbound integrations (marketing campaign blockers) ───────────────────
echo ""
echo "==> Outbound integration checks"

if grep -q '^LINKEDIN_ACCESS_TOKEN=.\+' .env 2>/dev/null && grep -q '^LINKEDIN_AUTHOR_URN=.\+' .env 2>/dev/null; then
  if node --env-file=.env --import tsx/esm scripts/probe-linkedin-token-live.ts; then
    echo "✅ LinkedIn direct API credentials present and token validates"
  else
    fail "LinkedIn token configured but API validation failed — refresh OAuth token"
  fi
else
  warn "LINKEDIN_ACCESS_TOKEN or LINKEDIN_AUTHOR_URN missing — linkedin_post will fail at send"
fi

if command -v gws >/dev/null 2>&1 && gws auth status 2>&1 | grep -qi 'authenticated\|logged in\|valid'; then
  echo "✅ gws Gmail backend authenticated"
elif grep -q '^GMAIL_BACKEND=composio' .env 2>/dev/null && grep -q '^COMPOSIO_API_KEY=.\+' .env 2>/dev/null; then
  echo "✅ Gmail via Composio rollback configured"
else
  warn "Gmail not ready — gws not authed and Composio rollback not configured (Proof Drop email blocked)"
fi

# ── 5. Website builder tools (preset + no-LLM deploy path) ─────────────────
echo ""
echo "==> Website builder tool smoke (apply_cinematic_preset + eval:webdesign:full)"

node --env-file=.env --import tsx/esm -e "
import { DEPARTMENT_TOOLS } from './src/agents/capabilities.ts';
const eng = DEPARTMENT_TOOLS.engineering.map((t) => t.name);
for (const n of ['apply_cinematic_preset','claude_code','deploy_static_site']) {
  if (!eng.includes(n)) { console.error('MISSING engineering tool:', n); process.exit(1); }
}
console.log('engineering tools:', eng.filter((t) => ['apply_cinematic_preset','claude_code','deploy_static_site'].includes(t)).join(', '));
" || fail "engineering tools not wired"

node --env-file=.env --import tsx/esm -e "
import { executeApplyCinematicPreset } from './src/tools/cinematic-preset.ts';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = mkdtempSync(join(tmpdir(), 'launch-gate-wb-'));
process.env['PROJECT_WORKFLOW_ROOT'] = root;
const target = join(root, 'cinematic-smoke-test');
const r = executeApplyCinematicPreset({ preset: 'neon', targetDir: target, client: 'AgentOps' });
if (!r.success) { console.error('apply_cinematic_preset FAIL:', r.error); process.exit(1); }
const html = readFileSync(join(target, 'index.html'), 'utf-8');
if (!html.includes('AgentOps')) { console.error('FAIL: client not in HTML'); process.exit(1); }
if (!existsSync(join(target, 'styles.css'))) { console.error('FAIL: styles.css missing'); process.exit(1); }
console.log('✅ apply_cinematic_preset neon → AgentOps HTML, bytes', (r.data as {bytesCopied:number}).bytesCopied);
rmSync(root, { recursive: true, force: true });
" || fail "apply_cinematic_preset smoke failed"

if pnpm eval:webdesign:full; then
  echo "✅ eval:webdesign:full (preset → deploy, no LLM)"
else
  fail "eval:webdesign:full failed on VPS"
fi

# ── 6. Website builder / showcase (client-facing proof) ──────────────────────
echo ""
echo "==> Website builder showcase check"

SHOWCASE_SYSTEM="/var/www/proof.turicks.com/showcase-1/index.html"
SHOWCASE_HOME="$HOME/www/proof.turicks.com/showcase-1/index.html"
SHOWCASE_FILE=""
if [ -f "$SHOWCASE_SYSTEM" ]; then SHOWCASE_FILE="$SHOWCASE_SYSTEM"; fi
if [ -z "$SHOWCASE_FILE" ] && [ -f "$SHOWCASE_HOME" ]; then SHOWCASE_FILE="$SHOWCASE_HOME"; fi

if [ -n "$SHOWCASE_FILE" ]; then
  BYTES="$(wc -c < "$SHOWCASE_FILE")"
  echo "✅ showcase-1 artifact exists ($SHOWCASE_FILE, ${BYTES} bytes)"
  if [ "$BYTES" -lt 500 ]; then warn "showcase-1 index.html suspiciously small"; fi
else
  warn "showcase-1 not deployed — run: bash scripts/vps-live-showcase.sh"
fi

PUBLIC_BASE="$(grep '^STATIC_SITE_PUBLIC_BASE_URL=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || echo 'http://YOUR_VPS_IP')"
PUBLIC_URL="${PUBLIC_BASE%/}/showcase-1/"
LOCAL_CODE="$(curl -s -o /tmp/launch-showcase.html -w '%{http_code}' --connect-timeout 8 "$PUBLIC_URL" 2>/dev/null || echo 000)"
echo "    $PUBLIC_URL → HTTP $LOCAL_CODE"
if [ "$LOCAL_CODE" = "200" ]; then
  echo "✅ Public showcase URL reachable"
elif [ -n "$SHOWCASE_FILE" ]; then
  warn "Showcase file exists but public URL not reachable (nginx/DNS/ufw?) — use deploy + vps-proof-nginx-setup.sh"
else
  warn "No live showcase URL for marketing campaign"
fi

# ── 7. JARVIS + health ───────────────────────────────────────────────────────
echo ""
echo "==> Health"
curl -sf http://127.0.0.1:3001/health | tee "$OUT/health-${RUN_ID}.json" >/dev/null || fail "/health not green"
curl -sf http://127.0.0.1:3001/api/v1/health >/dev/null || fail "/api/v1/health failed"
echo "✅ FounderOS + JARVIS health green"

# ── Verdict ──────────────────────────────────────────────────────────────────
echo ""
echo "========================================================================"
if [ "$FAIL" -eq 0 ] && [ "$WARN" -eq 0 ]; then
  echo "✅ MARKETING LAUNCH GATE PASS — FounderOS brain + probes + showcase ready"
  echo "   log: $LOG"
  exit 0
elif [ "$FAIL" -eq 0 ]; then
  echo "⚠️  MARKETING LAUNCH GATE CONDITIONAL — core brain OK, $WARN warning(s)"
  echo "   You can start LinkedIn drafts; fix warnings before Proof Drop sends."
  echo "   log: $LOG"
  exit 0
else
  echo "❌ MARKETING LAUNCH GATE FAIL — $FAIL blocker(s), $WARN warning(s)"
  echo "   log: $LOG"
  exit 1
fi
