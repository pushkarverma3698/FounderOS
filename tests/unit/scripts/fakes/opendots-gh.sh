#!/usr/bin/env bash
# Fake gh for opendots-team-shift.test.ts: items (labels, comments) live in $FAKE/items.json.
set -euo pipefail
S=$FAKE/items.json
printf '%s\n' "$*" >> "$FAKE/gh.log"
kind=$1; sub=${2:-}; shift 2 || true
n=""; repo=""; label=""; json=""; q="."; adds=(); rems=()
while (($#)); do
  case "$1" in
    -R) repo=$2; shift 2 ;;
    --label) label=$2; shift 2 ;;
    --json) json=$2; shift 2 ;;
    --jq) q=$2; shift 2 ;;
    --add-label) adds+=("$2"); shift 2 ;;
    --remove-label) rems+=("$2"); shift 2 ;;
    --state|--body-file) shift 2 ;;
    --force|--silent) shift ;;
    *) [[ -z $n ]] && n=$1; shift ;;
  esac
done
case "$kind $sub" in
  "issue list"|"pr list")
    jq -c --arg r "$repo" --arg k "$kind" --arg l "$label" \
      '[.[] | select(.repo==$r and .kind==$k and (.labels|index($l))) | {number, createdAt}]' "$S" | jq -r "$q" ;;
  "issue view"|"pr view")
    jq -c --arg r "$repo" --arg k "$kind" --argjson n "$n" \
      '.[] | select(.repo==$r and .kind==$k and .number==$n) | {labels: [.labels[] | {name: .}], comments: [.comments[] | {body: .}]}' "$S" | jq -r "$q" ;;
  "issue edit"|"pr edit")
    a=$(printf '%s\n' ${adds[@]+"${adds[@]}"} | jq -R . | jq -sc .)
    d=$(printf '%s\n' ${rems[@]+"${rems[@]}"} | jq -R . | jq -sc .)
    jq --arg r "$repo" --arg k "$kind" --argjson n "$n" --argjson a "$a" --argjson d "$d" \
      'map(if .repo==$r and .kind==$k and .number==$n then .labels = ((.labels - $d) + ($a - [""]) | unique) else . end)' \
      "$S" > "$S.tmp" && mv "$S.tmp" "$S" ;;
  "issue comment"|"pr comment")
    body=$(cat)
    jq --arg r "$repo" --arg k "$kind" --argjson n "$n" --arg b "$body" \
      'map(if .repo==$r and .kind==$k and .number==$n then .comments += [$b] else . end)' "$S" > "$S.tmp" && mv "$S.tmp" "$S" ;;
  "label create") ;;
  "api "*) [[ -f $FAKE/has-beta ]] ;;
  "repo view") echo main ;;
  *) echo "fake gh: unhandled $kind $sub" >&2; exit 9 ;;
esac
