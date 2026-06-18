#!/usr/bin/env bash
# One-time VPS fix: nginx static host for proof.turicks.com (requires sudo password ONCE).
# Run as founderos on VPS: bash scripts/vps-proof-nginx-setup.sh
set -euo pipefail

WEB_ROOT="/var/www/proof.turicks.com"
SRC="${1:-$HOME/www/proof.turicks.com/showcase-1/index.html}"

echo "==> proof.turicks.com nginx setup"
sudo mkdir -p "$WEB_ROOT/showcase-1"
if [ -f "$SRC" ]; then
  sudo cp "$SRC" "$WEB_ROOT/showcase-1/index.html"
  echo "    copied $SRC"
fi

sudo tee /etc/nginx/sites-available/proof.turicks.com >/dev/null <<'NGINX'
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

sudo ln -sf /etc/nginx/sites-available/proof.turicks.com /etc/nginx/sites-enabled/proof.turicks.com
sudo nginx -t
sudo systemctl reload nginx
echo "==> Local test:"
curl -s -o /dev/null -w "HTTP %{http_code}\n" -H 'Host: proof.turicks.com' http://127.0.0.1/showcase-1/
echo "==> Done — verify: https://proof.turicks.com/showcase-1/"
echo ""
echo "If passwordless sudo is needed for CI deploys, add to sudoers (founder, one-time):"
echo "  sudo visudo -f /etc/sudoers.d/founderos-nginx"
echo "  founderos ALL=(ALL) NOPASSWD: /usr/sbin/nginx, /bin/systemctl reload nginx, /bin/systemctl restart nginx, /bin/mkdir, /bin/cp, /bin/chown, /usr/bin/tee"
