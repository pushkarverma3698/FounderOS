#!/usr/bin/env bash
# Live showcase deploy + verification on VPS.
# - Deploys AgentOps build to proof.turicks.com/showcase-1
# - Configures nginx static hosting if missing
# - Verifies HTTP 200 + content keywords
# - Optional: Telegram MTProto smoke if TELEGRAM_TESTER_SESSION is set
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/founderos}"
cd "$APP_DIR"

echo "==> Live showcase deploy + verify"
echo "    host: $(hostname)"
echo "    date: $(date -Is)"

# ── 1. Find or build AgentOps artifact ───────────────────────────────────────
PROBE_GLOB="$HOME/Projects/agent-workspace-probe-*"
LATEST_PROBE="$(ls -dt $PROBE_GLOB 2>/dev/null | head -1 || true)"
SRC_HTML=""

if [ -n "$LATEST_PROBE" ] && [ -f "$LATEST_PROBE/index.html" ]; then
  SRC_HTML="$LATEST_PROBE/index.html"
  echo "==> Using existing build: $SRC_HTML ($(wc -c < "$SRC_HTML") bytes)"
else
  echo "==> No probe artifact — running cinematic build probe..."
  node --env-file=.env --import tsx/esm scripts/probe-cinematic-build.ts
  LATEST_PROBE="$(ls -dt $PROBE_GLOB 2>/dev/null | head -1)"
  SRC_HTML="$LATEST_PROBE/index.html"
fi

if [ ! -f "$SRC_HTML" ]; then
  echo "❌ FAIL — no index.html to deploy"
  exit 1
fi

# ── 2. Deploy static files ───────────────────────────────────────────────────
WEB_ROOT="/var/www/proof.turicks.com"
SHOWCASE_DIR="$WEB_ROOT/showcase-1"
sudo mkdir -p "$SHOWCASE_DIR"
sudo cp "$SRC_HTML" "$SHOWCASE_DIR/index.html"
sudo chown -R www-data:www-data "$WEB_ROOT" 2>/dev/null || sudo chown -R nginx:nginx "$WEB_ROOT" 2>/dev/null || true
echo "==> Deployed to $SHOWCASE_DIR/index.html"

# ── 3. Nginx config for proof.turicks.com ────────────────────────────────────
NGINX_SITE="/etc/nginx/sites-available/proof.turicks.com"
if ! command -v nginx >/dev/null 2>&1; then
  echo "==> Installing nginx"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nginx
fi

if [ ! -f "$NGINX_SITE" ]; then
  echo "==> Creating nginx site config"
  sudo tee "$NGINX_SITE" >/dev/null <<'NGINX'
server {
    listen 80;
    server_name proof.turicks.com;

    root /var/www/proof.turicks.com;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
NGINX
  sudo ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/proof.turicks.com
  # Drop default site if it conflicts on :80 for this host
  sudo rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
fi

sudo nginx -t
sudo systemctl enable nginx 2>/dev/null || true
sudo systemctl reload nginx 2>/dev/null || sudo systemctl restart nginx
echo "==> nginx active: $(systemctl is-active nginx 2>/dev/null || echo unknown)"

# ── 4. HTTP verification ─────────────────────────────────────────────────────
sleep 1
LOCAL_URL="http://127.0.0.1/showcase-1/"
LOCAL_CODE="$(curl -s -o /tmp/showcase-local.html -w '%{http_code}' -H 'Host: proof.turicks.com' "$LOCAL_URL" || echo 000)"
LOCAL_BODY="$(head -c 600 /tmp/showcase-local.html 2>/dev/null || true)"
echo "==> Local verify (nginx + Host header): HTTP $LOCAL_CODE"
echo "$LOCAL_BODY" | head -5

if [ "$LOCAL_CODE" != "200" ]; then
  echo "❌ FAIL — local nginx did not return 200"
  exit 1
fi

if ! grep -qi 'AgentOps\|observability\|neon' /tmp/showcase-local.html; then
  echo "❌ FAIL — page missing expected AgentOps content"
  exit 1
fi
echo "✅ Local content check passed"

# External (may fail if DNS not pointed — report honestly)
EXT_CODE="$(curl -s -o /tmp/showcase-ext.html -w '%{http_code}' --connect-timeout 12 \
  https://proof.turicks.com/showcase-1/ 2>/dev/null || \
  curl -s -o /tmp/showcase-ext.html -w '%{http_code}' --connect-timeout 12 \
  http://proof.turicks.com/showcase-1/ 2>/dev/null || echo 000)"
echo "==> External verify: HTTP $EXT_CODE"
if [ "$EXT_CODE" = "200" ]; then
  grep -oi '<title>[^<]*</title>' /tmp/showcase-ext.html || true
  echo "✅ proof.turicks.com/showcase-1 is LIVE"
else
  echo "⚠️  External URL not 200 (DNS/TLS/Cloudflare?) — local deploy OK; check DNS A record → $(curl -s ifconfig.me 2>/dev/null || echo VPS_IP)"
fi

# ── 5. Preview snippet for evidence ──────────────────────────────────────────
echo "==> Hero grep from deployed file:"
grep -iE 'See Every Agent|AgentOps|hero' "$SHOWCASE_DIR/index.html" | head -3 || true

# ── 6. Telegram live path (optional) ─────────────────────────────────────────
if grep -q '^TELEGRAM_TESTER_SESSION=' .env 2>/dev/null; then
  echo "==> Telegram MTProto live verify (web design build routing)"
  PROMPT="Build a cinematic landing page for AgentOps using the neon preset — quick test only, do not deploy."
  node --env-file=.env --import tsx/esm scripts/telegram-tester.ts send "$PROMPT" --wait 120 2>&1 | tee /tmp/tg-live-verify.log | tail -40
  if grep -qi 'claude_code\|Claude Code\|approval\|Approve' /tmp/tg-live-verify.log; then
    echo "✅ Telegram path surfaced engineering HITL"
  else
    echo "⚠️  Telegram reply did not clearly show claude_code HITL — inspect log"
  fi
else
  echo "⚠️  TELEGRAM_TESTER_SESSION not in .env — skip Telegram live path"
  echo "    (founder: run scripts/telegram-tester.ts login on VPS)"
fi

echo ""
echo "✅ LIVE SHOWCASE DEPLOY COMPLETE"
echo "   Local:  curl -H 'Host: proof.turicks.com' http://127.0.0.1/showcase-1/"
echo "   Public: https://proof.turicks.com/showcase-1/"
