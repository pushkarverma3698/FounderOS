#!/usr/bin/env bash
# Fake curl for the OpenDots owner API (opendots-team-shift.test.ts). Logs "METHOD PATH DATA" to $FAKE/curl.log;
# GET /workspace and /state answer from $FAKE/workspace.json and $FAKE/state.json; a POST that creates returns an id.
set -euo pipefail
method=GET url="" data="" auth=""
while (($#)); do
  case "$1" in
    -X) method=$2; shift 2 ;;
    --data) data=$2; shift 2 ;;
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
  "GET /tasks/"*) t=${path#/tasks/}; jq -nc --arg s "$(cat "$FAKE/task-$t" 2>/dev/null || echo completed)" '{task:{status:$s}}' ;;
  "POST /dots"|"POST /conversations"|"POST /tasks") echo '{"id":"new-'"${path#/}"'"}' ;;
  *) echo '{}' ;;
esac
