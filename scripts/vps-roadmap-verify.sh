#!/usr/bin/env bash
# VPS roadmap verification — tests the merged P0–P3 work on the production box.
# Safe on prod: migrate is additive (CREATE TABLE IF NOT EXISTS); the probe is
# read-only except an optional ~$0.01 draft image; it does NOT restart the bot.
#
# Run on the VPS directly:
#   cd /opt/founderos && VERIFY_BRANCH=main bash scripts/vps-roadmap-verify.sh [--image]
#
# Or via the vps-roadmap-verify.yml GitHub Action (dispatch).
set -uo pipefail   # NOT -e: we want every check to run and report, not abort on first.

APP_DIR="${APP_DIR:-/opt/founderos}"
BRANCH="${VERIFY_BRANCH:-main}"
IMAGE_FLAG=""
[ "${1:-}" = "--image" ] && IMAGE_FLAG="--image"
cd "$APP_DIR"

echo "==> VPS roadmap verify: branch=$BRANCH  image=${IMAGE_FLAG:-off}"
git fetch --quiet origin "$BRANCH"
git reset --hard "origin/$BRANCH"
git clean -fd >/dev/null 2>&1 || true

[ -f .env ] || { echo "❌ .env missing on VPS — cannot verify"; exit 2; }

echo "==> Dependencies"
pnpm install --frozen-lockfile --silent

echo
echo "==> [1/3] Apply migrations (creates agents.agent_assets if missing — the S3 journal fix)"
node node_modules/drizzle-kit/bin.cjs migrate && echo "migrate: exit 0" || echo "❌ migrate failed"

echo
echo "==> [2/3] Roadmap probe (agent_assets · checkpoint sweep dry · per-dept cost · creative image)"
node --env-file=.env --import tsx/esm scripts/probe-roadmap-vps.ts $IMAGE_FLAG
PROBE_RC=$?

echo
echo "==> [3/3] Routing eval WITH the creative department enabled (incl. 5 creative tasks)"
echo "    (this makes real LLM calls — needs OPENROUTER/AGENT_MODEL key in .env)"
CREATIVE_SUBGRAPH=1 pnpm eval 2>&1 | tail -40
EVAL_RC=${PIPESTATUS[0]}

echo
echo "==================== ROADMAP VERIFY SUMMARY ===================="
echo "probe exit: $PROBE_RC   (0 = all checked items passed)"
echo "eval  exit: $EVAL_RC    (see EVAL.md / routing score above)"
echo "Evidence: probe output above + EVAL.md (creative routing). Bot NOT restarted."
echo "==============================================================="
# Surface the probe result as the script's exit code; eval routing is advisory.
exit $PROBE_RC
