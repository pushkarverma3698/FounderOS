#!/usr/bin/env bash
# Log one Dot's computer into claude and agy. The computer must be running (start it from the Dot's
# Computer panel first). On the laptop run `claude setup-token` and copy the token, then:
#   ssh -t founderos-vps 'bash /opt/opendots/deploy/seed-cli-logins.sh <computer-container-name>'
# and paste the token at the prompt. agy reuses the VPS's existing antigravity login.
# With no argument it lists the running computers.
set -euo pipefail
c=${1:-}
if [[ -z $c ]]; then
  docker ps --filter "ancestor=opendots-computer-turicks:1" --format '{{.Names}}  {{.Status}}'
  exit 2
fi
read -rsp "claude setup-token token (input hidden): " token; echo
[[ $token == sk-ant-* ]] || { echo "that does not look like a setup-token (sk-ant-...)" >&2; exit 1; }
docker exec "$c" mkdir -p /workspace/home
printf '%s\n%s\n' "$token" "$(date +%F)" | docker exec -i "$c" sh -c 'umask 077; cat > /workspace/home/.claude-token'

tmp=$(mktemp -d); trap 'sudo -n rm -rf "$tmp"' EXIT
sudo -n cp -a /home/antigravity/.gemini "$tmp/.gemini" && sudo -n chown -R "$(id -u):$(id -g)" "$tmp/.gemini"
docker cp "$tmp/.gemini" "$c:/workspace/home/"

echo "claude: $(docker exec "$c" sh -c 'cd /workspace && claude -p "reply with the single word ready" --max-turns 1' 2>&1 | tail -1)"
echo "agy:    $(docker exec "$c" agy --version 2>&1 | tail -1)"
