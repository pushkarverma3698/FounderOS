#!/usr/bin/env bash
# Fake gh for opendots-chief-run.test.ts: issues and PRs live in $FAKE/items.json as
# {repo, number, kind, state, labels, created_at, comments: [{created_at}], closes: [issue numbers]}. Logs every call.
set -euo pipefail
S=$FAKE/items.json
printf '%s\n' "$*" >> "$FAKE/gh.log"
kind=$1; sub=${2:-}; shift 2 || true
n=""; repo=""; q="."; head=""; newbase=""
while (($#)); do
  case "$1" in
    -R) repo=$2; shift 2 ;;
    --jq) q=$2; shift 2 ;;
    --json | --comment | --state) shift 2 ;;
    --head) head=$2; shift 2 ;;
    --base) newbase=$2; shift 2 ;;
    --merge) shift ;;
    *) [[ -z $n ]] && n=$1; shift ;;
  esac
done
one() { jq -c --arg r "$1" --argjson n "$2" '.[] | select(.repo==$r and .number==$n)' "$S"; }
set_state() { jq --arg r "$1" --argjson n "$2" --arg s "$3" 'map(if .repo==$r and .number==$n then .state=$s else . end)' "$S" > "$S.tmp" && mv "$S.tmp" "$S"; }
case "$kind" in
  api)
    path=${sub%%\?*} since=$(sed -n 's/.*since=//p' <<<"$sub")
    r=$(cut -d/ -f2,3 <<<"$path") num=$(cut -d/ -f5 <<<"$path")
    it=$(one "$r" "$num"); [[ -n $it ]] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    if [[ $path == */comments ]]; then jq -c --arg s "$since" '[.comments[] | select(.created_at >= $s)]' <<<"$it"
    else jq -c '{number, state: (.state|ascii_downcase), created_at, labels: [.labels[] | {name: .}]} +
      (if .kind=="pr" then {pull_request: {}} else {} end)' <<<"$it"; fi | jq -r "$q" ;;
  pr)
    case "$sub" in
      view) it=$(one "$repo" "$n"); [[ -n $it ]] || { echo "no pull requests found" >&2; exit 1; }
        jq -c --arg r "$repo" '{state, labels: [.labels[] | {name: .}], baseRefName: (.base // "beta"), headRefName: (.head // "branch-\(.number)"),
          url: "https://github.com/\($r)/pull/\(.number)", closingIssuesReferences: [(.closes // [])[] | {number: .}]}' <<<"$it" ;;
      list) jq -c --arg r "$repo" --arg h "$head" '[.[] | select(.repo==$r and .kind=="pr" and (.head // "") == $h)
          | {number, state, baseRefName: (.base // "beta"), labels: [.labels[] | {name: .}]}]' "$S" | jq -r "$q" ;;
      edit) [[ -e $FAKE/edit-fails ]] && { echo "GraphQL: Base branch was modified" >&2; exit 1; }
        jq --arg r "$repo" --argjson n "$n" --arg b "$newbase" 'map(if .repo==$r and .number==$n then .base=$b else . end)' "$S" > "$S.tmp" && mv "$S.tmp" "$S" ;;
      merge) [[ -e $FAKE/merge-fails ]] && { echo "X Pull request $repo#$n is not mergeable: the merge commit cannot be cleanly created." >&2; exit 1; }
        set_state "$repo" "$n" MERGED ;;
      *) echo "fake gh: unhandled pr $sub" >&2; exit 9 ;;
    esac ;;
  issue)
    case "$sub" in
      view) it=$(one "$repo" "$n"); [[ -n $it ]] || { echo "no issues found" >&2; exit 1; }
        jq -c '{state}' <<<"$it" | jq -r "$q" ;;
      close) [[ -e $FAKE/close-fails ]] && { echo "GraphQL: Resource not accessible" >&2; exit 1; }
        set_state "$repo" "$n" CLOSED ;;
      *) echo "fake gh: unhandled issue $sub" >&2; exit 9 ;;
    esac ;;
  *) echo "fake gh: unhandled $kind $sub" >&2; exit 9 ;;
esac
