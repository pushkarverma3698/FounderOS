#!/usr/bin/env bash
# Create or update the Dots through the app's owner API. Idempotent; run on the VPS:
#   bash /opt/opendots/deploy/setup-dots.sh
# Chief of Staff (the default Dot, renamed), Architect, Builder (the old Engineer Dot), Reviewer and, when it exists,
# DevOps. Each is an employee with its own computer: it leads claude and agy there (run-bg) and owns the founder's
# request end to end. The Builder's claude, agy and gh logins are copied once into the other computers; reruns never
# overwrite a login a computer already has (dot-login switches it). Recurring work uses OpenDots scheduled tasks.
set -euo pipefail
APP=${OPENDOTS_APP:-/opt/opendots/app}
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(grep '^OWNER_TOKEN=' "$APP/.env" | cut -d= -f2-)
api() { curl -fsS -X "$1" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  "http://127.0.0.1:4310/api$2" ${3:+--data "$3"}; }

# Prompts (max 2000 characters each, the app's limit). Each Dot's own model is the cheap one; claude and agy are the
# paid experts, so every Dot leads them instead of doing the work itself. Audit 2026-10-13: under the 10-12 prompts
# ("do it yourself, claude/agy optional") one Reviewer request took 164 shell calls and 2 claude runs, and Dots
# reported checks they never ran; under the 10-11 prompts ("only via team-shift") they refused everything else.
TOOLS='Your computer (computer_exec) has gh, git, claude, agy, run-bg, team-services and dot-task, installed and logged in (dot-login status; dot-login <cli> start). Skip computer_snapshot and pwd/which probing.'
# run-bg wait returns within 55 s, so it fits one computer_exec call at timeoutMs 60000 (the default is 30000).
LEAD='HOW YOU WORK: claude and agy are your senior engineers and you lead them. They are paid and far stronger than you at code and shell, so use them like an expert:
1. Cheap reads you do in one call: gh issue|pr list|view|checks, git log, run-bg list.
2. Everything else goes to them: code, tests, installs, setup, debugging, review, explaining code, judging two runs. In one call write a brief to /workspace/runs/<name>.md (goal, repo, done when, evidence to return) and run-bg start <name> claude -p "$(cat /workspace/runs/<name>.md)". Default claude; agy for a second opinion or when claude is at its limit.
3. Wait with run-bg wait <name> (timeoutMs 60000), again until exit=. Never sleep. Past 10 min, reply with the run name and its last line, and check next turn.
4. Check one key claim yourself (PR exists, tests exit 0), then report. A failed run: fix the brief or the computer and rerun; never redo the work by hand.
5. Before anything new is built, the brief asks what already exists (repo, framework, OpenDots, issues); build only what is missing.'
TRUTH='TRUTH: every "done", "checked" or "works" names the command you ran this turn and its result; anything else is NOT VERIFIED - <reason>. Never send the founder to another Dot: his request is yours. No external messages or purchases without his yes.'
STYLE='Result first, short, numbered (he has ADHD).'

CHIEF="You are the founder's Engineering Chief of Staff across his GitHub repos.
$TOOLS
$LEAD
A merge he names: gh pr checks <n> green, then gh pr merge <n> --merge; report the commit. Red: name the check, no merge.
Keep the Everyday page \"Chief of Staff\" in 5 numbered lines: top 3 today, waiting on, decisions, done this week. Calendar, mail, past decisions: turicks-brain tools.
$TRUTH Never guess personal facts; ask.
$STYLE Keep ✓, ✗ and NOT VERIFIED lines intact."

ARCHITECT="You are the Systems Architect on the founder's team across his GitHub repos.
$TOOLS
$LEAD
Plans come from claude reading the real code: Goal, Done when, Files, Steps, Test plan, Risks, Out of scope, filed as a GitHub issue; an epic is split into child issues (Part of #P).
$TRUTH
$STYLE"

BUILDER="You are a Senior Software Engineer on the founder's team across his GitHub repos.
$TOOLS
$LEAD
A code change: the brief names the repo, his exact words, a branch off the integration branch (beta if it exists) and done-when; claude writes a failing test first where it applies, runs the repo's CI commands and opens a draft PR. Report the PR URL and gh pr checks.
$TRUTH
$STYLE"

REVIEWER="You are the Staff Code Reviewer on the founder's team across his GitHub repos.
$TOOLS
$LEAD
A review he asks for: brief claude to review the PR with its pr-adversary skill, run the repo's tests on real services (team-services start postgres redis) and return a verdict with evidence; relay it word for word. agy: an independent second review. A stand-in (PGlite, mocks) is named as one, never passed off as the real check.
$TRUTH
$STYLE"

# DevOps: this script refreshes its prompt and computer when it exists and never creates it.
DEVOPS="You are the DevOps Engineer on the founder's team: servers, uptime, container health.
$TOOLS
$LEAD
Recurring work is an OpenDots scheduled task: dot-task create '<prompt>' --interval <seconds>; dot-task list|show|run|pause|cancel. Tasks run one at a time and your turn is one: a run you queue starts after your turn ends, so report its id and never wait for it; dot-task show <id> reads its answer later.
$TRUTH
$STYLE"

for v in CHIEF ARCHITECT BUILDER REVIEWER DEVOPS; do
  n=$(printf %s "${!v}" | wc -m); ((n <= 2000)) || { echo "$v prompt is $n characters (max 2000)" >&2; exit 1; }
done

ws=$(api GET /workspace)
space=$(jq -r '.spaces[] | select(.name=="Everyday") | .id' <<<"$ws")
[[ -n $space ]] || { echo "no Everyday space" >&2; exit 1; }
dot_id() { jq -r --arg n "$1" '.dots[] | select(.name==$n) | .id' <<<"$ws" | head -1; }
# Learning stays off: an ID with no container in Intelligence fails every new conversation ("Thread lock denied",
# 404 LEARNING_CONTAINER_NOT_FOUND), and saving the ID never creates one. Create the container first (OpenDots
# docs/SETUP.md#automatic-learning), then set it here.
body() { jq -nc --arg n "$1" --arg i "$2" '{name:$n, instructions:$i, researchAllowed:true, memoryAllowed:true, learningContainerId:null, skillDeliveryEnabled:false}'; }
SHELL_PERMS='{"enabled":true,"browser":true,"files":true,"shell":true}'

upsert() { # name instructions [old name] -> id
  local id; id=$(dot_id "$1"); [[ -n $id || -z ${3:-} ]] || id=$(dot_id "$3")
  if [[ -z $id ]]; then
    id=$(api POST /dots "$(body "$1" "$2" | jq -c --arg s "$space" '. + {spaceId:$s}')" | jq -r .id)
  else
    api PUT "/dots/$id" "$(body "$1" "$2")" >/dev/null
  fi
  echo "$id"
}

chief=$(dot_id "Chief of Staff"); [[ -n $chief ]] || chief=$(dot_id "Dot")
api PUT "/dots/$chief" "$(body "Chief of Staff" "$CHIEF")" >/dev/null
api PATCH "/dots/$chief/computer/permissions" "$SHELL_PERMS" >/dev/null # browser off reads as "Computer permission is disabled"

builder=$(upsert Builder "$BUILDER" Engineer)
architect=$(upsert Architect "$ARCHITECT")
reviewer=$(upsert Reviewer "$REVIEWER")
for id in "$builder" "$architect" "$reviewer"; do api PATCH "/dots/$id/computer/permissions" "$SHELL_PERMS" >/dev/null; done
devops=$(dot_id DevOps)
ALL=("$builder" "$architect" "$reviewer" "$chief")
if [[ -n $devops ]]; then
  api PUT "/dots/$devops" "$(body DevOps "$DEVOPS")" >/dev/null
  api PATCH "/dots/$devops/computer/permissions" "$SHELL_PERMS" >/dev/null
  ALL+=("$devops")
fi

# Computers: start them, then copy the Builder's logins into the others (never printed).
box() { echo "opendots-computer-$1"; }
up() { [[ $(docker inspect -f '{{.State.Running}}' "$(box "$1")" 2>/dev/null) == true ]]; }
for id in "${ALL[@]}"; do
  up "$id" || api POST "/dots/$id/computer/start" '{}' >/dev/null
done
for id in "${ALL[@]}"; do
  for _ in $(seq 60); do up "$id" && break; sleep 2; done
  up "$id" || { echo "computer for $id did not start" >&2; exit 1; }
done
LOGINS=(.claude-token .claude.json .config/gh/hosts.yml .config/gh/config.yml .gitconfig)
AGY=(.gemini/antigravity-cli/antigravity-oauth-token .gemini/config/config.json)
copy() { # to-id files...
  local to=$1; shift
  docker exec -w /workspace "$(box "$builder")" tar -cf - "$@" | docker exec -i -w /workspace "$(box "$to")" tar -xf - --no-same-owner --skip-old-files
}
for id in "${ALL[@]:1}"; do copy "$id" "${LOGINS[@]}" "${AGY[@]}"; done
# Refresh the helpers without an image rebuild; the copy lasts until the computer is recreated, and reruns redo it.
# A new file renamed over the old one: older images have run-bg owned by ubuntu, which root cannot write to without
# CAP_DAC_OVERRIDE (unprivileged computers drop all capabilities), but root owns /usr/local/bin, and a rename never
# truncates a running script.
helpers() {
  local tool
  for tool in dot-task run-bg; do
    [[ -f "$HERE/$tool" ]] || continue
    docker exec -i "$(box "$1")" sh -c \
      'f=/usr/local/bin/$1; cat > "$f.new" && chmod 755 "$f.new" && mv -f "$f.new" "$f"' sh "$tool" < "$HERE/$tool"
  done
}
for id in "${ALL[@]}"; do
  docker exec -e HOME=/workspace "$(box "$id")" sh -c '
    login=$(gh api user -q .login) && git config --global user.name "$login" &&
    git config --global user.email "$(gh api user -q "\"\(.id)+\(.login)@users.noreply.github.com\"")" &&
    mkdir -p /workspace/repos /workspace/tmp /workspace/runs && echo "$login"' >/dev/null ||
    { echo "gh login missing in $(box "$id")" >&2; exit 1; }
  printf '%s\n' "$T" | docker exec -i "$(box "$id")" sh -c 'cat > /workspace/.opendots-token && chmod 600 /workspace/.opendots-token'
  helpers "$id"
  docker exec -i "$(box "$id")" sh -c '
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
done

# Every computer gets the same engineering rules and skills (deploy/opendots/home), like an employee's laptop:
# ~/.claude/CLAUDE.md and ~/.gemini/GEMINI.md, plus the skills for claude and agy. Reruns overwrite what this
# script installed; other skills in a computer are left alone.
stage=$(mktemp -d); trap 'rm -r "$stage"' EXIT
mkdir -p "$stage/.claude" "$stage/.gemini/config"
cp "$HERE/home/CLAUDE.md" "$stage/.claude/CLAUDE.md"; cp "$HERE/home/CLAUDE.md" "$stage/.gemini/GEMINI.md"
cp -R "$HERE/home/skills" "$stage/.claude/skills"; cp -R "$HERE/home/skills" "$stage/.gemini/config/skills"
for id in "${ALL[@]}"; do
  # GEMINI.md was a symlink to the laptop-era /opt/agent-rules, which no computer has.
  docker exec -w /workspace "$(box "$id")" sh -c \
    'rm -f .gemini/GEMINI.md; for s; do rm -r -f ".claude/skills/$s" ".gemini/config/skills/$s"; done' sh $(ls "$HERE/home/skills")
  tar -C "$stage" -cf - .claude .gemini | docker exec -i -w /workspace "$(box "$id")" tar -xf - --no-same-owner --no-overwrite-dir
done

# Rules the founder keeps out of git (the Oplify instructions): /opt/opendots/local-rules/<owner>.md on this host
# goes to /workspace/local-rules in every computer; home/CLAUDE.md tells claude and agy to read it for that owner's
# repos. Nothing here is committed anywhere.
LOCAL_RULES=${TEAM_LOCAL_RULES:-/opt/opendots/local-rules}
if compgen -G "$LOCAL_RULES/*.md" >/dev/null; then
  for id in "${ALL[@]}"; do
    tar -C "$LOCAL_RULES" -cf - $(cd "$LOCAL_RULES" && ls -- *.md) |
      docker exec -i "$(box "$id")" sh -c 'mkdir -p /workspace/local-rules && tar -C /workspace/local-rules -xf - --no-same-owner'
  done
fi

# The shared brain over HTTP (src/mcp/hub-http.ts, deploy/founderos-hub-http.service on the host), for claude and agy
# in every computer. The computers get the brain-only token: they run repo code as root, so that code can read whatever
# token they hold. The Chief Dot gets the full token (adds calendar and mail reads) as an OpenDots Connection, stored
# in the app's database, never in a computer. Skipped until the hub is installed. Tokens never reach the host's argv.
HUB_ENV=${OPENDOTS_HUB_ENV:-/etc/founderos/hub-http.env}
if [[ -r $HUB_ENV ]]; then
  hub_var() { grep "^$1=" "$HUB_ENV" | cut -d= -f2- || true; }
  port=$(hub_var HUB_HTTP_PORT)
  HUB_URL="http://$(hub_var HUB_HTTP_HOST):${port:-3100}/mcp"
  for id in "${ALL[@]}"; do
    hub_var HUB_HTTP_BRAIN_TOKEN | docker exec -i -e HOME=/workspace -e HUB_URL="$HUB_URL" "$(box "$id")" sh -c '
      t=$(cat); claude mcp remove -s user turicks-brain >/dev/null 2>&1
      claude mcp add-json -s user turicks-brain \
        "{\"type\":\"http\",\"url\":\"$HUB_URL\",\"headers\":{\"Authorization\":\"Bearer $t\"}}" >/dev/null || exit 1
      # agy keeps its servers in ~/.gemini/config/mcp_config.json. The Builder held the laptop-era stdio entry
      # (node /opt/agent-rules/brain-mcp.mjs), which cannot start here; remove it, then add the same HTTP hub.
      agy mcp remove turicks-brain >/dev/null 2>&1
      agy mcp add --header "Authorization: Bearer $t" turicks-brain "$HUB_URL" >/dev/null' ||
      { echo "could not add the brain MCP in $(box "$id")" >&2; exit 1; }
  done
  conn=$(api GET "/dots/$chief/connections" | jq -r '.[] | select(.name=="turicks-brain") | .id' | head -1)
  if [[ -z $conn ]]; then
    conn=$(jq -nc --arg u "$HUB_URL" --rawfile e "$HUB_ENV" \
      '{name:"turicks-brain", url:$u, token:($e | capture("(^|\n)HUB_HTTP_TOKEN=(?<t>[^\n]+)").t)}' |
      curl -fsS -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' --data @- \
        "http://127.0.0.1:4310/api/dots/$chief/connections" | jq -r .id)
  fi
  # Reads run on their own; brain writes and call_connected_tool (other servers, may write) stay on Ask first.
  for tool in search_memory get_memory gmail_search calendar_events list_connected_tools; do
    api PATCH "/connections/$conn/tools/$tool" '{"enabled":true,"requiresApproval":false}' >/dev/null
  done
  echo "brain: claude and agy MCP in ${#ALL[@]} computers, Chief connection $conn"
else
  echo "brain: $HUB_ENV not readable, skipped (install deploy/founderos-hub-http.service first)"
fi

# Retired 2026-10-13 (founder: "simplify the setup"): the GitHub-label pipeline (team-shift, chief-run, shift-cron,
# shift-notify). Remove its host cron lines and cancel its "<Role> shift:" tasks; their conversations stay.
current=$(crontab -l 2>/dev/null || true)
if grep -q -e ' # opendots-shift$' -e ' # opendots-notify$' <<<"$current"; then
  { grep -v -e ' # opendots-shift$' -e ' # opendots-notify$' <<<"$current" || true; } | crontab -
  echo "cron: removed the shift-cron and shift-notify lines"
fi
api GET /state | jq -r '.tasks[] | select(.status != "cancelled" and (.prompt | test("^(Architect|Builder|Reviewer) shift: follow your SHIFT rules"))) | .id' |
  while read -r task; do
    api POST "/tasks/$task/actions" '{"action":"cancel"}' >/dev/null
    echo "cancelled retired shift task $task"
  done
rm -f "$(dirname "$APP")/shift-tasks"
echo "dots: chief=$chief builder=$builder architect=$architect reviewer=$reviewer devops=${devops:-none}"
