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

echo "PASS: deploy render preserves on-box TELEGRAM_TESTER_SESSION (2 assertions + negative control)"
