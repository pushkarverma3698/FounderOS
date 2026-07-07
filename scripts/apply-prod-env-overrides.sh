#!/usr/bin/env bash
# Apply production .env on VPS from GitHub Actions secrets.
# Called by deploy / stabilize / launch-gate workflows before running deploy scripts.
#
# Inputs (env vars forwarded by appleboy/ssh-action):
#   PROD_DOTENV          — base64-encoded full .env (required for DATABASE_URL)
#   OPENROUTER_API_KEY   — optional override (fallback path; AGENT_MODEL pins to
#                          google-genai:gemini-2.5-pro regardless of this var)
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

# Pin production model (same as deploy.yml). 2026-07-07: OpenRouter account
# credits exhausted (402); direct Gemini (google-genai) produced empty/malformed
# tool-calling output in this graph (untested integration). Switched to
# anthropic:claude-haiku-4-5, already the vetted fallback in this codepath.
grep -v -E '^(AGENT_MODEL|AGENT_FALLBACK_MODELS)=' .env > .env.patched || true
{
  printf '%s\n' 'AGENT_MODEL=anthropic:claude-haiku-4-5'
  printf '%s\n' 'AGENT_FALLBACK_MODELS=anthropic:claude-haiku-4-5'
} >> .env.patched
mv .env.patched .env
chmod 600 .env
echo "==> Patched .env: AGENT_MODEL=anthropic:claude-haiku-4-5"
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  grep -v -E '^OPENROUTER_API_KEY=' .env > .env.patched || true
  printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY" >> .env.patched
  mv .env.patched .env
  chmod 600 .env
  echo "==> Patched .env: OPENROUTER_API_KEY refreshed (fallback path)"
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
