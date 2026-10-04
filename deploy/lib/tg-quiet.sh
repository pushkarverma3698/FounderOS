#!/usr/bin/env bash
# Shared Telegram quiet hours helper — deploy/lib/tg-quiet.sh

tg_is_quiet() {
  local range="${TG_QUIET_HOURS:-23-08}"
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

tg_hold() {
  local text="${1:-}"
  local queue_dir="${HOME}/.claude"
  local queue_file="${queue_dir}/tg-digest.queue"
  mkdir -p "$queue_dir"

  local utc_time
  utc_time="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  local daemon_name="${TG_DAEMON_NAME:-$(basename "$0" 2>/dev/null || echo "daemon")}"

  local first_line
  first_line="$(printf '%s' "$text" | head -n1 | tr -s '[:space:]' ' ' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  first_line="${first_line:0:300}"

  printf '%s\t%s\t%s\n' "$utc_time" "$daemon_name" "$first_line" >>"$queue_file"
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

  curl -s -o /dev/null --max-time 20 \
    "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat}" \
    --data-urlencode "text=$1" \
    --data "disable_web_page_preview=true"
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
