#!/usr/bin/env bash
# Fake curl for the OpenDots owner API (opendots-setup-dots.test.ts, opendots-dot-task.test.ts). Logs "METHOD PATH
# DATA" to $FAKE/curl.log; GET /workspace, /state and /tasks/<id> answer from $FAKE/workspace.json, state.json and
# task-<id>.json; a POST that creates returns an id.
set -euo pipefail
method=GET url="" data="" auth=""
while (($#)); do
  case "$1" in
    -X) method=$2; shift 2 ;;
    # Read `--data @-` like real curl does: a writer piping into an unread stdin dies of SIGPIPE (exit 141).
    --data) data=$2; [[ $data == @- ]] && data=$(cat); shift 2 ;;
    -H) [[ $2 == Authorization:* ]] && auth=$2; shift 2 ;;
    http*) url=$1; shift ;;
    *) shift ;;
  esac
done
[[ $auth == "Authorization: Bearer $FAKE_OWNER_TOKEN" ]] || { echo "fake curl: bad auth" >&2; exit 22; }
path=${url#*/api}
printf '%s %s %s\n' "$method" "$path" "$data" >> "$FAKE/curl.log"
case "$method $path" in
  "GET /workspace") cat "$FAKE/workspace.json" ;;
  "GET /state") cat "$FAKE/state.json" ;;
  "GET /tasks/"*) t=${path#/tasks/}; [[ -f $FAKE/task-$t.json ]] && { cat "$FAKE/task-$t.json"; exit 0; }; jq -nc --arg s "$(cat "$FAKE/task-$t" 2>/dev/null || echo completed)" '{task:{status:$s}}' ;;
  "POST /dots"|"POST /conversations"|"POST /tasks") echo '{"id":"new-'"${path#/}"'"}' ;;
  *) echo '{}' ;;
esac
