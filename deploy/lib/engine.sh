# shellcheck shell=bash
#
# engine.sh — which coding CLI runs a task, and is that CLI allowed to start work right now?
# SOURCED by deploy/agent-dispatch after claude-run.sh (it reads claude_token_file from there). Needs from the sourcing
# script: log, file_mtime, redact_secrets, and DRY_RUN (0 or 1).
#
# WHICH CLI
#   1. the issue's engine:agy / engine:claude label, when it carries exactly one of them;
#   2. else the default in ~/.claude/coding-engine: one word, written by the bot's /engine command, read here;
#   3. else agy. A file that is missing, empty or holds any other word means agy: a typo must not send work to a CLI
#      nobody picked. An agent:review issue with no label predates the switch, so the caller passes agy as the fallback.
#   Both labels on one issue is ambiguous and falls through to 2: the daemon does not guess which one the founder meant.
#
# WHEN
#   Each CLI has its own wall, so one CLI's trouble never stops the other.
#   agy    agent-dispatch.down (a rejected login) and agent-dispatch.quota-until: both owned by agent-dispatch itself.
#   claude agent-dispatch.claude-blocked, owned here. Three lines:  CLASS / EXTRA / WHAT CLAUDE SAID (redacted).
#            quota  EXTRA is the epoch the limit lifts. Blocks until then; the file removes itself afterwards.
#            auth   EXTRA is the token file's mtime from BEFORE the run that was refused (0 when the file did not exist).
#                   Blocks until the file's mtime is anything else: the founder pasted a new token and it is tried at once.
#                   A token pasted while the failing run was still going has a newer mtime than the one recorded, so it
#                   is not missed.
#
# Only two engines exist. Adding a third is one more lib like claude-run.sh, one more arm in each case below, and one more
# label in deploy/onboard-repo.sh (tests/unit/scripts/onboard-repo.test.ts fails while the two lists differ).

CODING_ENGINE_FILE="$HOME/.claude/coding-engine"
CLAUDE_BLOCK_FILE="$HOME/.claude/agent-dispatch.claude-blocked"

# engine_default — the engine an unlabelled issue goes to: claude or agy.
engine_default() {
  local word=""
  if [[ -f "$CODING_ENGINE_FILE" ]]; then
    IFS= read -r word <"$CODING_ENGINE_FILE" 2>/dev/null || true
  fi
  word="${word//[[:space:]]/}"
  case "$word" in
    claude) printf 'claude' ;;
    *) printf 'agy' ;;
  esac
}

# engine_display ENGINE — the name the founder reads.
engine_display() {
  case "$1" in
    claude) printf 'Claude Code' ;;
    *) printf 'Antigravity' ;;
  esac
}

# engine_label ENGINE — the GitHub label that records which CLI wrote a PR.
engine_label() {
  case "$1" in
    claude) printf 'engine:claude' ;;
    *) printf 'engine:agy' ;;
  esac
}

# engine_from_labels NAMES FALLBACK — NAMES is an issue's label names, one per line. Prints agy or claude.
engine_from_labels() {
  local names="$1" fallback="$2" has_agy=0 has_claude=0 name
  while IFS= read -r name; do
    case "$name" in
      engine:agy) has_agy=1 ;;
      engine:claude) has_claude=1 ;;
    esac
  done <<<"$names"
  if [[ "$has_agy" -eq 1 && "$has_claude" -eq 0 ]]; then
    printf 'agy'
  elif [[ "$has_claude" -eq 1 && "$has_agy" -eq 0 ]]; then
    printf 'claude'
  else
    printf '%s' "$fallback"
  fi
}

# ------------------------------------------------------------------ Claude Code's wall
claude_block_class() { { [[ -f "$CLAUDE_BLOCK_FILE" ]] && sed -n 1p "$CLAUDE_BLOCK_FILE"; } || return 0; }
claude_block_extra() { { [[ -f "$CLAUDE_BLOCK_FILE" ]] && sed -n 2p "$CLAUDE_BLOCK_FILE"; } || return 0; }
claude_block_line() { { [[ -f "$CLAUDE_BLOCK_FILE" ]] && sed -n 3p "$CLAUDE_BLOCK_FILE"; } || return 0; }

# record_claude_block CLASS EXTRA LINE — LINE is one line of what claude said; masked here as well as by the caller.
record_claude_block() {
  local line
  line="$(printf '%s' "$3" | tr '\r\n' '  ' | redact_secrets | cut -c1-300)"
  mkdir -p "$(dirname "$CLAUDE_BLOCK_FILE")" && printf '%s\n%s\n%s\n' "$1" "$2" "$line" >"$CLAUDE_BLOCK_FILE"
}

# claude_blocked — true while a recorded wall still holds. A wall that has lifted is removed (a dry run only reports it).
claude_blocked() {
  [[ -f "$CLAUDE_BLOCK_FILE" ]] || return 1
  local klass extra now
  klass="$(claude_block_class)"
  extra="$(claude_block_extra)"
  now="$(date -u +%s)"
  case "$klass" in
    quota)
      extra="${extra//[!0-9]/}"
      if [[ -n "$extra" && "${#extra}" -le 12 && "$extra" -gt "$now" ]]; then
        return 0
      fi
      log "Claude Code's limit has lifted — dispatching to it again"
      ;;
    auth)
      if [[ "$extra" == "$(file_mtime "$(claude_token_file)")" ]]; then
        return 0
      fi
      log "Claude Code's token file changed since it was refused — trying it again"
      ;;
    *)
      log "ignoring an unreadable Claude Code block file (class '${klass}') — dispatching to it again"
      ;;
  esac
  [[ "${DRY_RUN:-0}" -eq 1 ]] || rm -f "$CLAUDE_BLOCK_FILE"
  return 1
}
