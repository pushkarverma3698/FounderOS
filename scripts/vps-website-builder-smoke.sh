#!/usr/bin/env bash
# Fast prod smoke — website builder E2E (no full test suite, no claude build).
# Run ON VPS: bash scripts/vps-website-builder-smoke.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/founderos}"
cd "$APP_DIR"

FAIL=0
pass() { echo "✅ $*"; }
fail() { echo "❌ $*"; FAIL=$((FAIL + 1)); }

RUN_ID="wb-smoke-$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="/tmp/founderos-wb-smoke-${RUN_ID}.log"
exec > >(tee -a "$REPORT") 2>&1

echo "========================================================================"
echo "Website Builder PROD SMOKE — $RUN_ID"
echo "host=$(hostname) sha=$(git rev-parse --short HEAD) branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
echo "========================================================================"

echo ""
echo "==> 1. Code on disk"
for f in \
  src/tools/cinematic-preset.ts \
  src/tools/deploy-static-site.ts \
  src/agents/cinematic-build.ts \
  assets/cinematic-presets/neon/index.html \
  assets/cinematic-presets/glass/index.html \
  scripts/e2e-web-design-full.ts; do
  [ -f "$f" ] && pass "$f" || fail "missing $f"
done

echo ""
echo "==> 2. Engineering tools wired (capabilities)"
node --import tsx/esm -e "
import { DEPARTMENT_TOOLS } from './src/agents/capabilities.ts';
const eng = DEPARTMENT_TOOLS.engineering.map((t) => t.name);
for (const n of ['apply_cinematic_preset','claude_code','deploy_static_site']) {
  if (!eng.includes(n)) { console.error('MISSING', n); process.exit(1); }
}
console.log('engineering tools:', eng.join(', '));
" && pass "apply_cinematic_preset + claude_code + deploy_static_site wired"

echo ""
echo "==> 3. apply_cinematic_preset (bundled neon)"
node --env-file=.env --import tsx/esm -e "
import { executeApplyCinematicPreset } from './src/tools/cinematic-preset.ts';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = mkdtempSync(join(tmpdir(), 'prod-wb-smoke-'));
process.env['PROJECT_WORKFLOW_ROOT'] = root;
const target = join(root, 'cinematic-smoke-test');
const r = executeApplyCinematicPreset({ preset: 'neon', targetDir: target, client: 'AgentOps' });
if (!r.success) { console.error('FAIL', r.error); process.exit(1); }
const html = readFileSync(join(target, 'index.html'), 'utf-8');
if (!html.includes('AgentOps')) { console.error('FAIL: client not in HTML'); process.exit(1); }
if (!existsSync(join(target, 'styles.css'))) { console.error('FAIL: styles.css missing'); process.exit(1); }
console.log('bytes', (r.data as {bytesCopied:number}).bytesCopied);
console.log('files', (r.data as {filesCopied:string[]}).filesCopied.join(', '));
rmSync(root, { recursive: true, force: true });
" && pass "apply_cinematic_preset neon → AgentOps HTML"

echo ""
echo "==> 4. deploy_static_site (home-mode smoke)"
pnpm eval:webdesign:full && pass "eval:webdesign:full (preset → customize → deploy)"

echo ""
echo "==> 5. Live showcase on disk + HTTP"
SHOWCASE_SYSTEM="/var/www/proof.turicks.com/showcase-1/index.html"
SHOWCASE_HOME="$HOME/www/proof.turicks.com/showcase-1/index.html"
SHOWCASE=""
[ -f "$SHOWCASE_SYSTEM" ] && SHOWCASE="$SHOWCASE_SYSTEM"
[ -z "$SHOWCASE" ] && [ -f "$SHOWCASE_HOME" ] && SHOWCASE="$SHOWCASE_HOME"
if [ -n "$SHOWCASE" ]; then
  BYTES=$(wc -c < "$SHOWCASE")
  pass "showcase artifact: $SHOWCASE (${BYTES} bytes)"
  grep -qi 'AgentOps' "$SHOWCASE" && pass "showcase contains AgentOps" || fail "showcase missing AgentOps"
else
  fail "no showcase-1 index.html on disk"
fi

PUBLIC_BASE="$(grep '^STATIC_SITE_PUBLIC_BASE_URL=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || echo 'http://95.217.162.12')"
PUBLIC_URL="${PUBLIC_BASE%/}/showcase-1/"
CODE=$(curl -s -o /tmp/wb-smoke-showcase.html -w '%{http_code}' --connect-timeout 15 "$PUBLIC_URL" || echo 000)
echo "    $PUBLIC_URL → HTTP $CODE"
[ "$CODE" = "200" ] && pass "public showcase HTTP 200" || fail "public showcase HTTP $CODE"

echo ""
echo "==> 6. FounderOS health"
HEALTH=$(curl -sf http://127.0.0.1:3001/health 2>/dev/null || echo '{}')
echo "$HEALTH" | head -c 500
echo ""
echo "$HEALTH" | grep -qi '"status"' && pass "/health responds" || fail "/health down"

API_HEALTH=$(curl -sf http://127.0.0.1:3001/api/v1/health 2>/dev/null || echo FAIL)
[ "$API_HEALTH" != "FAIL" ] && pass "/api/v1/health OK" || fail "/api/v1/health down"

echo ""
echo "==> 7. Claude CLI"
if command -v claude >/dev/null 2>&1; then
  pass "claude: $(which claude) ($(claude --version 2>/dev/null | head -1 || echo version-unknown))"
else
  fail "claude CLI not on PATH"
fi

echo ""
echo "==> 8. nginx"
if command -v nginx >/dev/null 2>&1 && curl -sf -o /dev/null http://127.0.0.1/showcase-1/ 2>/dev/null; then
  pass "nginx serves /showcase-1/ locally"
else
  fail "nginx not serving showcase locally"
fi

echo ""
echo "==> 9. STATIC_SITE_PUBLIC_BASE_URL"
if grep -q '^STATIC_SITE_PUBLIC_BASE_URL=' .env 2>/dev/null; then
  pass "STATIC_SITE_PUBLIC_BASE_URL=$(grep '^STATIC_SITE_PUBLIC_BASE_URL=' .env | cut -d= -f2-)"
else
  fail "STATIC_SITE_PUBLIC_BASE_URL missing from .env"
fi

echo ""
echo "========================================================================"
if [ "$FAIL" -eq 0 ]; then
  echo "✅ PROD SMOKE PASS — report: $REPORT"
  exit 0
else
  echo "❌ PROD SMOKE FAIL ($FAIL checks) — report: $REPORT"
  exit 1
fi
