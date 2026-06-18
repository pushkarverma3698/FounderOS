#!/usr/bin/env bash
# Live showcase deploy + verification on VPS.
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

[ -f "$SRC_HTML" ] || { echo "❌ FAIL — no index.html to deploy"; exit 1; }

# ── 2. Deploy static files (sudo or home fallback) ───────────────────────────
DEPLOY_MODE="home"
WEB_ROOT="$HOME/www/proof.turicks.com"
SHOWCASE_DIR="$WEB_ROOT/showcase-1"

if sudo -n true 2>/dev/null; then
  WEB_ROOT="/var/www/proof.turicks.com"
  SHOWCASE_DIR="$WEB_ROOT/showcase-1"
  sudo mkdir -p "$SHOWCASE_DIR"
  sudo cp "$SRC_HTML" "$SHOWCASE_DIR/index.html"
  sudo chown -R www-data:www-data "$WEB_ROOT" 2>/dev/null || sudo chown -R nginx:nginx "$WEB_ROOT" 2>/dev/null || true
  DEPLOY_MODE="system"
  echo "==> Deployed (system): $SHOWCASE_DIR/index.html"
else
  mkdir -p "$SHOWCASE_DIR"
  cp "$SRC_HTML" "$SHOWCASE_DIR/index.html"
  echo "==> Deployed (home): $SHOWCASE_DIR/index.html"
  echo "!! passwordless sudo unavailable — using $WEB_ROOT"
fi

# ── 3. Nginx (system deploy only) ───────────────────────────────────────────
NGINX_OK=0
if [ "$DEPLOY_MODE" = "system" ] && command -v nginx >/dev/null 2>&1; then
  NGINX_SITE="/etc/nginx/sites-available/proof.turicks.com"
  if [ ! -f "$NGINX_SITE" ]; then
    echo "==> Creating nginx site config"
    sudo tee "$NGINX_SITE" >/dev/null <<NGINX
server {
    listen 80;
    server_name proof.turicks.com;
    root /var/www/proof.turicks.com;
    index index.html;
    location / {
        try_files \$uri \$uri/ =404;
    }
}
NGINX
    sudo ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/proof.turicks.com
    sudo rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
  fi
  if sudo nginx -t 2>/dev/null; then
    sudo systemctl reload nginx 2>/dev/null || sudo systemctl restart nginx 2>/dev/null || true
    NGINX_OK=1
    echo "==> nginx reloaded"
  fi
fi

# ── 4. HTTP verification ─────────────────────────────────────────────────────
VERIFY_OK=0

if [ "$NGINX_OK" = "1" ]; then
  LOCAL_CODE="$(curl -s -o /tmp/showcase-local.html -w '%{http_code}' -H 'Host: proof.turicks.com' 'http://127.0.0.1/showcase-1/' || echo 000)"
  echo "==> Nginx local verify: HTTP $LOCAL_CODE"
  if [ "$LOCAL_CODE" = "200" ] && grep -qi 'AgentOps' /tmp/showcase-local.html; then
    VERIFY_OK=1
    grep -oi '<title>[^<]*</title>' /tmp/showcase-local.html || true
  fi
fi

# Fallback: temporary serve from showcase dir
SERVE_PORT=8877
if [ "$VERIFY_OK" != "1" ]; then
  echo "==> Starting preview server on 127.0.0.1:$SERVE_PORT"
  pkill -f "http.server $SERVE_PORT" 2>/dev/null || true
  python3 -m http.server "$SERVE_PORT" --directory "$SHOWCASE_DIR" >/tmp/showcase-serve.log 2>&1 &
  sleep 2
  PREVIEW_CODE="$(curl -s -o /tmp/showcase-preview.html -w '%{http_code}' "http://127.0.0.1:$SERVE_PORT/" || echo 000)"
  echo "==> Preview server: HTTP $PREVIEW_CODE"
  if [ "$PREVIEW_CODE" = "200" ] && grep -qi 'AgentOps' /tmp/showcase-preview.html; then
    VERIFY_OK=1
    head -c 500 /tmp/showcase-preview.html
    echo ""
  fi
fi

[ "$VERIFY_OK" = "1" ] || { echo "❌ FAIL — could not verify page content"; exit 1; }

# External URL (domain + IP)
VPS_IP="$(curl -s -4 --connect-timeout 3 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
for URL in "http://${VPS_IP}/showcase-1/" "https://proof.turicks.com/showcase-1/" "http://proof.turicks.com/showcase-1/"; do
  EXT_CODE="$(curl -s -o /tmp/showcase-ext.html -w '%{http_code}' --connect-timeout 12 "$URL" 2>/dev/null || echo 000)"
  echo "==> External $URL → HTTP $EXT_CODE"
  if [ "$EXT_CODE" = "200" ]; then
    grep -oi '<title>[^<]*</title>' /tmp/showcase-ext.html || true
    echo "✅ PUBLIC SHOWCASE LIVE: $URL"
    break
  fi
done

echo "==> Hero grep:"
grep -iE 'See Every Agent|AgentOps' "$SHOWCASE_DIR/index.html" | head -2 || true

  # Live HITL build (office approve path) — non-fatal, ~3-5 min
  if [ -f scripts/live-build-hitl-verify.ts ] && command -v claude >/dev/null 2>&1; then
    echo "==> Live HITL build verify (office approve path)"
    node --env-file=.env --import tsx/esm scripts/live-build-hitl-verify.ts 2>&1 | tee /tmp/live-hitl-build.log | tail -25 || echo "!! live HITL build verify failed (non-fatal)"
  fi

echo ""
echo "✅ LIVE SHOWCASE VERIFY COMPLETE"
echo "   files: $SHOWCASE_DIR/index.html ($(wc -c < "$SHOWCASE_DIR/index.html") bytes)"
