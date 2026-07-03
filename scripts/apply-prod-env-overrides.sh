#!/usr/bin/env bash
# Apply production .env on VPS from GitHub Actions secrets.
# Called by deploy / stabilize / launch-gate workflows before running deploy scripts.
#
# Inputs (env vars forwarded by appleboy/ssh-action):
#   PROD_DOTENV          — base64-encoded full .env (required for DATABASE_URL)
#   OPENROUTER_API_KEY   — optional override (pins AGENT_MODEL)
#   LINKEDIN_ACCESS_TOKEN — optional override
#   LINKEDIN_AUTHOR_URN   — optional override
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/founderos}"
cd "$APP_DIR"

if [ -n "${PROD_DOTENV:-}" ]; then
  umask 077
  # Preserve the live on-box MTProto tester session across the render.
  # TELEGRAM_TESTER_SESSION is a RUNTIME artifact (written by an on-box re-login),
  # NOT part of PROD_DOTENV. Without this, the render reverts it to the stale value
  # baked into the secret and Telegram revokes the auth key (AUTH_KEY_DUPLICATED),
  # breaking every MTProto E2E QA run. The same fix exists inline in deploy.yml, but
  # it MUST also live here: this script is the LAST writer of .env in both the deploy
  # and the hardcore-QA workflows, so a workflow-only copy is silently undone here.
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
      echo "==> Preserved on-box TELEGRAM_TESTER_SESSION across .env render"
    fi
    mv .env.tmp .env
    chmod 600 .env
    echo "==> Rendered .env from PROD_DOTENV"
  else
    rm -f .env.tmp
    echo "!! PROD_DOTENV invalid (no DATABASE_URL)" >&2
    exit 1
  fi
else
  echo "==> PROD_DOTENV not set; using existing .env on box"
fi

# Pin production model + OpenRouter key. MUST match deploy.yml — this script runs
# LAST, so whatever it writes here is the model the bot actually boots with. It
# previously hard-coded gemini-2.5-flash, which silently reverted the Pro pin that
# deploy.yml (and PR #257) set, so the Pro reliability trial never actually ran in
# prod. Keep this the single source of truth for the production model.
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  grep -v -E '^(AGENT_MODEL|OPENROUTER_API_KEY|AGENT_FALLBACK_MODELS)=' .env > .env.patched || true
  {
    printf '%s\n' 'AGENT_MODEL=openrouter:google/gemini-2.5-pro'
    printf '%s\n' 'AGENT_FALLBACK_MODELS=openrouter:google/gemini-2.5-flash,anthropic:claude-haiku-4-5'
    printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY"
  } >> .env.patched
  mv .env.patched .env
  chmod 600 .env
  echo "==> Patched .env: AGENT_MODEL=openrouter:google/gemini-2.5-pro + OPENROUTER_API_KEY"
fi

# LinkedIn direct API — separate secrets so founder can update without re-encoding PROD_DOTENV.
if [ -n "${LINKEDIN_ACCESS_TOKEN:-}" ] || [ -n "${LINKEDIN_AUTHOR_URN:-}" ]; then
  grep -v -E '^(LINKEDIN_ACCESS_TOKEN|LINKEDIN_AUTHOR_URN|LINKEDIN_BACKEND)=' .env > .env.patched || true
  mv .env.patched .env
  if [ -n "${LINKEDIN_ACCESS_TOKEN:-}" ]; then
    printf 'LINKEDIN_ACCESS_TOKEN=%s\n' "$LINKEDIN_ACCESS_TOKEN" >> .env
    echo "==> Patched .env: LINKEDIN_ACCESS_TOKEN set"
  fi
  if [ -n "${LINKEDIN_AUTHOR_URN:-}" ]; then
    printf 'LINKEDIN_AUTHOR_URN=%s\n' "$LINKEDIN_AUTHOR_URN" >> .env
    echo "==> Patched .env: LINKEDIN_AUTHOR_URN set"
  fi
  printf '%s\n' 'LINKEDIN_BACKEND=direct' >> .env
  chmod 600 .env
fi

# Static-site serving defaults — survive every .env re-render so deploy_static_site
# publishes into the nginx-served /var/www tree with a public URL (not 127.0.0.1).
# Only injected when absent, so an explicit PROD_DOTENV value still wins.
if ! grep -q '^STATIC_SITE_PUBLIC_BASE_URL=' .env; then
  printf 'STATIC_SITE_PUBLIC_BASE_URL=http://YOUR_VPS_IP\n' >> .env
  echo "==> Patched .env: STATIC_SITE_PUBLIC_BASE_URL default"
fi
if ! grep -q '^STATIC_SITE_HOME_ROOT=' .env; then
  printf 'STATIC_SITE_HOME_ROOT=/var/www\n' >> .env
  echo "==> Patched .env: STATIC_SITE_HOME_ROOT default"
fi
chmod 600 .env
