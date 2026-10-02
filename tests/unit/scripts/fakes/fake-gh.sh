#!/usr/bin/env bash
# A stateful stand-in for the `gh` CLI, for the agent-dispatch tests.
#
# The daemon drives GitHub through `gh` only, so this is the whole of "GitHub" in
# those tests: issues with labels and comments, pull requests and a repository's label
# list, all kept in the JSON file GH_STATE points at. Because it is stateful, a test can
# run several ticks and watch a label move, a comment land or a marker count up, instead
# of asserting on canned output.
#
# It mimics the two gh behaviours the daemon's correctness leans on:
#   - `gh issue edit --add-label X` fails, and changes NOTHING, when X does not exist in
#     the repository (what a repo that was never onboarded looks like);
#   - `--jq` is applied to the JSON that `--json` selected, exactly as gh does it.
#
# Every call is appended to GH_CALLS (newlines in arguments shown as \n) so a test can
# assert on what was sent. None of it touches the network. jq is a hard requirement of
# the daemon itself, so using it here adds nothing new.

set -u
STATE="${GH_STATE:?GH_STATE is not set}"
ARGS=("$@")

line=""
for a in "$@"; do
  a="${a//$'\n'/\\n}"
  line+="${line:+ }$a"
done
[ -n "${GH_CALLS:-}" ] && printf '%s\n' "$line" >>"$GH_CALLS"

die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

# flag NAME: the value after the first NAME in the arguments (non-zero when absent).
flag() {
  local n="$1" i
  for ((i = 0; i < ${#ARGS[@]}; i++)); do
    if [ "${ARGS[$i]}" = "$n" ]; then printf '%s' "${ARGS[$((i + 1))]-}"; return 0; fi
  done
  return 1
}
# flags NAME: every value after every NAME, one per line.
flags() {
  local n="$1" i
  for ((i = 0; i < ${#ARGS[@]}; i++)); do
    [ "${ARGS[$i]}" = "$n" ] && printf '%s\n' "${ARGS[$((i + 1))]-}"
  done
  return 0
}

repo=$(flag --repo) || repo=$(flag -R) || repo="${GH_DEFAULT_REPO:-}"
group="${ARGS[0]:-}"
sub="${ARGS[1]:-}"
num="${ARGS[2]:-}"

# The JSON array of the requested --json fields, and a jq filter that keeps only those.
fields=$(flag --json 2>/dev/null | jq -R 'split(",") | map(select(. != ""))')
[ -n "$fields" ] || fields='[]'
PICK='with_entries(select(.key as $k | $f | index($k)))'

need_repo() {
  jq -e --arg r "$repo" '.repos[$r]' "$STATE" >/dev/null 2>&1 \
    || die "GraphQL: Could not resolve to a Repository with the name '$repo'."
}
need_issue() {
  jq -e --arg r "$repo" --arg n "$1" '.repos[$r].issues[$n]' "$STATE" >/dev/null 2>&1 \
    || die "GraphQL: Could not resolve to an issue or pull request with the number of $1."
}
mutate() {
  local tmp
  tmp=$(mktemp "${STATE}.XXXXXX") && jq "$@" "$STATE" >"$tmp" && mv "$tmp" "$STATE"
}
# Print JSON from stdin: through the --jq expression when given (as gh does), else compact.
emit() {
  local e
  if e=$(flag --jq); then jq -r "$e"; else jq -c .; fi
}
json_lines_to_array() { jq -R . | jq -s .; }

case "$group $sub" in
  "auth status")
    jq -e '.authOk != false' "$STATE" >/dev/null 2>&1 \
      || die "You are not logged into any GitHub hosts. To log in, run: gh auth login"
    ;;

  "issue list")
    need_repo
    want=$(flags --label | json_lines_to_array)
    jq -c --arg r "$repo" --argjson want "$want" --argjson f "$fields" '
      [ .repos[$r].issues | to_entries[]
        | select(.value.state != "closed")
        | select(.value.labels as $l | $want | all(. as $w | $l | index($w)))
        | .key as $n | .value as $i
        | {number: ($n | tonumber), title: $i.title, body: $i.body,
           labels: [$i.labels[] | {name: .}], state: "OPEN"}
        | '"$PICK"' ]' "$STATE" | emit
    ;;

  "issue view")
    need_repo; need_issue "$num"
    jq -c --arg r "$repo" --arg n "$num" --argjson f "$fields" '
      .repos[$r].issues[$n] as $i
      | {number: ($n | tonumber), title: $i.title, body: $i.body,
         state: (if $i.state == "closed" then "CLOSED" else "OPEN" end),
         labels: [$i.labels[] | {name: .}], comments: [$i.comments[] | {body: .body}],
         url: ("https://github.com/" + $r + "/issues/" + $n)}
      | '"$PICK" "$STATE" | emit
    ;;

  "issue edit")
    need_repo; need_issue "$num"
    [ "$(jq -r '.failIssueEdit // false' "$STATE")" = true ] \
      && die "HTTP 502: Bad Gateway (https://api.github.com/graphql)"
    add=$(flags --add-label | tr ',' '\n' | json_lines_to_array)
    rem=$(flags --remove-label | tr ',' '\n' | json_lines_to_array)
    missing=$(jq -r --arg r "$repo" --argjson add "$add" \
      '.repos[$r].labels as $have | $add[] | select(. != "") | select(. as $a | $have | index($a) | not)' "$STATE" | head -n1)
    [ -z "$missing" ] || die "failed to update $repo#$num: '$missing' not found"
    mutate --arg r "$repo" --arg n "$num" --argjson add "$add" --argjson rem "$rem" \
      '.repos[$r].issues[$n].labels |= ((. - $rem) as $kept | $kept + (($add - [""]) - $kept))'
    ;;

  "issue comment")
    need_repo; need_issue "$num"
    body=$(flag --body) || body=""
    mutate --arg r "$repo" --arg n "$num" --arg b "$body" '.repos[$r].issues[$n].comments += [{body: $b}]'
    ;;

  "issue close")
    need_repo; need_issue "$num"
    mutate --arg r "$repo" --arg n "$num" '.repos[$r].issues[$n].state = "closed"'
    ;;

  "pr list")
    need_repo
    head=$(flag --head) || head=""
    jq -c --arg r "$repo" --arg h "$head" --argjson f "$fields" '
      [ .repos[$r].prs[] | select((.state // "OPEN") == "OPEN") | select($h == "" or .headRefName == $h)
        | {number, headRefName, headRefOid: (.headRefOid // "0000000000000000000000000000000000000000"),
           isDraft: (.isDraft != false), baseRefName: (.baseRefName // "main"),
           comments: [(.comments // [])[] | {body: .body}],
           url: ("https://github.com/" + $r + "/pull/" + (.number | tostring)), state: (.state // "OPEN")}
        | '"$PICK"' ]' "$STATE" | emit
    ;;

  "pr view")
    need_repo
    jq -e --arg r "$repo" --arg n "$num" '.repos[$r].prs[] | select((.number | tostring) == $n)' "$STATE" >/dev/null 2>&1 \
      || die "no pull requests found with number $num"
    jq -c --arg r "$repo" --arg n "$num" --argjson f "$fields" '
      .repos[$r].prs[] | select((.number | tostring) == $n)
      | {number, headRefName, headRefOid: (.headRefOid // "0000000000000000000000000000000000000000"),
         isDraft: (.isDraft != false), baseRefName: (.baseRefName // "main"),
         comments: [(.comments // [])[] | {body: .body}],
         url: ("https://github.com/" + $r + "/pull/" + (.number | tostring)), state: (.state // "OPEN")}
      | '"$PICK" "$STATE" | emit
    ;;

  "pr checks") echo '[]' | emit ;;

  "pr comment")
    need_repo
    body=$(flag --body) || body=""
    mutate --arg r "$repo" --arg n "$num" --arg b "$body" \
      '(.repos[$r].prs[] | select((.number | tostring) == $n) | .comments) |= ((. // []) + [{body: $b}])'
    ;;

  "pr create")
    need_repo
    number=$(jq -r --arg r "$repo" '100 + (.repos[$r].prs | length)' "$STATE")
    mutate --arg r "$repo" --arg h "$(flag --head)" --argjson n "$number" \
      '.repos[$r].prs += [{number: $n, headRefName: $h, isDraft: true, comments: []}]'
    printf 'https://github.com/%s/pull/%s\n' "$repo" "$number"
    ;;

  "label list")
    need_repo
    [ "$(jq -r '.failLabelList // false' "$STATE")" = true ] \
      && die "HTTP 502: Bad Gateway (https://api.github.com/repos/labels)"
    jq -c --arg r "$repo" '[.repos[$r].labels[] | {name: .}]' "$STATE" | emit
    ;;

  "label create")
    need_repo
    mutate --arg r "$repo" --arg l "$num" '.repos[$r].labels |= (if index($l) then . else . + [$l] end)'
    ;;

  "api user") echo owner ;;

  # gh api repos/<owner>/<name>/branches/<branch>: a repo has the branches in its state's `branches`
  # list (default: just main). A missing one is gh's real 404 text, which the daemon tells apart from
  # an API outage.
  "api repos/"*)
    [ "$(jq -r '.failApi // false' "$STATE")" = true ] && die "HTTP 502: Bad Gateway (https://api.github.com/repos)"
    slug="${sub#repos/}"; slug="${slug%%/branches/*}"; branch="${sub##*/branches/}"
    if jq -e --arg r "$slug" --arg b "$branch" '(.repos[$r].branches // ["main"]) | index($b)' "$STATE" >/dev/null 2>&1; then
      printf '{"name":"%s"}\n' "$branch"
    else
      die "gh: Not Found (HTTP 404)"
    fi
    ;;

  *) : ;;   # anything else (gh repo clone, pr edit, …) succeeds silently
esac
exit 0
