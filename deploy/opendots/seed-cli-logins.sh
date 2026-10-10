#!/usr/bin/env bash
# Log one Dot's computer into agy and claude. The computer must be running. On the laptop run
# `claude setup-token` and copy the token, then:
#   ssh -t founderos-vps 'bash /opt/opendots/deploy/seed-cli-logins.sh <computer-container-name>'
# and paste the token at the prompt (Enter alone skips claude). agy reuses the VPS's antigravity login.
# With no argument it lists the running computers.
set -euo pipefail
c=${1:-}
if [[ -z $c ]]; then
  docker ps --filter "ancestor=opendots-computer-turicks:1" --format '{{.Names}}  {{.Status}}'
  exit 2
fi
docker exec "$c" mkdir -p /workspace/tmp

# The computer's root has no CAP_DAC_OVERRIDE, so every copied file must be owned by uid 0.
sudo -n tar -C /home/antigravity --owner=0 --group=0 --numeric-owner -cf - .gemini | docker cp - "$c:/workspace/"
echo "agy:    $(docker exec "$c" sh -c 'cd /workspace/tmp && timeout 150 agy --new-project --print "reply with the single word ok" --print-timeout 120s --output-format text </dev/null 2>/dev/null' | tail -1)"

read -rsp "claude setup-token token (input hidden, Enter to skip): " token; echo
[[ -z $token ]] && exit 0
[[ $token == sk-ant-* ]] || { echo "that does not look like a setup-token (sk-ant-...)" >&2; exit 1; }
printf '%s\n%s\n' "$token" "$(date +%F)" | docker exec -i "$c" sh -c 'umask 077; cat > /workspace/.claude-token'
echo "claude: $(docker exec "$c" sh -c 'cd /workspace/tmp && timeout 120 claude -p "reply with the single word ready" --max-turns 1' 2>&1 | tail -1)"
