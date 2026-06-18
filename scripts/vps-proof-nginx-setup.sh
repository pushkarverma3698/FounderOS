#!/usr/bin/env bash
# One-time VPS setup: nginx static host for proof.turicks.com AND IP-based previews.
# Run as founderos on VPS: bash scripts/vps-proof-nginx-setup.sh [path-to-index.html]
#
# Serves:
#   http://<VPS-IP>/showcase-1/          — legacy showcase
#   http://<VPS-IP>/clients/{slug}/      — per-client Proof Drops
#   http://proof.turicks.com/...         — when DNS points at the VPS
set -euo pipefail

WEB_ROOT="/var/www"
SHOWCASE_SRC="${1:-$HOME/www/proof.turicks.com/showcase-1/index.html}"
SHOWCASE_DIR="$WEB_ROOT/proof.turicks.com/showcase-1"
CLIENTS_DIR="$WEB_ROOT/clients"

echo "==> Static site nginx setup (IP + domain)"
echo "    web root: $WEB_ROOT"

if ! command -v nginx >/dev/null 2>&1; then
  echo "!! nginx not installed — install first (founder, one-time):"
  echo "   sudo apt update && sudo apt install -y nginx"
  echo "   Then re-run this script."
  exit 1
fi

sudo mkdir -p "$SHOWCASE_DIR" "$CLIENTS_DIR"
if [ -f "$SHOWCASE_SRC" ]; then
  sudo cp "$SHOWCASE_SRC" "$SHOWCASE_DIR/index.html"
  echo "    copied showcase: $SHOWCASE_SRC → $SHOWCASE_DIR/index.html"
fi

# Copy home-deployed clients if present
if [ -d "$HOME/www/clients" ]; then
  sudo cp -r "$HOME/www/clients/." "$CLIENTS_DIR/" 2>/dev/null || true
  echo "    synced ~/www/clients → $CLIENTS_DIR"
fi

sudo tee /etc/nginx/sites-available/founderos-static >/dev/null <<'NGINX'
# FounderOS static Proof Drop / showcase hosting (IP + domain)
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _ proof.turicks.com;

    # Legacy showcase path
    location /showcase-1/ {
        alias /var/www/proof.turicks.com/showcase-1/;
        index index.html;
        try_files $uri $uri/ /showcase-1/index.html;
    }

    # Per-client Proof Drops: /clients/{slug}/index.html
    location /clients/ {
        alias /var/www/clients/;
        index index.html;
        try_files $uri $uri/ =404;
    }

    # Health hint for operators (does not proxy to FounderOS — use :3001 for /health)
    location = / {
        default_type text/plain;
        return 200 "FounderOS static host — try /showcase-1/ or /clients/{slug}/\n";
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/founderos-static /etc/nginx/sites-enabled/founderos-static
sudo rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
sudo nginx -t
sudo systemctl enable nginx 2>/dev/null || true
sudo systemctl reload nginx

VPS_IP="$(curl -s -4 --connect-timeout 3 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
echo ""
echo "==> Local tests"
curl -s -o /dev/null -w "  /showcase-1/ → HTTP %{http_code}\n" "http://127.0.0.1/showcase-1/" || true
echo ""
echo "==> Done"
echo "   Showcase:  http://${VPS_IP}/showcase-1/"
echo "   Clients:   http://${VPS_IP}/clients/{slug}/"
echo "   Domain:    http://proof.turicks.com/showcase-1/ (when DNS → VPS)"
echo ""
echo "Optional — passwordless sudo for CI deploys (founder, one-time):"
echo "  sudo visudo -f /etc/sudoers.d/founderos-nginx"
echo "  founderos ALL=(ALL) NOPASSWD: /usr/sbin/nginx, /bin/systemctl reload nginx, /bin/systemctl restart nginx, /bin/mkdir, /bin/cp, /bin/chown, /usr/bin/tee, /usr/bin/true"
