#!/usr/bin/env bash
# Apply production .env on VPS from GitHub Actions secrets.
# Called by deploy / stabilize / launch-gate workflows before running deploy scripts.
#
# THE SINGLE SOURCE OF TRUTH for production .env patching (2026-07-04 consolidation).
# Previously deploy.yml ALSO carried its own inline copy of this render+patch logic,
# and since this script ran AFTER that inline copy (as the last step before
# deploy.sh), it silently re-rendered from PROD_DOTENV and re-applied an OLDER,
# simpler model patch — wiping the hybrid-model split and CREATIVE_SUBGRAPH /
# ENGINEERING_SUBGRAPH / MCP_BRIDGE_ENABLED flags that deploy.yml's copy had just
# set, every single deploy. Confirmed live on the box: the flags never actually
# reached the running process despite deploy logs claiming success. Fix: this is
# now the ONLY writer of .env; deploy.yml just calls it.
#
# Inputs (env vars forwarded by appleboy/ssh-action):
#   PROD_DOTENV           — base64-encoded full .env (required for DATABASE_URL)
#   OPENROUTER_API_KEY    — optional override (pins AGENT_MODEL + hybrid split)
#   LINKEDIN_ACCESS_TOKEN — optional override
#   LINKEDIN_AUTHOR_URN   — optional override
#   SLACK_BOT_TOKEN       — optional (MCP bridge Slack connector, ADR-041)
#   SLACK_TEAM_ID         — optional (MCP bridge Slack connector, ADR-041)
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

# Pin the production model — LOCKED RELIABILITY POSTURE (2026-07-07, CLAUDE.md).
# Pro on BOTH tiers (WORKER_AGENT_MODEL intentionally omitted — getWorkerModel
# falls back to AGENT_MODEL when unset).
# FORCE_TOOL_CHOICE stays OFF (unset) — the 2026-07-07 routing-determinism plan
# scoped this back out: it caused the #278 meltdown and is unverified against
# the live provider. Routing determinism for high-value writes (e.g. GitHub
# issue/PR creation) now comes from deterministic HITL fast-paths instead
# (see src/gateway/*-fast-path.ts), not from forcing tool_choice on the model.
# CREATIVE_SUBGRAPH / ENGINEERING_SUBGRAPH are also deliberately NOT re-pinned
# here anymore (2026-07-07): the founder's daily-driver+revenue scope is the
# flat 8-department topology (research/comms/admin/personal/jobhunt/
# engineering/marketing/sales). Nested sub-supervisors were prod-only bug
# surface never covered by the eval harness — leaving these unset lets the
# code default (false) apply, matching what's actually tested.
#   MCP_BRIDGE_ENABLED  → external MCP tools (browser-use, blender, slack; per-server
#                         try/catch means a dead server contributes zero tools, no crash)
# This is now the ONLY place these pins are written — this script is the last
# writer of .env, so whatever it sets here is what the bot actually boots with.
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  # Also drop any stale LINKEDIN_API_VERSION — a leftover malformed value
  # (20240501) 426'd every post on 2026-07-04. Unset lets the code default
  # (a current YYYYMM) apply; the code now ignores malformed values anyway.
  grep -v -E '^(AGENT_MODEL|WORKER_AGENT_MODEL|OPENROUTER_API_KEY|AGENT_FALLBACK_MODELS|CREATIVE_SUBGRAPH|ENGINEERING_SUBGRAPH|MCP_BRIDGE_ENABLED|LINKEDIN_API_VERSION|FORCE_TOOL_CHOICE)=' .env > .env.patched || true
  {
    printf '%s\n' 'AGENT_MODEL=openrouter:google/gemini-2.5-pro'
    printf '%s\n' 'AGENT_FALLBACK_MODELS=openrouter:google/gemini-2.5-flash,anthropic:claude-haiku-4-5'
    printf '%s\n' 'MCP_BRIDGE_ENABLED=true'
    printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY"
  } >> .env.patched
  mv .env.patched .env
  chmod 600 .env
  echo "==> Patched .env: Pro on BOTH tiers (locked reliability posture), FORCE_TOOL_CHOICE + creative/engineering subgraphs OFF (flat topology), MCP bridge ON"
fi

# MCP bridge Slack secrets — append only when the secret is set.
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
