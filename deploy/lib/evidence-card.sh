# evidence-card.sh - what pr-brain does with a reviewed job PR (branch task/issue-N).
# Sourced by deploy/vps-daemons/pr-brain, never executed.
#
# pr-brain never merges a job PR. A cleared one is judged by scripts/pipeline-evidence-card.ts (required CI, review,
# canMerge for this head) and the founder gets a merge card whose [Merge] button is the only thing that merges it.
# Every judgement is made in that script; this file runs it, sends what it prints, and decides ONE thing:
#
#   legacy  not a task/issue-N PR, or the OplifyMessage carve-out (a human merges there): pr-brain behaves as before
#   none    a job PR whose review did not clear: no card, no merge
#   carded  the card reached Telegram: pr-brain must not merge
#   held    no card could be built or sent: pr-brain must not merge, and says why in EC_NOTE
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
  [[ "$repo_owner" != "$EC_HUMAN_MERGE_OWNER" ]] || return 0
  issue="$(ec_issue_of "$head_ref")"
  [[ -n "$issue" ]] || return 0
  out="$(ec_ts --repo "${repo_owner}/${repo_name}" --issue "$issue" --pr "$pr" --head "$head" --verdict "$verdict" 2>>"$LOG")"
  status="$(jq -r '.status // empty' <<<"$out" 2>/dev/null | tail -n 1)"
  case "$status" in
    NONE)
      EC_STATE="none"
      log "$repo_name#$pr no merge card: $(jq -r '.reason // "no reason given"' <<<"$out" 2>/dev/null)"
      ;;
    CARD)
      if ec_send "$(jq -c '.parts' <<<"$out")" "$(jq -c '.reply_markup' <<<"$out")"; then
        EC_STATE="carded"
        log "$repo_name#$pr merge card sent (mergeable=$(jq -r '.mergeable' <<<"$out"))"
      else
        EC_STATE="held"; EC_NOTE="the merge card could not be sent to Telegram, so nothing may be merged; run pr-brain --pr ${pr} --repo /opt/review/${repo_name} to try again"
      fi
      ;;
    INVALID|FAILED)
      EC_STATE="held"; EC_NOTE="no merge card: $(jq -r '.error // "no reason given"' <<<"$out" 2>/dev/null)"
      ;;
    *)
      EC_STATE="held"; EC_NOTE="the merge-card step printed nothing readable (see ${LOG}), so nothing may be merged"
      ;;
  esac
  [[ "$EC_STATE" != "held" ]] || log "$repo_name#$pr merge held: $EC_NOTE"
  return 0
}

# ---------------------------------------------------------------------------------------------------------------------
# The blocked-PR card. A PR pr-brain blocked is blocked on every path, and the founder needs the reasons and a way to act on them from the phone (Oplify PR #116, 2026-10-09: he got
# "CHANGES REQUESTED — blocked" and nothing else). scripts/blocked-review-card.ts decides whether there is a card (a
# REQUEST_CHANGES verdict with a blocker for exactly this head, on an open draft PR), writes the record the [Fix now] and
# [Close PR] buttons point at, and prints one JSON line; this sends it.
# ---------------------------------------------------------------------------------------------------------------------
BC_SENT=0

bc_ts() {
  ( cd "$EC_ROOT" && "$EC_NODE" --import tsx/esm scripts/blocked-review-card.ts "$@" )
}

# bc_run PR HEAD VERDICT - sets BC_SENT=1 only when the card reached Telegram. Never aborts the sweep; on any
# problem it logs why and leaves BC_SENT=0, so the caller sends its plain message instead.
bc_run() {
  local pr="$1" head="$2" verdict="$3" out status
  BC_SENT=0
  case "$verdict" in
    CLEARED*|APPROVED*) return 0 ;;
  esac
  out="$(bc_ts --repo "${repo_owner}/${repo_name}" --pr "$pr" --head "$head" 2>>"$LOG")"
  status="$(jq -r '.status // empty' <<<"$out" 2>/dev/null | tail -n 1)"
  case "$status" in
    CARD)
      if ec_send "$(jq -c '.parts' <<<"$out")" "$(jq -c '.reply_markup' <<<"$out")"; then
        BC_SENT=1
        log "$repo_name#$pr blocked card sent"
      else
        log "$repo_name#$pr blocked card could not be sent to Telegram; sending the plain message"
      fi
      ;;
    NONE) log "$repo_name#$pr no blocked card: $(jq -r '.reason // "no reason given"' <<<"$out" 2>/dev/null)" ;;
    *) log "$repo_name#$pr blocked card step failed: $(jq -r '.error // "printed nothing readable"' <<<"$out" 2>/dev/null)" ;;
  esac
  return 0
}
