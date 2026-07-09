#!/usr/bin/env bash
# THE single renderer of /opt/founderos/.env from GitHub Actions secrets.
# Called by deploy / stabilize / launch-gate workflows before running deploy
# scripts. deploy.yml must NOT render .env itself — a second inline render is
# how the TELEGRAM_TESTER_SESSION preservation drifted and got clobbered.
#
# Inputs (env vars forwarded by appleboy/ssh-action):
#   PROD_DOTENV          — base64-encoded full .env (required for DATABASE_URL)
#   GOOGLE_GENERATIVE_AI_API_KEY — primary model key (AGENT_MODEL pins to
#                          google-genai:gemini-2.5-flash); MUST be set or prod 401s
#   OPENROUTER_API_KEY   — free-tier fallback path key
#   LINKEDIN_ACCESS_TOKEN — optional override
#   LINKEDIN_AUTHOR_URN   — optional override
#   SLACK_BOT_TOKEN / SLACK_TEAM_ID — MCP bridge Slack server (optional)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/founderos}"
cd "$APP_DIR"

# Runtime values OWNED BY THE BOX, never by the PROD_DOTENV snapshot:
# - TELEGRAM_TESTER_SESSION is written by an on-box re-login; rendering a stale
#   copy makes Telegram revoke the auth key (AUTH_KEY_DUPLICATED) every deploy.
#   The box value always wins.
# - Provisioned keys (Firecrawl/Composio/Gmail backend) may postdate the
#   PROD_DOTENV snapshot. The secret wins when it has them; the box value is
#   preserved only when the render would otherwise DELETE a working key.
PRESERVE_IF_MISSING="FIRECRAWL_API_KEY COMPOSIO_API_KEY GMAIL_BACKEND"

if [ -n "${PROD_DOTENV:-}" ]; then
  umask 077
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
    for key in $PRESERVE_IF_MISSING; do
      if ! grep -q "^${key}=" .env.tmp && [ -f .env ]; then
        BOX_LINE="$(grep -E "^${key}=" .env | head -1 || true)"
        if [ -n "$BOX_LINE" ]; then
          printf '%s\n' "$BOX_LINE" >> .env.tmp
          echo "==> Preserved on-box ${key} (absent from PROD_DOTENV)"
        fi
      fi
    done
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

# Pin production model (same as deploy.yml). 2026-07-09: reverted to direct
# Gemini after proving google-genai:gemini-2.5-flash tool-calls cleanly on the
# live box (the earlier "malformed Gemini" note was gemini-2.5-PRO, not flash).
# anthropic:claude-haiku-4-5 is unusable in prod — there is no ANTHROPIC_API_KEY,
# so it 401s on every message. Fallback = FREE OpenRouter models only (founder
# directive: no paid fallback).
grep -v -E '^(AGENT_MODEL|AGENT_FALLBACK_MODELS)=' .env > .env.patched || true
{
  printf '%s\n' 'AGENT_MODEL=google-genai:gemini-2.5-flash'
  printf '%s\n' 'AGENT_FALLBACK_MODELS=openrouter:meta-llama/llama-3.3-70b-instruct:free,openrouter:qwen/qwen3-next-80b-a3b-instruct:free'
} >> .env.patched
mv .env.patched .env
chmod 600 .env
echo "==> Patched .env: AGENT_MODEL=google-genai:gemini-2.5-flash"
# Primary model key — forwarded from a GitHub secret so a PROD_DOTENV re-render
# can never wipe it. Without this the direct-Gemini path 401s.
if [ -n "${GOOGLE_GENERATIVE_AI_API_KEY:-}" ]; then
  grep -v -E '^GOOGLE_GENERATIVE_AI_API_KEY=' .env > .env.patched || true
  printf 'GOOGLE_GENERATIVE_AI_API_KEY=%s\n' "$GOOGLE_GENERATIVE_AI_API_KEY" >> .env.patched
  mv .env.patched .env
  chmod 600 .env
  echo "==> Patched .env: GOOGLE_GENERATIVE_AI_API_KEY refreshed (primary model)"
fi
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  grep -v -E '^OPENROUTER_API_KEY=' .env > .env.patched || true
  printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY" >> .env.patched
  mv .env.patched .env
  chmod 600 .env
  echo "==> Patched .env: OPENROUTER_API_KEY refreshed (fallback path)"
fi

# MCP bridge Slack secrets — separate GitHub secrets so they rotate without
# re-encoding the entire PROD_DOTENV blob. Appended only when set.
if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
  grep -v -E '^(SLACK_BOT_TOKEN|SLACK_TEAM_ID)=' .env > .env.patched || true
  {
    printf 'SLACK_BOT_TOKEN=%s\n' "$SLACK_BOT_TOKEN"
    [ -n "${SLACK_TEAM_ID:-}" ] && printf 'SLACK_TEAM_ID=%s\n' "$SLACK_TEAM_ID"
  } >> .env.patched
  mv .env.patched .env
  chmod 600 .env
  echo "==> Patched .env: SLACK_BOT_TOKEN + SLACK_TEAM_ID set"
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
