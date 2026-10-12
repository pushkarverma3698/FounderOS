#!/usr/bin/env bash
# Create or update the Dots through the app's owner API. Idempotent; run on the VPS:
#   bash /opt/opendots/deploy/setup-dots.sh
# Chief of Staff = the default Dot, renamed; each chat turn runs chief-run (claude haiku does the gh work, agy when
# claude is at its limit), so its computer gets the Builder's claude, agy and gh logins.
# Architect, Builder, Reviewer = the engineering team: each has a computer and a "shift" task that runs team-shift
# (claude does the work), and they hand work over with GitHub labels. A host cron (shift-cron, every SHIFT_SECONDS)
# wakes a shift task only when `team-shift --check` finds work, so an idle shift makes no paid model call. The Builder is the old Engineer Dot (renamed); the others
# get copies of its logins once. Reruns never overwrite a login a Dot already has (dot-login switches it).
# Shift tasks are created PAUSED; cron never wakes a paused task. Start one in the app (Tasks → Run) or:
# POST /api/tasks/<id>/actions {"action":"run"}.
set -euo pipefail
APP=${OPENDOTS_APP:-/opt/opendots/app}
# Whitespace-separated owner/repo the team may work in: every unarchived, non-fork repo the founder can push to
# (founder 2026-10-12: "so that i can work on any repo"). The computers' gh login is his own, so it reaches his
# account, OplifyMessage/* and turickai/*. The prompts never list them (the Chief prompt is capped at 2000
# characters); team-shift and chief-run read them from /workspace/team-repos. Not pushkarverma3698/turicks-web:
# issues are off there, and team-shift --check fails for every repo when one repo has no issues.
REPOS=${TEAM_REPOS:-"
  pushkarverma3698/opendots-sandbox pushkarverma3698/FounderOS pushkarverma3698/linkedin-growth-engine-v2
  pushkarverma3698/fos-journey-sandbox pushkarverma3698/turicks-new-experience
  pushkarverma3698/House-of-Hulda-Website-frontend pushkarverma3698/clean-ai pushkarverma3698/claude-code-setup
  pushkarverma3698/Website-Builder-Tool pushkarverma3698/rag-document-qa pushkarverma3698/pushkarverma3698
  OplifyMessage/oplify-messaging-api OplifyMessage/oplify-messaging-app
  turickai/turicks-web turickai/turicks-demo turickai/leadpulse-backend turickai/leadpulse-frontend
  turickai/Co-Working-Space-Website turickai/transporter-app turickai/.github"}
# Idle checks are free (one GitHub call per role), so every minute: a 15-min clock made a one-line task take
# 50 min, nearly all of it hand-offs waiting for the next tick (2026-10-12).
SHIFT_SECONDS=${SHIFT_SECONDS:-60}
SHIFT_TASKS=${OPENDOTS_SHIFT_TASKS:-$(dirname "$APP")/shift-tasks}
HERE=$(cd "$(dirname "$0")" && pwd)
m=$((SHIFT_SECONDS / 60))
if ((m == 60)); then CRON_AT="0 * * * *"
elif ((m * 60 == SHIFT_SECONDS && m > 0 && 60 % m == 0)); then CRON_AT="*/$m * * * *"
else echo "SHIFT_SECONDS=$SHIFT_SECONDS: use 3600 or a whole number of minutes that divides 60" >&2; exit 1; fi
T=$(grep '^OWNER_TOKEN=' "$APP/.env" | cut -d= -f2-)
api() { curl -fsS -X "$1" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  "http://127.0.0.1:4310/api$2" ${3:+--data "$3"}; }

# The Chief is a dispatcher too (AG-063): one chief-run per turn, and claude (haiku; agy when claude is at its limit)
# does the gh work inside it. chief-run checks every action on GitHub and does merges itself.
CHIEF='You are the founder'"'"'s Engineering Chief of Staff and one point of contact. You have full reasoning capability and shell access to your computer.
YOUR POWERS & CAPABILITIES:
- Direct Triage & Investigation: Run terminal commands (computer_exec) to inspect GitHub repos (gh issue list, gh pr list, gh pr checks, gh pr diff, git status), check team runs, and inspect repo states in /workspace/repos.
- Merging & Operations: For merging PRs the founder names or coordinated GitHub runs: run chief-run '"'"'<his exact words>'"'"' with timeoutMs 60000 (no computer_snapshot, screenshot or browser step first). If output says "still running: chief-<id>", check with chief-run --status chief-<id>.
- Superpower CLIs & Logins: Use dot-login status, or dot-login to log into claude, agy, or gh.
- Brain & Everyday Tools: Use turicks-brain tools (calendar_events, gmail_search, search_memory) for calendar, emails, or past decisions.
- Day Planning: When asked for day planning, maintain the "Chief of Staff" page in Everyday Space (top 3 for today, waiting on, decisions needed, done this week), in <= 5 numbered lines.
HOW TO ACT:
- Act like a real Chief of Staff: proactive, decisive, technically sharp. Never say you cannot touch GitHub. Keep ✓, ✗, NOT VERIFIED lines intact.
- Never send external messages, emails, or purchases without explicit approval. Do not guess personal facts; ask.
- Keep answers terse, active, and result-first (he has ADHD).'

ARCHITECT='You are the Systems Architect on the founder'"'"'s engineering team across his GitHub repos. You have full reasoning capability and shell access to your computer.
YOUR POWERS & CAPABILITIES:
- Direct Architecture & Investigation: Run terminal commands (computer_exec) to explore /workspace/repos, inspect code structures, schemas, list issues (gh issue list, gh issue view), and evaluate dependencies.
- Planning & Issue Breakdown: Design clean architectural plans with Goal, Done When, Files, Steps, Test Plan, Risks, and Out of Scope. Break complex epics into child issues (Part of #P, agent:build) and manage "Builds on: #N" stacks.
- Superpower Engines (Claude CLI & AGY CLI):
  * Autonomous architectural planning shift: team-shift architect.
  * Deep codebase inspection: team-shift architect --inspect --engine agy|claude --repo <repo> --task '"'"'<task>'"'"'.
  * Progress: team-shift architect --progress.
- Logins: Use dot-login to authenticate claude, agy, or gh.
HOW TO ACT:
- High-signal, rigorous, grounded in the real codebase. Never claim ignorance of GitHub or code files.
- Keep plans structured, concise, and actionable (founder has ADHD).'

BUILDER='You are a Senior Software Engineer on the founder'"'"'s team across his GitHub repos. You have full reasoning capability and shell access to your computer.
YOUR POWERS & CAPABILITIES:
- Direct CLI & Investigation: Run terminal commands (computer_exec) to inspect /workspace/repos, read code, check git status/log, list/inspect GitHub issues and PRs (gh issue list, gh pr list, gh pr diff, gh pr checks), check test suites (pnpm test, vitest, pytest), and manage local databases (team-services start|stop|status postgres redis). Never run apt-get, docker, or unshare.
- Superpower Coding Engines (Claude CLI & AGY CLI): For writing code, fixing bugs, multi-file features, and creating draft PRs, unleash your autonomous CLIs:
  * Full task (issue + branch + PR): team-shift builder --engine agy|claude --repo <repo> --task '"'"'<exact words>'"'"' (default: claude; omit --repo if not named).
  * Direct inspection / quick deep audits: team-shift builder --inspect --engine agy|claude --repo <repo> --task '"'"'<exact words>'"'"'.
  * Scheduled shift: team-shift builder.
  * Check run progress: team-shift builder --progress.
- Logins: Use dot-login status, or dot-login to authenticate claude, agy, or gh. Never say the Chief handles claude or agy.
HOW TO ACT:
- Act like a real, competent human engineer employee: never say "that'"'"'s outside my lane" or "I cannot read GitHub". You have gh, git, claude, agy, and the full shell on your computer.
- When the founder asks questions, audits, or issue lookups, investigate and reply with clear, factual data.
- When asked to build or fix code, dispatch to claude or agy via team-shift, and report the run results.
- Keep answers terse, active, and result-first (he has ADHD). No filler or disclaimers.'

REVIEWER='You are the Staff Code Reviewer on the founder'"'"'s engineering team across his GitHub repos. You have full reasoning capability and shell access to your computer.
YOUR POWERS & CAPABILITIES:
- Direct PR Review & Testing: Run terminal commands (computer_exec) to inspect PR diffs (gh pr diff), verify CI checks (gh pr checks), check out PR branches, run test suites (pnpm test, vitest, pytest), test databases (team-services start postgres redis), and comment feedback (gh pr comment).
- Superpower Review Engines (Claude CLI & AGY CLI):
  * Autonomous adversarial review shift: team-shift reviewer.
  * Deep inspection or audit: team-shift reviewer --inspect --engine agy|claude --repo <repo> --task '"'"'<task>'"'"'.
  * Progress: team-shift reviewer --progress.
- Logins: Use dot-login to authenticate claude, agy, or gh.
HOW TO ACT:
- Act like an uncompromising quality gatekeeper: verify the real path, look for edge cases, regression risks, and security flaws.
- Never say you cannot read GitHub; you have gh and git ready to use.
- Deliver findings with clear evidence (commands and diffs), concise and direct (founder has ADHD).'

for v in CHIEF ARCHITECT BUILDER REVIEWER; do
  n=$(printf %s "${!v}" | wc -m); ((n <= 2000)) || { echo "$v prompt is $n characters (max 2000)" >&2; exit 1; }
done

ws=$(api GET /workspace)
space=$(jq -r '.spaces[] | select(.name=="Everyday") | .id' <<<"$ws")
[[ -n $space ]] || { echo "no Everyday space" >&2; exit 1; }
dot_id() { jq -r --arg n "$1" '.dots[] | select(.name==$n) | .id' <<<"$ws" | head -1; }
body() { jq -nc --arg n "$1" --arg i "$2" '{name:$n, instructions:$i, researchAllowed:true, memoryAllowed:true}'; }
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

# Computers: start them, then copy the Builder's logins into the other two (never printed).
box() { echo "opendots-computer-$1"; }
up() { [[ $(docker inspect -f '{{.State.Running}}' "$(box "$1")" 2>/dev/null) == true ]]; }
for id in "$builder" "$architect" "$reviewer" "$chief"; do
  up "$id" || api POST "/dots/$id/computer/start" '{}' >/dev/null
done
for id in "$builder" "$architect" "$reviewer" "$chief"; do
  for _ in $(seq 60); do up "$id" && break; sleep 2; done
  up "$id" || { echo "computer for $id did not start" >&2; exit 1; }
done
LOGINS=(.claude-token .claude.json .config/gh/hosts.yml .config/gh/config.yml .gitconfig)
AGY=(.gemini/antigravity-cli/antigravity-oauth-token .gemini/config/config.json)
copy() { # to-id files...
  local to=$1; shift
  docker exec -w /workspace "$(box "$builder")" tar -cf - "$@" | docker exec -i -w /workspace "$(box "$to")" tar -xf - --no-same-owner --skip-old-files
}
copy "$architect" "${LOGINS[@]}" "${AGY[@]}"
copy "$reviewer" "${LOGINS[@]}" "${AGY[@]}"
copy "$chief" "${LOGINS[@]}" "${AGY[@]}" # chief-run: claude, agy when claude is at its limit
for id in "$builder" "$architect" "$reviewer" "$chief"; do
  docker exec -e HOME=/workspace "$(box "$id")" sh -c '
    login=$(gh api user -q .login) && git config --global user.name "$login" &&
    git config --global user.email "$(gh api user -q "\"\(.id)+\(.login)@users.noreply.github.com\"")" &&
    mkdir -p /workspace/repos /workspace/tmp /workspace/runs && echo "$login"' >/dev/null ||
    { echo "gh login missing in $(box "$id")" >&2; exit 1; }
done

# Every computer gets the same engineering rules and skills (deploy/opendots/home), like an employee's laptop:
# ~/.claude/CLAUDE.md and ~/.gemini/GEMINI.md, plus the skills for claude and agy. Reruns overwrite what this
# script installed; other skills in a computer are left alone.
stage=$(mktemp -d); trap 'rm -r "$stage"' EXIT
mkdir -p "$stage/.claude" "$stage/.gemini/config"
cp "$HERE/home/CLAUDE.md" "$stage/.claude/CLAUDE.md"; cp "$HERE/home/CLAUDE.md" "$stage/.gemini/GEMINI.md"
cp -R "$HERE/home/skills" "$stage/.claude/skills"; cp -R "$HERE/home/skills" "$stage/.gemini/config/skills"
for id in "$builder" "$architect" "$reviewer" "$chief"; do
  # GEMINI.md was a symlink to the laptop-era /opt/agent-rules, which no computer has.
  docker exec -w /workspace "$(box "$id")" sh -c \
    'rm -f .gemini/GEMINI.md; for s; do rm -r -f ".claude/skills/$s" ".gemini/config/skills/$s"; done' sh $(ls "$HERE/home/skills")
  tar -C "$stage" -cf - .claude .gemini | docker exec -i -w /workspace "$(box "$id")" tar -xf - --no-same-owner --no-overwrite-dir
done

# Rules the founder keeps out of git (the Oplify instructions): /opt/opendots/local-rules/<owner>.md on this host
# goes to /workspace/local-rules in every computer, and team-shift puts it in that owner's clones as git-excluded
# files. Nothing here is committed anywhere.
LOCAL_RULES=${TEAM_LOCAL_RULES:-/opt/opendots/local-rules}
if compgen -G "$LOCAL_RULES/*.md" >/dev/null; then
  for id in "$builder" "$architect" "$reviewer" "$chief"; do
    tar -C "$LOCAL_RULES" -cf - $(cd "$LOCAL_RULES" && ls -- *.md) |
      docker exec -i "$(box "$id")" sh -c 'mkdir -p /workspace/local-rules && tar -C /workspace/local-rules -xf - --no-same-owner'
  done
fi

# The shared brain over HTTP (src/mcp/hub-http.ts, deploy/founderos-hub-http.service on the host), for claude in
# every computer. The computers get the brain-only token: they run repo code as root, so that code can read whatever
# token they hold. The Chief Dot gets the full token (adds calendar and mail reads) as an OpenDots Connection, stored
# in the app's database, never in a computer. Skipped until the hub is installed. Tokens never reach the host's argv.
HUB_ENV=/etc/founderos/hub-http.env
if [[ -r $HUB_ENV ]]; then
  hub_var() { grep "^$1=" "$HUB_ENV" | cut -d= -f2- || true; }
  port=$(hub_var HUB_HTTP_PORT)
  HUB_URL="http://$(hub_var HUB_HTTP_HOST):${port:-3100}/mcp"
  for id in "$builder" "$architect" "$reviewer" "$chief"; do
    hub_var HUB_HTTP_BRAIN_TOKEN | docker exec -i -e HOME=/workspace -e HUB_URL="$HUB_URL" "$(box "$id")" sh -c '
      t=$(cat); claude mcp remove -s user turicks-brain >/dev/null 2>&1
      claude mcp add-json -s user turicks-brain \
        "{\"type\":\"http\",\"url\":\"$HUB_URL\",\"headers\":{\"Authorization\":\"Bearer $t\"}}" >/dev/null' ||
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
  echo "brain: claude MCP in 4 computers, Chief connection $conn"
else
  echo "brain: $HUB_ENV not readable, skipped (install deploy/founderos-hub-http.service first)"
fi

# team-shift and chief-run read the repos they may work in from /workspace/team-repos (one per line).
for id in "$builder" "$architect" "$reviewer" "$chief"; do
  printf '%s\n' $REPOS | docker exec -i "$(box "$id")" sh -c 'cat > /workspace/team-repos'
done

# Shifts: one task per role, in its own "Shift" conversation, with no interval: shift-cron wakes it. Created paused;
# never duplicated (a role's task is found by its prompt, which names the role).
state=$(api GET /state)
shifts=""
for pair in "Architect:$architect" "Builder:$builder" "Reviewer:$reviewer"; do
  name=${pair%%:*} id=${pair#*:}
  conv=$(api GET /workspace | jq -r --arg d "$id" '.conversations[] | select(.dotId==$d and .title=="Shift") | .id' | head -1)
  [[ -n $conv ]] || conv=$(api POST /conversations "$(jq -nc --arg d "$id" '{dotId:$d, title:"Shift"}')" | jq -r .id)
  SHIFT="$name shift: follow your SHIFT rules for one item, or reply \"No work\"."
  read -r task every < <(jq -r --arg p "$SHIFT" \
    '[.tasks[] | select(.prompt==$p and .status!="cancelled")][0] // empty | "\(.id) \(.intervalSeconds)"' <<<"$state") || true
  if [[ -z ${task:-} ]]; then
    task=$(api POST /tasks "$(jq -nc --arg p "$SHIFT" --arg c "$conv" '{prompt:$p, threadId:$c}')" | jq -r .id)
    api POST "/tasks/$task/actions" '{"action":"pause"}' >/dev/null
  elif [[ $every != null ]]; then # an existing task keeps its paused/completed state
    api PUT "/tasks/$task/schedule" '{"intervalSeconds":null}' >/dev/null
  fi
  shifts+="$(tr '[:upper:]' '[:lower:]' <<<"$name") $id $task"$'\n'
  echo "$name dot=$id shift-task=$task conversation=$conv"
done
printf '%s' "$shifts" > "$SHIFT_TASKS"
cron_line="$CRON_AT bash $HERE/shift-cron >> $(dirname "$SHIFT_TASKS")/shift-cron.log 2>&1 # opendots-shift"
current=$(crontab -l 2>/dev/null || true)
# shift-notify (every minute): a Telegram line to the founder when a role finishes or blocks an item.
notify_line="* * * * * bash $HERE/shift-notify >> $(dirname "$SHIFT_TASKS")/shift-notify.log 2>&1 # opendots-notify"
{ grep -v -e ' # opendots-shift$' -e ' # opendots-notify$' <<<"$current" || true; echo "$cron_line"; echo "$notify_line"; } |
  grep -v '^$' | crontab -
echo "cron: $CRON_AT shift-cron, every minute shift-notify"
echo "chief=$chief"
