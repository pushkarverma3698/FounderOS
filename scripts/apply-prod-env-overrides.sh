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
  printf '%s' "$PROD_DOTENV" | base64 -d > .env.tmp
  if grep -q '^DATABASE_URL=' .env.tmp; then
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

# Pin production model + OpenRouter key (same as deploy.yml).
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  grep -v -E '^(AGENT_MODEL|OPENROUTER_API_KEY|AGENT_FALLBACK_MODELS)=' .env > .env.patched || true
  {
    printf '%s\n' 'AGENT_MODEL=openrouter:google/gemini-2.5-flash'
    printf '%s\n' 'AGENT_FALLBACK_MODELS=anthropic:claude-haiku-4-5'
    printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY"
  } >> .env.patched
  mv .env.patched .env
  chmod 600 .env
  echo "==> Patched .env: AGENT_MODEL + OPENROUTER_API_KEY"
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
