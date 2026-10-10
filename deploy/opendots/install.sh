#!/usr/bin/env bash
# Install or update OpenDots on founderos-vps. Idempotent; run as founderos from a checkout of this repo:
#   bash deploy/opendots/install.sh
# Leaves the app on 127.0.0.1:4310. Phone access goes through Tailscale (README.md).
set -euo pipefail
OPENDOTS_REV=625452e
ROOT=/opt/opendots
APP=$ROOT/app
HERE=$(cd "$(dirname "$0")" && pwd)
AGY_SRC=${AGY_SRC:-/home/antigravity/.local/bin/agy}

[[ -d $APP/.git ]] || git clone -q https://github.com/CopilotKit/OpenDots.git "$APP"
git -C "$APP" fetch -q origin && git -C "$APP" checkout -q "$OPENDOTS_REV"

if [[ ! -f $APP/.env ]]; then
  cp "$APP/.env.example" "$APP/.env"
  r() { openssl rand -hex 24; }
  sed -i "s|^# OWNER_TOKEN=.*|OWNER_TOKEN=$(r)|; s|^BROWSER_SECRET=.*|BROWSER_SECRET=$(r)|; \
s|^COMPUTER_SUPERVISOR_TOKEN=.*|COMPUTER_SUPERVISOR_TOKEN=$(r)|; s|^COMPUTER_TOKEN=.*|COMPUTER_TOKEN=$(r)|" "$APP/.env"
  chmod 600 "$APP/.env"
fi
cp "$HERE/compose.turicks.yml" "$APP/compose.turicks.yml"

compose() {
  docker compose -f compose.yml -f compose.computers.yml -f compose.computers-app.yml -f compose.turicks.yml \
    --profile build-computers --profile browser "$@"
}
cd "$APP"
compose build computer-image computer-supervisor app browser

ctx=$(mktemp -d "$ROOT/computer-ctx.XXXXXX")
trap 'rm -rf "$ctx"' EXIT
sudo -n cp "$AGY_SRC" "$ctx/agy" && sudo -n chown "$(id -u):$(id -g)" "$ctx/agy"
cp "$HERE/run-bg" "$ctx/run-bg" && chmod +x "$ctx/agy" "$ctx/run-bg"
docker build -q -t opendots-computer-turicks:1 -f "$HERE/computer.Dockerfile" "$ctx"

compose up -d app browser computer-supervisor
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:4310/; then echo "opendots up on 127.0.0.1:4310"; exit 0; fi
  sleep 2
done
echo "opendots did not answer on 127.0.0.1:4310" >&2
compose logs --tail 40 app >&2
exit 1
