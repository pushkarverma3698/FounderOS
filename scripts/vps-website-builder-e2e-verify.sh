#!/usr/bin/env bash
# Website builder E2E — production verification (run ON VPS after deploy).
# Usage: bash scripts/vps-website-builder-e2e-verify.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/founderos}"
cd "$APP_DIR"

FAIL=0
pass() { echo "✅ $*"; }
fail() { echo "❌ $*"; FAIL=$((FAIL + 1)); }
warn() { echo "⚠️  $*"; }

echo "========================================================================"
echo "Website Builder E2E — Production Verification"
echo "host: $(hostname)  branch: $(git rev-parse --abbrev-ref HEAD)  sha: $(git rev-parse --short HEAD)"
echo "========================================================================"

# ── 1. Code present ──────────────────────────────────────────────────────────
echo ""
echo "==> Tool + preset files"
for f in \
  src/tools/cinematic-preset.ts \
  src/agents/cinematic-build.ts \
  assets/cinematic-presets/neon/index.html; do
  if [ -f "$f" ]; then pass "$f exists"; else fail "missing $f"; fi
done

# ── 2. Gate (non-fatal flakes on eval routing) ───────────────────────────────
echo ""
echo "==> Lint + wiring + unit suite"
pnpm lint || fail "pnpm lint"
pnpm verify:wiring || fail "verify:wiring"
pnpm test || fail "pnpm test"

# ── 3. No-LLM pipeline ───────────────────────────────────────────────────────
echo ""
echo "==> eval:webdesign:full (preset → deploy, no LLM)"
if pnpm eval:webdesign:full; then pass "eval:webdesign:full"; else fail "eval:webdesign:full"; fi

# ── 4. Live showcase deploy ──────────────────────────────────────────────────
echo ""
echo "==> Live showcase deploy + HTTP"
if bash scripts/vps-live-showcase.sh 2>&1 | tee /tmp/vps-wb-e2e-showcase.log | tail -20; then
  pass "vps-live-showcase.sh"
else
  fail "vps-live-showcase.sh — see /tmp/vps-wb-e2e-showcase.log"
fi

# ── 5. Public URL ────────────────────────────────────────────────────────────
echo ""
echo "==> Public showcase URL"
PUBLIC_BASE="$(grep '^STATIC_SITE_PUBLIC_BASE_URL=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || echo 'http://95.217.162.12')"
PUBLIC_URL="${PUBLIC_BASE%/}/showcase-1/"
CODE="$(curl -s -o /tmp/wb-showcase.html -w '%{http_code}' --connect-timeout 12 "$PUBLIC_URL" 2>/dev/null || echo 000)"
echo "    $PUBLIC_URL → HTTP $CODE"
if [ "$CODE" = "200" ] && grep -qi 'AgentOps\|html' /tmp/wb-showcase.html; then
  pass "public showcase reachable"
else
  warn "public URL not 200 — check nginx + STATIC_SITE_PUBLIC_BASE_URL"
fi

# ── 6. Claude CLI ────────────────────────────────────────────────────────────
echo ""
echo "==> Claude Code CLI"
if command -v claude >/dev/null 2>&1; then
  pass "claude on PATH: $(which claude)"
else
  warn "claude CLI missing — Telegram build HITL will fail until claude login"
fi

# ── 7. FounderOS health ──────────────────────────────────────────────────────
echo ""
echo "==> /health"
if curl -sf http://127.0.0.1:3001/health >/dev/null; then
  pass "founderos /health 200"
else
  fail "founderos /health down"
fi

# ── 8. Manual Telegram step (cannot automate here) ───────────────────────────
echo ""
echo "==> MANUAL (founder Telegram MTProto):"
echo "    /webbuild AgentOps neon showcase-1"
echo "    → approve claude_code HITL"
echo "    → approve deploy_static_site HITL"
echo "    → confirm URL in reply + action_log rows"

echo ""
echo "========================================================================"
if [ "$FAIL" -eq 0 ]; then
  echo "✅ AUTOMATED WEBSITE BUILDER E2E VERIFY PASS ($FAIL failures)"
  exit 0
else
  echo "❌ WEBSITE BUILDER E2E VERIFY FAILED ($FAIL automated failures)"
  exit 1
fi
