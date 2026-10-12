#!/usr/bin/env bash
# add-dot.sh: Add a new autonomous employee to the founder's AI agency in OpenDots.
# Usage:
#   bash add-dot.sh "<Name>" "<Instructions>" [SpaceName]
# Example:
#   bash add-dot.sh "DevOps" "You are the DevOps Engineer on the team..." Everyday
set -euo pipefail

usage() {
  cat <<'EOF' >&2
Usage:
  add-dot.sh "<Name>" "<Instructions>" [SpaceName] [--fresh-login]

Arguments:
  Name          Name of the employee (e.g. DevOps, Growth, QA, Analyst)
  Instructions  Role instructions/system prompt (max 2000 characters)
  SpaceName     OpenDots Space (default: Everyday)
  --fresh-login Leave subscriptions uncopied so employee uses its own dedicated login via dot-login
EOF
  exit 2
}

FRESH_LOGIN=0
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--fresh-login" ]]; then
    FRESH_LOGIN=1
  else
    ARGS+=("$arg")
  fi
done

NAME="${ARGS[0]:-}"
INSTRUCTIONS="${ARGS[1]:-}"
SPACE_NAME="${ARGS[2]:-Everyday}"

[[ -n "$NAME" && -n "$INSTRUCTIONS" ]] || usage

n=$(printf %s "$INSTRUCTIONS" | wc -m)
if (( n > 2000 )); then
  echo "Error: instructions are $n characters (max 2000)" >&2
  exit 1
fi

APP="${OPENDOTS_APP:-/opt/opendots/app}"
HERE="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$APP/.env" ]] || { echo "Error: $APP/.env not found" >&2; exit 1; }

T=$(grep '^OWNER_TOKEN=' "$APP/.env" | cut -d= -f2- | tr -d '[:space:]')
api() {
  curl -fsS -X "$1" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
    "http://127.0.0.1:4310/api$2" ${3:+--data "$3"}
}

ws=$(api GET /workspace)
space=$(jq -r --arg s "$SPACE_NAME" '.spaces[] | select(.name==$s) | .id' <<<"$ws" | head -1)
if [[ -z "$space" ]]; then
  space=$(jq -r '.spaces[0].id' <<<"$ws")
  echo "Notice: Space '$SPACE_NAME' not found, defaulting to first space ($space)"
fi

dot_id=$(jq -r --arg n "$NAME" '.dots[] | select(.name==$n) | .id' <<<"$ws" | head -1)
slug() { echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//'; }
body() { local s; s=$(slug "$NAME"); jq -nc --arg n "$NAME" --arg i "$INSTRUCTIONS" --arg l "$s" '{name:$n, instructions:$i, researchAllowed:true, memoryAllowed:true, learningContainerId:$l, skillDeliveryEnabled:true}'; }
SHELL_PERMS='{"enabled":true,"browser":true,"files":true,"shell":true}'

if [[ -z "$dot_id" ]]; then
  echo "Creating new Dot: $NAME..."
  dot_id=$(api POST /dots "$(body | jq -c --arg s "$space" '. + {spaceId:$s}')" | jq -r .id)
else
  echo "Updating existing Dot: $NAME ($dot_id)..."
  api PUT "/dots/$dot_id" "$(body)" >/dev/null
fi

api PATCH "/dots/$dot_id/computer/permissions" "$SHELL_PERMS" >/dev/null

box="opendots-computer-$dot_id"
up() { [[ $(docker inspect -f '{{.State.Running}}' "$box" 2>/dev/null) == true ]]; }

if ! up; then
  echo "Starting computer for $NAME ($box)..."
  api POST "/dots/$dot_id/computer/start" '{}' >/dev/null
fi

for _ in $(seq 60); do
  up && break
  sleep 2
done
up || { echo "Error: computer $box did not start in 60s" >&2; exit 1; }

# Find donor container with valid credentials
donor=$(docker ps --format '{{.Names}}' | grep '^opendots-computer-' | grep -v "$dot_id" | head -1 || true)
if [[ -n "$donor" ]]; then
  if (( FRESH_LOGIN == 0 )); then
    echo "Copying credentials from donor container: $donor..."
    LOGINS=(.claude-token .claude.json .config/gh/hosts.yml .config/gh/config.yml .gitconfig)
    AGY=(.gemini/antigravity-cli/antigravity-oauth-token .gemini/config/config.json)
    docker exec -w /workspace "$donor" tar -cf - "${LOGINS[@]}" "${AGY[@]}" 2>/dev/null | \
      docker exec -i -w /workspace "$box" tar -xf - --no-same-owner --skip-old-files 2>/dev/null || true
  else
    echo "Fresh login requested: copying only git config, leaving subscriptions isolated..."
    LOGINS=(.config/gh/hosts.yml .config/gh/config.yml .gitconfig)
    docker exec -w /workspace "$donor" tar -cf - "${LOGINS[@]}" 2>/dev/null | \
      docker exec -i -w /workspace "$box" tar -xf - --no-same-owner --skip-old-files 2>/dev/null || true
  fi
fi

# Configure Git & directories
docker exec -e HOME=/workspace "$box" sh -c '
  login=$(gh api user -q .login 2>/dev/null || echo "")
  if [ -n "$login" ]; then
    git config --global user.name "$login"
    git config --global user.email "$(gh api user -q "\"\(.id)+\(.login)@users.noreply.github.com\"" 2>/dev/null || echo "$login@users.noreply.github.com")"
  fi
  mkdir -p /workspace/repos /workspace/tmp /workspace/runs
' >/dev/null 2>&1 || true

# Install Owner Token for autonomous dot-task management
printf '%s\n' "$T" | docker exec -i "$box" sh -c 'cat > /workspace/.opendots-token && chmod 600 /workspace/.opendots-token'

# Install Agency rules & skills
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/.claude" "$stage/.gemini/config"
cp "$HERE/home/CLAUDE.md" "$stage/.claude/CLAUDE.md"
cp "$HERE/home/CLAUDE.md" "$stage/.gemini/GEMINI.md"
cp -R "$HERE/home/skills" "$stage/.claude/skills"
cp -R "$HERE/home/skills" "$stage/.gemini/config/skills"
tar -C "$stage" -cf - .claude .gemini | docker exec -i -w /workspace "$box" tar -xf - --no-same-owner --no-overwrite-dir

# Copy team repos & local rules if available
if [[ -n "$donor" ]]; then
  docker exec "$donor" sh -c 'test -f /workspace/team-repos && cat /workspace/team-repos' 2>/dev/null | \
    docker exec -i "$box" sh -c 'cat > /workspace/team-repos' || true
  docker exec "$donor" sh -c 'test -d /workspace/local-rules && tar -C /workspace -cf - local-rules' 2>/dev/null | \
    docker exec -i -w /workspace "$box" tar -xf - --no-same-owner 2>/dev/null || true
fi

# Install dot-task CLI inside container
if [[ -f "$HERE/dot-task" ]]; then
  docker exec -i "$box" sh -c 'cat > /usr/local/bin/dot-task && chmod 755 /usr/local/bin/dot-task' < "$HERE/dot-task"
fi

# Install auto-approving permission wrappers for claude and agy in sandbox
docker exec -i "$box" sh -c '
  if [ -f /usr/local/bin/claude-bin ]; then
    cat << "EOF" > /usr/local/bin/claude
#!/bin/sh
t=${HOME:-/workspace}/.claude-token
[ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -s "$t" ] && CLAUDE_CODE_OAUTH_TOKEN=$(head -n1 "$t") && export CLAUDE_CODE_OAUTH_TOKEN
export IS_SANDBOX=1
case "$*" in
  *--dangerously-skip-permissions*) exec /usr/local/bin/claude-bin "$@" ;;
  *) exec /usr/local/bin/claude-bin --dangerously-skip-permissions "$@" ;;
esac
EOF
    chmod 755 /usr/local/bin/claude
  fi
  if [ -f /usr/local/bin/agy ] && [ ! -f /usr/local/bin/agy-bin ]; then
    mv /usr/local/bin/agy /usr/local/bin/agy-bin
    cat << "EOF" > /usr/local/bin/agy
#!/bin/sh
case "$*" in
  *--dangerously-skip-permissions*) exec /usr/local/bin/agy-bin "$@" ;;
  *) exec /usr/local/bin/agy-bin --dangerously-skip-permissions "$@" ;;
esac
EOF
    chmod 755 /usr/local/bin/agy
  fi
'

# Connect shared brain MCP if hub-http is active
HUB_ENV=/etc/founderos/hub-http.env
if [[ -r "$HUB_ENV" ]]; then
  hub_var() { grep "^$1=" "$HUB_ENV" | cut -d= -f2- || true; }
  port=$(hub_var HUB_HTTP_PORT)
  HUB_URL="http://$(hub_var HUB_HTTP_HOST):${port:-3100}/mcp"
  hub_var HUB_HTTP_BRAIN_TOKEN | docker exec -i -e HOME=/workspace -e HUB_URL="$HUB_URL" "$box" sh -c '
    t=$(cat); claude mcp remove -s user turicks-brain >/dev/null 2>&1 || true
    claude mcp add-json -s user turicks-brain \
      "{\"type\":\"http\",\"url\":\"$HUB_URL\",\"headers\":{\"Authorization\":\"Bearer $t\"}}" >/dev/null 2>&1' || true
fi

# Ensure default Chat conversation exists
conv=$(api GET /workspace | jq -r --arg d "$dot_id" '.conversations[] | select(.dotId==$d and .title=="Chat") | .id' | head -1)
if [[ -z "$conv" ]]; then
  conv=$(api POST /conversations "$(jq -nc --arg d "$dot_id" '{dotId:$d, title:"Chat"}')" | jq -r .id)
fi

echo "=================================================="
echo "Successfully onboarded agency Dot: $NAME"
echo "  Dot ID:       $dot_id"
echo "  Container:    $box"
echo "  Space:        $SPACE_NAME ($space)"
echo "  Conversation: $conv"
echo "  Superpowers:  claude, agy, gh, dot-task, turicks-brain"
echo "=================================================="
