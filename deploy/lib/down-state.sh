# shellcheck shell=bash
#
# down-state.sh — the pause/resume state machine shared by the VPS daemons
# (deploy/agent-dispatch and deploy/vps-daemons/pr-brain). SOURCED, never run.
#
# Why it exists: an unattended loop that stops and tells nobody is
# indistinguishable from an idle one. pr-brain had this (2026-09-26/27: a weekly
# usage limit produced 72 "Gate FAILED" messages a day, one per tick, until the
# outage became ONE message going down and ONE coming back). agent-dispatch had
# nothing: a login that expired was logged every 15 minutes and marked the issue
# agent:failed. One copy of the transitions, pinned by
# tests/unit/scripts/down-state.test.ts, serves both.
#
# Contract with the sourcing script (set/define BEFORE calling anything here):
#   DOWN_FILE   the state file, e.g. ~/.claude/agent-dispatch.down
#   log()       appends one line to the daemon's log
#   notify()    sends ONE Telegram message; it must swallow its own failures
#
# State file:  line 1 = class (auth, limit, gh-auth …)   line 2 = "YYYY-MM-DD HH:MM UTC"
#              line 3 = opaque extra (agent-dispatch keeps the key file's mtime there)
# ${DOWN_FILE}.notified says "the paused message went out". It is what lets a
# founder who simply deletes the file still get the one "resumed" message.
#
# Where the sourcing script finds this file: ../lib or ./lib next to its OWN real
# path (readlink -f), because the repo keeps the daemons in two directories
# (deploy/ and deploy/vps-daemons/) but the VPS has them side by side in ~/bin.
# deploy/sync-daemons.sh ships lib/*.sh with the daemons and tests/unit/scripts/
# sync-daemons.test.ts fails when a sourced file is not in the copy list.

# Exact secret values the sourcing script knows (the Gemini key, the Telegram bot
# token, the Claude token). Masked verbatim, whatever shape they have. Values
# shorter than 8 characters are ignored: masking "short" would mangle messages.
REDACT_LITERALS=()

down_active() { [[ -f "$DOWN_FILE" ]]; }
down_class() { { [[ -f "$DOWN_FILE" ]] && sed -n 1p "$DOWN_FILE"; } || return 0; }
down_since() { { [[ -f "$DOWN_FILE" ]] && sed -n 2p "$DOWN_FILE"; } || return 0; }
down_extra() { { [[ -f "$DOWN_FILE" ]] && sed -n 3p "$DOWN_FILE"; } || return 0; }

# down_enter CLASS DETAIL MESSAGE [EXTRA]
# Records the pause and sends MESSAGE — but only when the CLASS CHANGED. The same
# class again is silent: one message per transition, never one per tick.
down_enter() {
  local cls="$1" detail="$2" msg="$3" extra="${4:-}" prev=""
  down_active && prev=$(sed -n 1p "$DOWN_FILE")
  [[ "$prev" == "$cls" ]] && return 0
  mkdir -p "$(dirname "$DOWN_FILE")" 2>/dev/null
  if ! printf '%s\n%s\n%s\n' "$cls" "$(date -u '+%Y-%m-%d %H:%M UTC')" "$extra" >"$DOWN_FILE" 2>/dev/null; then
    log "could not record the paused state in $DOWN_FILE ($cls) — NOT announcing it: an unrecorded pause would repeat on every tick"
    return 0
  fi
  log "paused ($cls): $(printf '%s' "$detail" | redact_secrets)"
  : >"${DOWN_FILE}.notified" 2>/dev/null
  notify "$(printf '%s' "$msg" | redact_secrets)" || true
  return 0
}

# down_leave MESSAGE — clears the pause and sends MESSAGE once. Silent when there
# is nothing to clear, so a healthy tick can call it unconditionally.
down_leave() {
  down_active || return 0
  rm -f "$DOWN_FILE" "${DOWN_FILE}.notified"
  notify "$(printf '%s' "$1" | redact_secrets)" || true
  return 0
}

# down_reap_removed MESSAGE — the founder deleted the state file by hand. Send the
# one "resumed" message that down_leave would have sent, then forget.
down_reap_removed() {
  [[ ! -f "$DOWN_FILE" && -f "${DOWN_FILE}.notified" ]] || return 0
  rm -f "${DOWN_FILE}.notified"
  notify "$(printf '%s' "$1" | redact_secrets)" || true
  return 0
}

# ------------------------------------------------------------------ redaction
# redact_secrets: stdin -> stdout. EVERYTHING that leaves the box (Telegram, a
# GitHub comment) or is appended to a log passes through here first: the first
# matching line of a failed run is quoted to the founder, and that line can hold
# the key that was just rejected (an error URL with ?key=…).
#
# The known literals are masked in the shell itself: a secret handed to sed or awk
# as an argument sits in /proc/<pid>/cmdline for as long as the process runs.
_REDACT_SED=$(cat <<'SED_RULES'
s/AIza[0-9A-Za-z_-]{20,}/[REDACTED]/g
s/(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/\1[REDACTED]/g
s/(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/[REDACTED]/g
s/xox[abposr]-[A-Za-z0-9-]{10,}/[REDACTED]/g
s/[0-9]{6,}:[A-Za-z0-9_-]{30,}/[REDACTED]/g
s/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/[REDACTED]/g
s#([Bb]earer|[Bb]asic)[[:space:]]+[A-Za-z0-9._~+/=-]{8,}#\1 [REDACTED]#g
s/([A-Za-z_]*([Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww]([Oo][Rr])?[Dd])["']?[[:space:]]*[:=][[:space:]]*["']?)[^[:space:]"'&,;)]{6,}/\1[REDACTED]/g
SED_RULES
)

# The generic rule: any other run of 32+ token characters is masked, EXCEPT a
# lower-case kebab-case or snake_case identifier (a long branch name or file name).
# Masking those would make every quoted log tail useless to the founder, and no
# random token is lower-case with two hyphens or underscores.
_REDACT_AWK=$(cat <<'AWK_RULES'
function secretish(t,   c, hy, un, up) {
  if (length(t) < 32) return 0
  c = t; hy = gsub(/-/, "", c)
  c = t; un = gsub(/_/, "", c)
  c = t; up = gsub(/[A-Z]/, "", c)
  if (up == 0 && (hy >= 2 || un >= 2)) return 0
  return 1
}
{
  out = ""; rest = $0
  while (match(rest, /[A-Za-z0-9_-]+/)) {
    tok = substr(rest, RSTART, RLENGTH)
    out = out substr(rest, 1, RSTART - 1) (secretish(tok) ? "[REDACTED]" : tok)
    rest = substr(rest, RSTART + RLENGTH)
  }
  print out rest
}
AWK_RULES
)

redact_secrets() {
  local text lit
  text=$(tr -d '\000') || text=""
  for lit in ${REDACT_LITERALS[@]+"${REDACT_LITERALS[@]}"}; do
    [[ "${#lit}" -ge 8 ]] || continue
    text="${text//"$lit"/[REDACTED]}"
  done
  printf '%s\n' "$text" | sed -E -e "$_REDACT_SED" | awk "$_REDACT_AWK"
}
