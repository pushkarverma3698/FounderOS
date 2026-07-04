#!/usr/bin/env bash
#
# Regression test for the AUTH_KEY_DUPLICATED root cause (rule #19).
#
# The production deploy renders /opt/founderos/.env from the PROD_DOTENV secret.
# The live MTProto tester session (TELEGRAM_TESTER_SESSION) is a RUNTIME artifact
# written on the box by a re-login — it is NOT in PROD_DOTENV. Before the fix, the
# render reverted it to a stale value, so Telegram revoked the auth key on every
# deploy. This test asserts the render PRESERVES the on-box session.
#
# It mirrors the exact shell logic in .github/workflows/deploy.yml. If that block
# changes, mirror it here so the test keeps proving the real behaviour.
#
# Run:  bash scripts/test-deploy-env-render.sh
set -euo pipefail

# Resolve the repo root BEFORE cd'ing away, so we can invoke the real script.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

fail() { echo "FAIL: $1" >&2; exit 1; }

LIVE_SESSION="1ApWapzMBuLIVE_SESSION_VALUE_xyz=="
STALE_SESSION="1ApWapzMBuSTALE_SESSION_FROM_SECRET=="

# --- Arrange: an on-box .env carrying the LIVE session from a recent re-login.
cat > .env <<EOF
DATABASE_URL=postgres://founderos:pw@localhost:5432/founderos
TELEGRAM_TESTER_SESSION=$LIVE_SESSION
TELEGRAM_BOT_TOKEN=123:abc
EOF

# The secret (PROD_DOTENV) carries a STALE session that must NOT win.
PROD_DOTENV="$(printf '%s\n' \
  "DATABASE_URL=postgres://founderos:pw@localhost:5432/founderos" \
  "TELEGRAM_TESTER_SESSION=$STALE_SESSION" \
  "TELEGRAM_BOT_TOKEN=123:abc" | base64 | tr -d '\n')"

# --- Act: the deploy.yml render block (kept in sync with the workflow).
PRESERVE_SESSION=""
if [ -f .env ]; then
  PRESERVE_SESSION="$(grep -E '^TELEGRAM_TESTER_SESSION=' .env | head -1 || true)"
fi
printf '%s' "$PROD_DOTENV" | base64 -d > .env.tmp
if grep -q '^DATABASE_URL=' .env.tmp; then
  if [ -n "$PRESERVE_SESSION" ]; then
    grep -v -E '^TELEGRAM_TESTER_SESSION=' .env.tmp > .env.tmp2 || true
    printf '%s\n' "$PRESERVE_SESSION" >> .env.tmp2
    mv .env.tmp2 .env.tmp
  fi
  mv .env.tmp .env
else
  fail "decoded PROD_DOTENV missing DATABASE_URL (test fixture broken)"
fi

# --- Assert.
RENDERED="$(grep -E '^TELEGRAM_TESTER_SESSION=' .env | head -1 | cut -d= -f2-)"
[ "$RENDERED" = "$LIVE_SESSION" ] || fail "expected LIVE session preserved, got: $RENDERED"
[ "$(grep -c -E '^TELEGRAM_TESTER_SESSION=' .env)" = "1" ] || fail "expected exactly one session line"
grep -q "$STALE_SESSION" .env && fail "stale session from secret leaked into .env"

# --- Negative control: no on-box .env (fresh box) → falls through cleanly.
rm -f .env
PRESERVE_SESSION=""
[ -f .env ] && PRESERVE_SESSION="$(grep -E '^TELEGRAM_TESTER_SESSION=' .env | head -1 || true)"
printf '%s' "$PROD_DOTENV" | base64 -d > .env.tmp
[ -n "$PRESERVE_SESSION" ] && fail "no .env should mean empty PRESERVE_SESSION"
mv .env.tmp .env
grep -q "$STALE_SESSION" .env || fail "fresh box should accept secret's session"

echo "PASS: deploy.yml inline render preserves on-box TELEGRAM_TESTER_SESSION (2 assertions + negative control)"

# ── REAL last-writer path: scripts/apply-prod-env-overrides.sh ───────────────
# The workflow-inline block above is correct, but apply-prod-env-overrides.sh is
# the script that writes .env LAST in every workflow (deploy + hardcore-QA). The
# 2026-07-01 prod incident: this shared script did NOT preserve the session (→
# AUTH_KEY_DUPLICATED) and hard-coded gemini-2.5-flash (→ the Pro pin never took
# effect). This asserts the REAL script, not a copy, does both correctly.
cat > .env <<EOF
DATABASE_URL=postgres://founderos:pw@localhost:5432/founderos
TELEGRAM_TESTER_SESSION=$LIVE_SESSION
TELEGRAM_BOT_TOKEN=123:abc
EOF
APP_DIR="$WORK" PROD_DOTENV="$PROD_DOTENV" OPENROUTER_API_KEY="test-key" \
  bash "$REPO_ROOT/scripts/apply-prod-env-overrides.sh" >/dev/null

REAL_SESSION="$(grep -E '^TELEGRAM_TESTER_SESSION=' .env | head -1 | cut -d= -f2-)"
[ "$REAL_SESSION" = "$LIVE_SESSION" ] || fail "apply-prod-env-overrides.sh clobbered the live session (AUTH_KEY_DUPLICATED root cause)"
grep -q "$STALE_SESSION" .env && fail "stale session leaked through apply-prod-env-overrides.sh"
grep -q '^AGENT_MODEL=openrouter:google/gemini-2.5-pro$' .env || fail "apply-prod-env-overrides.sh did not pin Gemini 2.5 Pro (silent Flash revert)"
grep -q '^AGENT_FALLBACK_MODELS=openrouter:google/gemini-2.5-flash,anthropic:claude-haiku-4-5$' .env || fail "apply-prod-env-overrides.sh fallback chain not Flash→Haiku"

echo "PASS: apply-prod-env-overrides.sh (real last writer) preserves session + pins Pro"
