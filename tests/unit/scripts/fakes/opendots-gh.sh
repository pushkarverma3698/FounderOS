#!/usr/bin/env bash
# Fake gh for opendots-team-shift.test.ts: items (labels, comments) live in $FAKE/items.json.
set -euo pipefail
S=$FAKE/items.json
printf '%s\n' "$*" >> "$FAKE/gh.log"
if [[ ${1:-} == repo && ${2:-} == clone ]]; then mkdir -p "$4/.git"; exit 0; fi
kind=$1; sub=${2:-}; shift 2 || true
n=""; repo=""; label=""; json=""; q="."; title=""; body=""; query=""; adds=(); rems=()
while (($#)); do
  case "$1" in
    -R) repo=$2; shift 2 ;;
    --label) label=$2; shift 2 ;;
    --json) json=$2; shift 2 ;;
    --jq) q=$2; shift 2 ;;
    --add-label) adds+=("$2"); shift 2 ;;
    --remove-label) rems+=("$2"); shift 2 ;;
    --title) title=$2; shift 2 ;;
    --body) body=$2; shift 2 ;;
    --comment) body=$2; shift 2 ;;
    --state|--body-file|--limit|--reason) shift 2 ;;
    -f) query=${2#query=}; shift 2 ;;
    --force|--silent) shift ;;
    *) [[ -z $n ]] && n=$1; shift ;;
  esac
done
case "$kind $sub" in
  "issue list"|"pr list")
    [[ -z $label && -e $FAKE/list-fails ]] && { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
    jq -c --arg r "$repo" --arg k "$kind" --arg l "$label" \
      '[.[] | select(.repo==$r and .kind==$k and ($l=="" or (.labels|index($l)))) | {number, createdAt, body: (.body // ""), state: (.state // "OPEN")}]' "$S" | jq -r "$q" ;;
  "issue view"|"pr view")
    [[ $json == body && -e $FAKE/view-body-fails ]] && { echo "GraphQL: Could not resolve" >&2; exit 1; }
    jq -c --arg r "$repo" --arg k "$kind" --argjson n "$n" \
      '.[] | select(.repo==$r and .kind==$k and .number==$n) | {labels: [.labels[] | {name: .}], comments: [.comments[] | {body: .}], body: (.body // "")}' "$S" | jq -r "$q" ;;
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
  "issue close")
    jq --arg r "$repo" --argjson n "$n" --arg b "$body" \
      'map(if .repo==$r and .kind=="issue" and .number==$n then .state = "CLOSED" | .comments += [$b] else . end)' \
      "$S" > "$S.tmp" && mv "$S.tmp" "$S" ;;
  "issue create")
    [[ -e $FAKE/create-fails ]] && { echo "could not add label: 'agent:building' not found" >&2; exit 1; }
    n=$(jq '[.[].number] | max // 0 | . + 1' "$S")
    jq --arg r "$repo" --argjson n "$n" --arg t "$title" --arg b "$body" --arg l "$label" \
      '. + [{repo: $r, kind: "issue", number: $n, labels: [$l], createdAt: "2026-10-11T00:00:00Z", comments: [], title: $t, body: $b}]' \
      "$S" > "$S.tmp" && mv "$S.tmp" "$S"
    echo "https://github.com/$repo/issues/$n" ;;
  "label create") ;;
  "api graphql")
    # team-shift's queue scan: one "rNNN: repository(...)" line per repo, one "sN: issues|pullRequests(labels:[..." per slot.
    [[ -e $FAKE/graphql-fails ]] && { echo "gh: Could not resolve to a Repository" >&2; exit 1; }
    re_repo='^(r[0-9]+): repository\(owner:"([^"]+)", name:"([^"]+)"\)'
    re_slot='^(s[0-9]+): (issues|pullRequests)\(labels:\["([^"]+)"\], states:OPEN, first:1, orderBy:\{field:CREATED_AT, direction:ASC\}\)'
    out='{}'; r=""
    while IFS= read -r line; do
      if [[ $line =~ $re_repo ]]; then r=${BASH_REMATCH[1]}; repo=${BASH_REMATCH[2]}/${BASH_REMATCH[3]}
      elif [[ $line =~ $re_slot ]]; then
        s=${BASH_REMATCH[1]}; k=issue; l=${BASH_REMATCH[3]}
        if [[ ${BASH_REMATCH[2]} == pullRequests ]]; then k=pr; fi
        nodes=$(jq -c --arg r "$repo" --arg k "$k" --arg l "$l" \
          '[.[] | select(.repo==$r and .kind==$k and (.labels|index($l)))] | sort_by(.createdAt) | .[:1] | map({number})' "$S")
        out=$(jq -c --arg r "$r" --arg s "$s" --argjson n "$nodes" '.[$r][$s] = {nodes: $n}' <<<"$out")
      fi
    done <<<"$query"
    jq -c '{data: .}' <<<"$out" | jq -r "$q" ;;
  "api "*) [[ -f $FAKE/has-beta ]] ;;
  "repo view") echo main ;;
  *) echo "fake gh: unhandled $kind $sub" >&2; exit 9 ;;
esac
