#!/usr/bin/env bash
# Set GitHub Actions secrets for LinkedIn direct API on production.
# Run locally after LinkedIn Developer OAuth (ADR-029).
#
# Usage:
#   LINKEDIN_ACCESS_TOKEN='AQV...' LINKEDIN_AUTHOR_URN='urn:li:person:...' \
#     ./scripts/setup-prod-linkedin-secrets.sh
#
# Or interactively:
#   ./scripts/setup-prod-linkedin-secrets.sh
#
# Then re-run the marketing launch gate:
#   gh workflow run vps-marketing-launch-gate.yml -f branch=main
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-pushkarverma3698/FounderOS}"

if [ -z "${LINKEDIN_ACCESS_TOKEN:-}" ]; then
  read -r -s -p "LinkedIn access token (OAuth): " LINKEDIN_ACCESS_TOKEN
  echo ""
fi
if [ -z "${LINKEDIN_ACCESS_TOKEN:-}" ]; then
  echo "❌ LINKEDIN_ACCESS_TOKEN required" >&2
  exit 1
fi

if [ -z "${LINKEDIN_AUTHOR_URN:-}" ]; then
  echo "Resolving author URN from token (LinkedIn /v2/userinfo)…"
  LINKEDIN_AUTHOR_URN="$(node --import tsx/esm scripts/resolve-linkedin-author-urn.ts "$LINKEDIN_ACCESS_TOKEN" 2>/dev/null || true)"
fi

if [ -z "${LINKEDIN_AUTHOR_URN:-}" ]; then
  echo "Could not auto-resolve URN. Enter manually (e.g. urn:li:person:d2Vl-gTmK-):"
  read -r LINKEDIN_AUTHOR_URN
fi

if [ -z "${LINKEDIN_AUTHOR_URN:-}" ]; then
  echo "❌ LINKEDIN_AUTHOR_URN required" >&2
  exit 1
fi

echo "Setting GitHub secrets on $REPO (values not printed)…"
printf '%s' "$LINKEDIN_ACCESS_TOKEN" | gh secret set LINKEDIN_ACCESS_TOKEN --repo "$REPO"
printf '%s' "$LINKEDIN_AUTHOR_URN" | gh secret set LINKEDIN_AUTHOR_URN --repo "$REPO"

echo "✅ Secrets set: LINKEDIN_ACCESS_TOKEN, LINKEDIN_AUTHOR_URN"
echo ""
echo "Next: trigger prod verification"
echo "  gh workflow run vps-marketing-launch-gate.yml -f branch=main"
echo ""
echo "Or patch local .env for testing:"
echo "  LINKEDIN_ACCESS_TOKEN=... LINKEDIN_AUTHOR_URN=$LINKEDIN_AUTHOR_URN LINKEDIN_BACKEND=direct"
