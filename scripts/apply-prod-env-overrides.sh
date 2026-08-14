#!/usr/bin/env bash
# THE single renderer of /opt/founderos/.env from GitHub Actions secrets.
# Called by deploy / stabilize / launch-gate workflows before running deploy
# scripts. deploy.yml must NOT render .env itself — a second inline render is
# how the TELEGRAM_TESTER_SESSION preservation drifted and got clobbered.
#
# Inputs (env vars forwarded by appleboy/ssh-action):
#   PROD_DOTENV          — base64-encoded full .env (required for DATABASE_URL)
#   GOOGLE_GENERATIVE_AI_API_KEY — primary model key (AGENT_MODEL pins to
#                          google-genai:gemini-flash-latest); MUST be set or prod 401s
#   OPENROUTER_API_KEY   — free-tier fallback path key
#   LINKEDIN_ACCESS_TOKEN — optional override
#   LINKEDIN_AUTHOR_URN   — optional override
#   SLACK_BOT_TOKEN / SLACK_TEAM_ID — MCP bridge Slack server (optional)
#   LANGCHAIN_API_KEY    — LangSmith tracing (optional; sets LANGCHAIN_TRACING_V2=true when present)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/founderos}"
cd "$APP_DIR"

# Runtime values OWNED BY THE BOX, never by the PROD_DOTENV snapshot:
# - TELEGRAM_TESTER_SESSION is written by an on-box re-login; rendering a stale
#   copy makes Telegram revoke the auth key (AUTH_KEY_DUPLICATED) every deploy.
#   The box value always wins.
# - Provisioned keys may postdate the PROD_DOTENV snapshot. The secret wins when
#   it has a NON-EMPTY value; the box value is preserved when the render would
#   otherwise DELETE or BLANK a working key. 2026-07-12: the post-#325 render
#   wiped on-box APIFY_TOKEN + STORAGE_*/AWS_* (S3 went LIVE→MISSING between
#   boots) because they were not listed here.
#   2026-08-01: PERSONAL_CV_DIR/PERSONAL_CV_PATH point at on-box files that only
#   exist on the VPS. Losing them does not fail loudly — every posting simply
#   scores 0 overlap and the ranked brief silently degrades to arbitrary order.
PRESERVE_IF_MISSING="FIRECRAWL_API_KEY COMPOSIO_API_KEY GMAIL_BACKEND APIFY_TOKEN SCRAPE_BACKEND STORAGE_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY STORAGE_ENDPOINT_URL WEB_GATEWAY_TOKEN GWS_BIN MEM0_API_KEY REDIS_URL GOOGLE_APPLICATION_CREDENTIALS OFFICE_TURN_TIMEOUT_MS MCP_BRIDGE_ENABLED PERSONAL_CV_DIR PERSONAL_CV_PATH"

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
      # "Missing" = absent OR present-but-empty: an empty snapshot line must not
      # clobber a provisioned box value (GWS_BIN= broke every gws probe with
      # execFile("") on 2026-07-12). Box values must themselves be non-empty.
      if ! grep -qE "^${key}=." .env.tmp && [ -f .env ]; then
        BOX_LINE="$(grep -E "^${key}=." .env | head -1 || true)"
        if [ -n "$BOX_LINE" ]; then
          grep -v -E "^${key}=" .env.tmp > .env.tmp2 || true
          mv .env.tmp2 .env.tmp
          printf '%s\n' "$BOX_LINE" >> .env.tmp
          echo "==> Preserved on-box ${key} (absent/empty in PROD_DOTENV)"
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

# Pin production model (same as deploy.yml). 2026-07-11: gemini-2.5-flash
# retired — the Google Generative Language API now 404s it for the founder's
# billing-enabled project ("no longer available to new users", verified live
# against every gemini-2.5-flash* id). gemini-flash-latest is Google's rolling
# alias to the current stable Flash model (resolved to gemini-3.5-flash at
# verification time) and is confirmed live with the current key.
# anthropic:claude-haiku-4-5 is unusable in prod — there is no ANTHROPIC_API_KEY,
# so it 401s on every message. 2026-07-13: gemini-flash-latest (→ gemini-3.5-flash)
# returned persistent 503 "high demand" all afternoon and the free-only fallback
# chain exhausted (429/402) — 14/15 turns died. gemini-3-flash-preview and
# gemini-3.1-flash-lite were live-verified serving + tool-calling on the founder's
# paid key (1K RPM/10K RPD and 4K RPM/150K RPD headroom), so they sit FIRST in the
# chain; FREE OpenRouter models stay as the last resort (founder directive: no
# paid OpenRouter fallback — same-key Gemini fallbacks are covered by paid quota).
# 2026-07-17: a prior edit replaced this chain with gemini-2.5-pro and
# gemini-2-flash — BOTH return 404 on the prod key (live-probed today), leaving
# one working fallback behind two dead ids during an active flash-latest 503
# storm. Restored the policy chain; gemini-3.1-flash-lite sits first because it
# probed 200 in 0.5s while gemini-3-flash-preview probed 200 in 39s (degraded).
grep -v -E '^(AGENT_MODEL|AGENT_FALLBACK_MODELS)=' .env > .env.patched || true
{
  printf '%s\n' 'AGENT_MODEL=google-genai:gemini-3.1-flash-lite'
  printf '%s\n' 'AGENT_FALLBACK_MODELS=google-genai:gemini-3-flash-preview,openrouter:meta-llama/llama-3.3-70b-instruct:free,openrouter:qwen/qwen3-next-80b-a3b-instruct:free'
} >> .env.patched
mv .env.patched .env
chmod 600 .env
echo "==> Patched .env: AGENT_MODEL=google-genai:gemini-3.1-flash-lite"

# Pin the job-sweep spend controls. Both were unset in production until
# 2026-08-05, and both defaulted quietly rather than loudly:
#
#   APIFY_PLAN unset  → currentPlan() falls back to "free". Correct for this
#     account today, so the ledger happened to be right — but the moment the plan
#     changes, every cost this system reports is silently wrong, which is exactly
#     what the cost module was written to stop. Pinned so it is a stated fact.
#
#   JOBHUNT_MONTHLY_CAP_USD unset → the sweep had no ceiling it could refuse to
#     cross. Apify is on the FREE plan with a $5 hard platform cap SHARED with the
#     research actors; on 2026-08-06 a single sweep spent $0.997 and produced
#     nothing, taking the cycle to $4.28 of $5. $2 leaves the research tools their
#     share. Raise it here, not on the box — a hand-edited .env is wiped by the
#     next PROD_DOTENV render.
grep -v -E '^(APIFY_PLAN|JOBHUNT_MONTHLY_CAP_USD)=' .env > .env.patched || true
{
  printf '%s\n' 'APIFY_PLAN=free'
  printf '%s\n' 'JOBHUNT_MONTHLY_CAP_USD=2.00'
} >> .env.patched
mv .env.patched .env
chmod 600 .env
echo "==> Patched .env: APIFY_PLAN=free, JOBHUNT_MONTHLY_CAP_USD=2.00"
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

# LangSmith tracing — forwarded from a GitHub secret so it never depends on an
# on-box value existing first (unlike PRESERVE_IF_MISSING keys). Boot report
# (src/infra/boot-report.ts) flags this MISSING until both vars are set.
if [ -n "${LANGCHAIN_API_KEY:-}" ]; then
  grep -v -E '^(LANGCHAIN_API_KEY|LANGCHAIN_TRACING_V2)=' .env > .env.patched || true
  {
    printf 'LANGCHAIN_API_KEY=%s\n' "$LANGCHAIN_API_KEY"
    printf 'LANGCHAIN_TRACING_V2=true\n'
  } >> .env.patched
  mv .env.patched .env
  chmod 600 .env
  echo "==> Patched .env: LANGCHAIN_API_KEY + LANGCHAIN_TRACING_V2=true set (LangSmith tracing)"
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
