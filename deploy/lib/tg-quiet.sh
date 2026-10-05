#!/usr/bin/env bash
# Shared Telegram quiet hours helper — deploy/lib/tg-quiet.sh

tg_is_quiet() {
  local range="${TG_QUIET_HOURS:-23-08}"
  # A malformed value must never abort the daemon with an arithmetic error: treat it as "not quiet".
  [[ "$range" =~ ^[0-9]{1,2}-[0-9]{1,2}$ ]] || return 1
  local start_str="${range%%-*}"
  local end_str="${range##*-}"
  local start=$(( 10#${start_str:-23} ))
  local end=$(( 10#${end_str:-8} ))

  local curr_hour
  if [[ -n "${TG_QUIET_NOW:-}" ]]; then
    curr_hour=$(( 10#$TG_QUIET_NOW ))
  else
    curr_hour=$(( 10#$(TZ=Asia/Kolkata date '+%H' 2>/dev/null || date '+%H') ))
  fi

  if (( start > end )); then
    if (( curr_hour >= start || curr_hour < end )); then
      return 0
    else
      return 1
    fi
  else
    if (( curr_hour >= start && curr_hour < end )); then
      return 0
    else
      return 1
    fi
  fi
}

# Failures, pauses and give-ups are sent at any hour: holding them overnight hides the
# reason the loop stopped until morning. Only routine progress waits for the digest.
tg_is_urgent() {
  local first
  first="$(printf '%s' "${1:-}" | head -n1)"
  [[ "$first" == "🛑"* || "$first" == "⚠️"* || "$first" == "❌"* || "$first" == "⏸"* ]] && return 0
  printf '%s' "$first" | grep -qiE 'failed|paused|gave up|down\b' && return 0
  return 1
}

# True (0) when this message should go to the digest instead of being sent now.
tg_should_hold() {
  tg_is_quiet && ! tg_is_urgent "${1:-}"
}

tg_hold() {
  local text="${1:-}"
  local queue_dir="${HOME}/.claude"
  local queue_file="${queue_dir}/tg-digest.queue"
  mkdir -p "$queue_dir"

  local utc_time
  utc_time="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  local daemon_name="${TG_DAEMON_NAME:-$(basename "$0" 2>/dev/null || echo "daemon")}"

  # First three non-empty lines: an event's verdict and URL sit on lines 2-3 and the digest
  # must still say what happened (a reason is printed with its result).
  local first_line
  first_line="$(printf '%s' "$text" | awk 'NF { gsub(/^[ \t]+|[ \t]+$/, ""); gsub(/[ \t]+/, " "); out = out (n++ ? " · " : "") $0; if (n == 3) exit } END { print out }')"
  first_line="${first_line:0:500}"

  printf '%s\t%s\t%s\n' "$utc_time" "$daemon_name" "$first_line" >>"$queue_file"
}

# tg_screen_log TEXT CHAT [MESSAGE_ID] — record a message the founder now sees, after the send
# succeeded, in the screen log the bot's planner reads (src/infra/screen-log.ts has the format).
# Without it, "which repo is that on?" about a daemon alert is a guess (2026-10-04). Best-effort:
# always returns 0 and prints nothing, so a send's stdout (agy_tg_send's message id) stays clean.
tg_screen_log() {
  local text="${1:-}" chat="${2:-}" mid="${3:-}"
  [[ -n "$text" && -n "$chat" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  local file="${FOUNDEROS_SCREEN_LOG:-${HOME}/.claude/screen.jsonl}"
  mkdir -p "$(dirname "$file")" 2>/dev/null || return 0
  local size=""
  [[ -f "$file" ]] && size="$(wc -c <"$file" 2>/dev/null | tr -d ' ' || true)"
  # Same cap as SCREEN_LOG_MAX_BYTES in src/infra/screen-log.ts.
  if [[ "$size" =~ ^[0-9]+$ ]] && (( size > 1048576 )); then
    mv -f "$file" "$file.1" 2>/dev/null || true
  fi
  local src="${TG_DAEMON_NAME:-$(basename "$0" 2>/dev/null || echo daemon)}"
  ( umask 077
    jq -cn --arg chat "$chat" --arg src "$src" --arg text "$text" --arg mid "$mid" \
      '{ts: (now | todate), chat: $chat, src: $src, text: ($text | .[0:4000])}
       + (if ($mid | test("^[0-9]+$")) then {mid: ($mid | tonumber)} else {} end)' >>"$file"
  ) 2>/dev/null || true
  return 0
}

_tg_send_raw() {
  if declare -f notify_raw >/dev/null 2>&1; then
    notify_raw "$1"
    return $?
  fi

  local env_file="${ENV_FILE:-${PR_BRAIN_ENV_FILE:-${AGENT_DISPATCH_ENV_FILE:-}}}"
  [[ -n "$env_file" && -f "$env_file" ]] || return 1
  local token chat
  token=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$env_file" | cut -d= -f2- | tr -d '"'"'"'\r')
  chat=$(grep -m1 '^TELEGRAM_CHAT_ID=' "$env_file" | cut -d= -f2- | tr -d '"'"'"'\r')
  [[ -n "$token" && -n "$chat" ]] || return 1

  # -f: an HTTP 4xx/429 is a failed send, so the queue is kept instead of deleted.
  curl -sf -o /dev/null --max-time 20 \
    "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat}" \
    --data-urlencode "text=$1" \
    --data "disable_web_page_preview=true" || return $?
  tg_screen_log "$1" "$chat"
}

tg_flush_digest() {
  tg_is_quiet && return 0

  local queue_dir="${HOME}/.claude"
  local queue_file="${queue_dir}/tg-digest.queue"
  [[ -f "$queue_file" && -s "$queue_file" ]] || return 0

  local tmp_file="${queue_dir}/tg-digest.tmp.$$.${RANDOM}"
  mv "$queue_file" "$tmp_file" 2>/dev/null || return 0
  [[ -s "$tmp_file" ]] || { rm -f "$tmp_file"; return 0; }

  local max_len="${TELEGRAM_MAX:-3800}"
  local total_events=0
  local line utc_time daemon msg ist_time

  local keys=()
  local counts=()
  local ist_times=()
  local msgs=()

  while IFS=$'\t' read -r utc_time daemon msg || [[ -n "$utc_time" ]]; do
    [[ -n "$utc_time" ]] || continue
    total_events=$((total_events + 1))
    ist_time="$(TZ=Asia/Kolkata date -d "$utc_time" '+%H:%M' 2>/dev/null || echo "00:00")"

    local found=-1
    local idx=0
    for k in "${keys[@]}"; do
      if [[ "$k" == "${daemon}"$'\t'"${msg}" ]]; then
        found=$idx
        break
      fi
      idx=$((idx + 1))
    done

    if [[ "$found" -ge 0 ]]; then
      counts[$found]=$(( counts[found] + 1 ))
    else
      keys+=("${daemon}"$'\t'"${msg}")
      counts+=(1)
      ist_times+=("$ist_time")
      msgs+=("$msg")
    fi
  done <"$tmp_file"

  if [[ "$total_events" -eq 0 ]]; then
    rm -f "$tmp_file"
    return 0
  fi

  local header="🌅 Overnight digest (${total_events} events)"
  local digest_body="$header"
  local num_keys=${#keys[@]}
  local send_err=0

  for (( i=0; i<num_keys; i++ )); do
    local entry="${ist_times[i]} ${msgs[i]}"
    if (( counts[i] > 1 )); then
      entry+=" ×${counts[i]}"
    fi

    if [[ -n "$digest_body" && $(( ${#digest_body} + ${#entry} + 1 )) -gt "$max_len" ]]; then
      if ! _tg_send_raw "$digest_body"; then
        send_err=1
        break
      fi
      digest_body="$entry"
    else
      digest_body+=$'\n'"$entry"
    fi
  done

  if [[ "$send_err" -eq 0 && -n "$digest_body" ]]; then
    if ! _tg_send_raw "$digest_body"; then
      send_err=1
    fi
  fi

  if [[ "$send_err" -ne 0 ]]; then
    cat "$tmp_file" >>"$queue_file"
    rm -f "$tmp_file"
    return 1
  fi

  rm -f "$tmp_file"
  return 0
}
