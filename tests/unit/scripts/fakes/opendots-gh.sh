#!/usr/bin/env bash
# Fake gh for opendots-team-shift.test.ts: items (labels, comments) live in $FAKE/items.json.
set -euo pipefail
S=$FAKE/items.json
printf '%s\n' "$*" >> "$FAKE/gh.log"
if [[ ${1:-} == repo && ${2:-} == clone ]]; then mkdir -p "$4/.git"; exit 0; fi
kind=$1; sub=${2:-}; shift 2 || true
n=""; repo=""; label=""; json=""; q="."; title=""; body=""; query=""; newbase=""; headref=""; adds=(); rems=()
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
    --base) newbase=$2; shift 2 ;;
    --head) headref=$2; shift 2 ;;
    --force|--silent|--draft|--merge) shift ;;
    *) [[ -z $n ]] && n=$1; shift ;;
  esac
done
case "$kind $sub" in
  "issue list"|"pr list")
    [[ -z $label && -e $FAKE/list-fails ]] && { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
    jq -c --arg r "$repo" --arg k "$kind" --arg l "$label" \
      '[.[] | select(.repo==$r and .kind==$k and ($l=="" or (.labels|index($l)))) | {number, createdAt, title: (.title // ""), body: (.body // ""), state: (.state // "OPEN"),
        headRefName: (.head // "branch-\(.number)"), baseRefName: (.base // "beta"), labels: [.labels[] | {name: .}]}] | sort_by(-.number)' "$S" | jq -r "$q" ;;
  "issue view"|"pr view")
    [[ $json == labels && -e $FAKE/view-labels-fails ]] && { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
    [[ $json == body && -e $FAKE/view-body-fails ]] && { echo "GraphQL: Could not resolve" >&2; exit 1; }
    base=main; [[ -f $FAKE/has-beta ]] && base=beta
    vb=""; [[ -f $FAKE/view-base ]] && vb=$(cat "$FAKE/view-base")
    jq -c --arg r "$repo" --arg k "$kind" --argjson n "$n" --arg base "$base" --arg vb "$vb" \
      '.[] | select(.repo==$r and .kind==$k and .number==$n) | {number, labels: [.labels[] | {name: .}], comments: [.comments[] | {body: .}], body: (.body // ""), title: (.title // ""),
        url: "https://github.com/\($r)/\(if $k == "pr" then "pull" else "issues" end)/\($n)", state: (.state // "OPEN"), headRefName: (.head // "branch-\(.number)"), baseRefName: (if $vb != "" and $k == "pr" then $vb else (.base // $base) end)}' "$S" | jq -r "$q" ;;
  "pr ready")
    [[ -e $FAKE/ready-fails ]] && { echo "GraphQL: Resource not accessible (markPullRequestReadyForReview)" >&2; exit 1; }
    jq --arg r "$repo" --argjson n "$n" 'map(if .repo==$r and .kind=="pr" and .number==$n then .draft = false else . end)' "$S" > "$S.tmp" && mv "$S.tmp" "$S" ;;
  "pr merge")
    [[ $(jq --arg r "$repo" --argjson n "$n" '[.[] | select(.repo==$r and .kind=="pr" and .number==$n and .draft == true)] | length' "$S") == 1 ]] &&
      { echo "X Pull request $repo#$n is still a draft" >&2; exit 1; }
    [[ -e $FAKE/merge-fails ]] && { echo "X Pull request $repo#$n is not mergeable: the merge commit cannot be cleanly created." >&2; exit 1; }
    jq --arg r "$repo" --argjson n "$n" 'map(if .repo==$r and .kind=="pr" and .number==$n then .state = "MERGED" else . end)' "$S" > "$S.tmp" && mv "$S.tmp" "$S" ;;
  "pr create")
    [[ -e $FAKE/pr-create-fails ]] && { echo "GraphQL: Resource not accessible (createPullRequest)" >&2; exit 1; }
    n=$(jq '[.[].number] | max // 0 | . + 1' "$S")
    jq --arg r "$repo" --argjson n "$n" --arg t "$title" --arg b "$body" --arg l "$label" --arg h "$headref" --arg base "$newbase" \
      '. + [{repo: $r, kind: "pr", number: $n, labels: [$l], createdAt: "2026-10-12T00:00:00Z", comments: [], title: $t, body: $b, head: $h, base: $base, draft: true}]' \
      "$S" > "$S.tmp" && mv "$S.tmp" "$S"
    echo "https://github.com/$repo/pull/$n" ;;
  "issue edit"|"pr edit")
    if [[ -n $newbase ]]; then
      [[ -e $FAKE/retarget-fails ]] && { echo "GraphQL: Base branch was modified" >&2; exit 1; }
      jq --arg r "$repo" --argjson n "$n" --arg b "$newbase" 'map(if .repo==$r and .kind=="pr" and .number==$n then .base = $b else . end)' "$S" > "$S.tmp" && mv "$S.tmp" "$S"
    fi
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
    [[ -e $FAKE/close-fails ]] && { echo "GraphQL: Resource not accessible (closeIssue)" >&2; exit 1; }
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
    # GitHub's HTML error page, once: the next call answers.
    if [[ -e $FAKE/graphql-fails-once ]]; then rm "$FAKE/graphql-fails-once"; echo "invalid character '<' looking for beginning of value" >&2; exit 1; fi
    re_repo='^(r[0-9]+): repository\(owner:"([^"]+)", name:"([^"]+)"\)'
    re_slot='^(s[0-9]+): (issues|pullRequests)\(labels:\["([^"]+)"\], states:(OPEN|\[OPEN, MERGED\]), first:([0-9]+), orderBy:\{field:(CREATED_AT|UPDATED_AT), direction:(ASC|DESC)\}\)'
    out='{}'; r=""
    while IFS= read -r line; do
      if [[ $line =~ $re_repo ]]; then r=${BASH_REMATCH[1]}; repo=${BASH_REMATCH[2]}/${BASH_REMATCH[3]}
      elif [[ $line =~ $re_slot ]]; then
        s=${BASH_REMATCH[1]}; k=issue; l=${BASH_REMATCH[3]}
        if [[ ${BASH_REMATCH[2]} == pullRequests ]]; then k=pr; fi
        nodes=$(jq -c --arg r "$repo" --arg k "$k" --arg l "$l" --arg st "${BASH_REMATCH[4]}" --argjson first "${BASH_REMATCH[5]}" --arg dir "${BASH_REMATCH[7]}" \
          '[.[] | select(.repo==$r and .kind==$k and (.labels|index($l))
              and ((.state // "OPEN") == "OPEN" or ($st != "OPEN" and .state == "MERGED")))]
            | sort_by(.createdAt) | (if $dir == "DESC" then reverse else . end) | .[:$first]
            | map({number, baseRefName: (.base // "beta"), body: (.body // ""), comments: {nodes: [.comments[] | {body: .}]}})' "$S")
        out=$(jq -c --arg r "$r" --arg s "$s" --argjson n "$nodes" '.[$r][$s] = {nodes: $n}' <<<"$out")
      fi
    done <<<"$query"
    jq -c '{data: .}' <<<"$out" | jq -r "$q" ;;
  "api repos/"*"/issues/"*) # team-shift's dependency lookup: an issue or a PR by number
    [[ -e $FAKE/api-fails ]] && { echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1; }
    r=$(cut -d/ -f2,3 <<<"$sub") num=${sub##*/}
    it=$(jq -c --arg r "$r" --argjson n "$num" '.[] | select(.repo==$r and .number==$n)' "$S")
    [[ -n $it ]] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    jq -c '{number, state: (if (.state // "OPEN") == "OPEN" then "open" else "closed" end), labels: [.labels[] | {name: .}]} +
      (if .kind=="pr" then {pull_request: {}} else {} end)' <<<"$it" | jq -r "$q" ;;
  "api "*) [[ -f $FAKE/has-beta ]] ;;
  "repo view") echo main ;;
  *) echo "fake gh: unhandled $kind $sub" >&2; exit 9 ;;
esac
