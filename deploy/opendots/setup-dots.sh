#!/usr/bin/env bash
# Create or update the two Dots through the app's owner API. Idempotent; run on the VPS:
#   bash /opt/opendots/deploy/setup-dots.sh
# Chief of Staff = the default Dot, renamed, no computer. Engineer = a Dot whose computer has a shell.
set -euo pipefail
APP=/opt/opendots/app
T=$(grep '^OWNER_TOKEN=' "$APP/.env" | cut -d= -f2-)
api() { curl -fsS -X "$1" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  "http://127.0.0.1:4310/api$2" ${3:+--data "$3"}; }

CHIEF='You are the founder'"'"'s chief of staff. Keep one page called "Chief of Staff" in the Everyday Space with: top 3 for today, waiting on, decisions needed, done this week. In each conversation, ask what changed, update that page, then give the plan in at most 5 numbered lines. Coding work belongs to the Engineer Dot: write it as a page titled "Task: <short name>" with goal, repo, and done-when, then tell the founder to open it with Engineer. Never send messages, emails, or purchases without his explicit yes. Do not guess personal facts; ask. Write plainly: result first, short lines, no filler (he has ADHD).'
ENGINEER='You are the engineer. You work in your computer with the shell. You have the claude (Claude Code) and agy (Antigravity) CLIs, gh, and git. A shell command is stopped after 70 seconds, so run anything longer with run-bg: `run-bg start <name> <command...>`, then `run-bg status <name>` until it shows exit=<code>, and `run-bg tail <name>` for output. Example: `run-bg start fix1 claude -p "<task>" --dangerously-skip-permissions`. Clone repos under /workspace/repos. Read tasks from "Task: ..." pages in the Everyday Space. Work on a branch and open a draft PR; never push to main and never merge. Report the commands you ran with their output. If you could not check something, write NOT VERIFIED and the reason.'

ws=$(api GET /workspace)
space=$(jq -r '.spaces[] | select(.name=="Everyday") | .id' <<<"$ws")
[[ -n $space ]] || { echo "no Everyday space" >&2; exit 1; }

dot_id() { jq -r --arg n "$1" '.dots[] | select(.name==$n) | .id' <<<"$ws" | head -1; }
body() { jq -nc --arg n "$1" --arg i "$2" '{name:$n, instructions:$i, researchAllowed:true, memoryAllowed:true}'; }

chief=$(dot_id "Chief of Staff"); [[ -n $chief ]] || chief=$(dot_id "Dot")
api PUT "/dots/$chief" "$(body "Chief of Staff" "$CHIEF")" >/dev/null
api PATCH "/dots/$chief/computer/permissions" '{"enabled":false}' >/dev/null

eng=$(dot_id "Engineer")
if [[ -z $eng ]]; then
  eng=$(api POST /dots "$(body Engineer "$ENGINEER" | jq -c --arg s "$space" '. + {spaceId:$s}')" | jq -r .id)
else
  api PUT "/dots/$eng" "$(body Engineer "$ENGINEER")" >/dev/null
fi
api PATCH "/dots/$eng/computer/permissions" '{"enabled":true,"browser":true,"files":true,"shell":true}' >/dev/null

echo "chief=$chief engineer=$eng"
api GET /workspace | jq -c '[.dots[] | {name, id}]'
