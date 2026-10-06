# evidence-card.sh - what pr-brain does with a reviewed PR when AGENT_PIPELINE_V2=1.
# Sourced by deploy/vps-daemons/pr-brain, never executed.
#
# A PR that has an approved contract (the issue's record in the contracts dir) is NOT merged by pr-brain: it is judged
# by scripts/pipeline-evidence-card.ts (spec red, implementation green, review, canMerge), and the founder gets an
# evidence card whose [Merge] button is the only thing that merges it. Every judgement is made in that script; this file
# runs it, sends what it prints, and decides ONE thing: legacy | carded | held.
#
#   legacy  flag off, not a task/issue-N PR, an employer repo, or no contract for the issue: pr-brain behaves as before
#   carded  the card reached Telegram: pr-brain must not merge
#   held    a contract exists but no card could be built or sent: pr-brain must not merge, and says why in EC_NOTE
#
# The card is a decision, so it is sent during quiet hours too, without a sound (disable_notification).
#
# NEEDS FROM THE SOURCING SCRIPT: log, tg_is_quiet, ENV_FILE, repo_owner, repo_name, jq.

EC_ROOT="${PR_BRAIN_PIPELINE_ROOT:-/opt/founderos}"
EC_NODE="${PR_BRAIN_NODE:-node}"
# The one repo owner whose PRs a human always merges (the OplifyMessage carve-out in merge_cleared).
EC_HUMAN_MERGE_OWNER="OplifyMessage"
EC_STATE="legacy"
EC_NOTE=""

ec_enabled() { [[ "${AGENT_PIPELINE_V2:-}" == "1" ]]; }

# ec_ts ARGS... - scripts/pipeline-evidence-card.ts; prints its one JSON line.
ec_ts() {
  ( cd "$EC_ROOT" && "$EC_NODE" --import tsx/esm scripts/pipeline-evidence-card.ts "$@" )
}

# ec_issue_of HEAD_REF - the issue number of task/issue-N or task/issue-N-slug; prints nothing for any other branch.
ec_issue_of() {
  local rest="${1#task/issue-}"
  [[ "$1" == task/issue-* ]] || return 0
  rest="${rest%%-*}"
  [[ "$rest" =~ ^[1-9][0-9]*$ ]] && printf '%s' "$rest"
  return 0
}

# ec_send PARTS_JSON MARKUP_JSON - 0 only when Telegram accepted every part. The keyboard goes on the last part.
ec_send() {
  local parts="$1" markup="$2" token chat count i part resp mid quiet=""
  [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]] || return 1
  token=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"'\r')
  chat=$(grep -m1 '^TELEGRAM_CHAT_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"'\r')
  [[ -n "$token" && -n "$chat" ]] || return 1
  count="$(jq -r 'length' <<<"$parts" 2>/dev/null)"
  [[ "$count" =~ ^[0-9]+$ && "$count" -ge 1 ]] || return 1
  tg_is_quiet && quiet="true"
  for (( i = 0; i < count; i++ )); do
    part="$(jq -r --argjson i "$i" '.[$i]' <<<"$parts")"
    local args=(--data-urlencode "chat_id=${chat}" --data-urlencode "text=${part}" --data "parse_mode=HTML" --data "disable_web_page_preview=true")
    [[ -z "$quiet" ]] || args+=(--data "disable_notification=true")
    [[ "$i" -eq $(( count - 1 )) ]] && args+=(--data-urlencode "reply_markup=${markup}")
    resp="$(curl -sf --max-time 20 "https://api.telegram.org/bot${token}/sendMessage" "${args[@]}" 2>/dev/null)" || return 1
    mid="$(jq -r 'if .ok == true then (.result.message_id // "") else "" end' <<<"$resp" 2>/dev/null)"
    [[ -n "$mid" ]] || return 1
    declare -F tg_screen_log >/dev/null && tg_screen_log "$part" "$chat" "$mid"
  done
  return 0
}

# ec_run PR HEAD HEAD_REF VERDICT - sets EC_STATE and EC_NOTE. Never aborts the sweep.
ec_run() {
  local pr="$1" head="$2" head_ref="$3" verdict="$4" issue out status
  EC_STATE="legacy"; EC_NOTE=""
  ec_enabled || return 0
  [[ "$repo_owner" != "$EC_HUMAN_MERGE_OWNER" ]] || return 0
  issue="$(ec_issue_of "$head_ref")"
  [[ -n "$issue" ]] || return 0
  out="$(ec_ts --repo "${repo_owner}/${repo_name}" --issue "$issue" --pr "$pr" --head "$head" --verdict "$verdict" 2>>"$LOG")"
  status="$(jq -r '.status // empty' <<<"$out" 2>/dev/null | tail -n 1)"
  case "$status" in
    NONE|DISABLED) return 0 ;;
    CARD)
      if ec_send "$(jq -c '.parts' <<<"$out")" "$(jq -c '.reply_markup' <<<"$out")"; then
        EC_STATE="carded"
        log "$repo_name#$pr evidence card sent (mergeable=$(jq -r '.mergeable' <<<"$out"))"
      else
        EC_STATE="held"; EC_NOTE="the evidence card could not be sent to Telegram, so nothing may be merged; run pr-brain --pr ${pr} --repo /opt/review/${repo_name} to try again"
      fi
      ;;
    INVALID|FAILED)
      EC_STATE="held"; EC_NOTE="no evidence card: $(jq -r '.error // "no reason given"' <<<"$out" 2>/dev/null)"
      ;;
    *)
      EC_STATE="held"; EC_NOTE="the evidence step printed nothing readable (see ${LOG}), so nothing may be merged"
      ;;
  esac
  [[ "$EC_STATE" != "held" ]] || log "$repo_name#$pr merge held: $EC_NOTE"
  return 0
}
