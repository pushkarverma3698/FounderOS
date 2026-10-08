# shellcheck shell=bash
#
# claude-run.sh — run ONE Claude Code turn as the antigravity user, and show it live in Telegram.
# The Claude counterpart of agy-run.sh, SOURCED by deploy/agent-dispatch after agy-run.sh (it reuses as_antigravity,
# agy_tg_send and agy_tg_edit from there, and sets the same AGY_PROGRESS_* variables so agy_progress_outcome works for
# either CLI). One function per CLI, one switch (engine_run in engine.sh): adding another CLI is one more lib like this.
#
# WHAT IT DOES
#   claude_run starts `claude -p --output-format stream-json --verbose`, so every tool call arrives as an event, and edits
#   ONE Telegram message every PROGRESS_POLL_SEC with what Claude is doing now. When the run ends the message is left in
#   the chat, finished; the caller adds the outcome ("-> PR #45 opened"). Never deleted: it is the founder's record.
#
# THE TOKEN
#   A Claude subscription token the founder makes once with `claude setup-token` and keeps on line 1 of
#   ${AGENT_DISPATCH_CLAUDE_TOKEN_FILE:-$HOME/.claude/claude-code.token} (the dispatcher's user, mode 600). The antigravity
#   user has no login of its own and must not get one: the token is handed over on STDIN, never in argv (a positional
#   argument sits in /proc/<pid>/cmdline, readable by any local user, for the whole run) and becomes
#   CLAUDE_CODE_OAUTH_TOKEN inside the sudo'd shell only. An ANTHROPIC_API_KEY in that user's profile is removed first:
#   Claude Code prefers an API key to the token, which would bill the founder's API account instead of the subscription.
#
# WHAT claude ACTUALLY DOES (claude 2.1.x, captured 2026-10-03 on the VPS and a laptop, 0 tokens spent; the shapes are
# pinned in tests/unit/scripts/claude-streams.ts, each marked captured / shape / synthetic)
#   {"type":"system","subtype":"init"} … then per step {"type":"assistant","message":{"content":[tool_use|text]}} and
#   {"type":"user","message":{"content":[tool_result]}} … then {"type":"result","is_error":…,"result":"<text>"}.
#   THE WEEKLY LIMIT IS EXIT 0. Only a {"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":<epoch>}}
#   and the result's is_error:true, result "You've hit your weekly limit · resets Oct 5, 6am (UTC)", say so.
#   status "allowed_warning" is a warning, not a failure. No login: exit 1, "Not logged in · Please run /login". A token the
#   API refused: exit 1 after two 401 retries, "Failed to authenticate. API Error: 401 OAuth access token is invalid."
#   NOT VERIFIED live: the shape of a WORKING run (no logged-in Claude was available). The progress view reads the
#   documented tool_use / tool_result events; if it renders nothing the run is unaffected, only the Telegram view is.
#
# NEEDS FROM THE SOURCING SCRIPT (defined before any function here is called)
#   everything agy-run.sh needs, plus nothing new.

# The model the Claude executor writes code with. Reviewers must not review a PR with the model that wrote it; pr-brain
# keeps Claude candidates away from a PR labelled engine:claude (select_review_model).
CLAUDE_EXECUTOR_MODEL="${AGENT_DISPATCH_CLAUDE_MODEL:-sonnet}"

# A quota wall with no usable reset time blocks claude this long; a reset further away than the cap is not believed
# (a weekly limit resets within 7 days; a clock-skewed or malformed value must not block claude for good).
CLAUDE_QUOTA_FALLBACK_SEC=3600
CLAUDE_QUOTA_MAX_SEC=$(( 8 * 86400 ))

# claude_token_file — where the token lives.
claude_token_file() { printf '%s' "${AGENT_DISPATCH_CLAUDE_TOKEN_FILE:-$HOME/.claude/claude-code.token}"; }

# claude_token — line 1 of the token file, trimmed. Non-zero, printing nothing, when the file is missing or holds no token.
claude_token() {
  local f tok
  f="$(claude_token_file)"
  [[ -f "$f" ]] || return 1
  IFS= read -r tok <"$f" 2>/dev/null || true
  tok="${tok//$'\r'/}"
  tok="${tok#"${tok%%[![:space:]]*}"}"
  tok="${tok%"${tok##*[![:space:]]}"}"
  [[ -n "$tok" ]] || return 1
  printf '%s\n' "$tok"
}

# ------------------------------------------------------------------ the live view
# jq program: the raw stream on stdin (one JSON event per line, other lines ignored) -> the Telegram text.
# --arg label model elapsed. Renders the same stream at ANY point of a run: a half-written last line is skipped by
# fromjson?, a run with no events yet renders just its header.
_CLAUDE_RENDER_JQ=$(cat <<'JQ'
def clip($n): gsub("[\r\n\t]+"; " ") | if length > $n then .[0:($n - 1)] + "…" else . end;
def shown: sub("^/opt/agy-workspace/(review/)?[^/]+/"; "");
def verb: ({
  "Bash": "run", "Read": "read", "Edit": "edit", "MultiEdit": "edit", "Write": "write", "NotebookEdit": "edit",
  "Grep": "search", "Glob": "find", "LS": "ls", "WebSearch": "web", "WebFetch": "fetch", "Task": "subagent",
  "TodoWrite": "plan", "BashOutput": "wait for"
}[.] // .);
def what: (. // {}) as $p
  | ($p.command // $p.file_path // $p.notebook_path // $p.path // $p.pattern // $p.url // $p.query // $p.description // $p.prompt // "")
  | if type == "string" then . else tostring end;

[inputs | fromjson? | objects] as $ev
| ([$ev[] | select(.type == "user") | .message.content? | arrays | .[] | objects | select(.type == "tool_result") | .tool_use_id]) as $finished
| ([$ev[] | select(.type == "assistant") | .message.content? | arrays | .[] | objects | select(.type == "tool_use")]
    | map({name: (.name // "tool"), done: (.id as $i | $finished | index($i) != null), what: (.input | what)})) as $tools
| ($ev | map(select(.type == "result")) | last) as $res
| (if $res == null then "🔧" elif $res.is_error == true then "⚠️" else "✅" end) as $icon
| [
    ($icon + " " + $label),
    ("⏱ " + $elapsed + " · " + $model + " · " + ($tools | length | tostring) + " tool call" + (if ($tools | length) == 1 then "" else "s" end)),
    "",
    ($tools[-5:][] | (if .done then "✅ " else "⏳ " end) + (.name | verb)
        + (if .what == "" then "" else " " + (.what | shown | clip(64)) end))
  ] | join("\n")
JQ
)

# claude_progress_render RAW LABEL MODEL STARTED_EPOCH — the Telegram text for the run so far, secrets masked.
claude_progress_render() {
  local raw="$1" label="$2" model="$3" started="$4" secs elapsed
  secs=$(( $(date +%s) - started ))
  if [[ "$secs" -lt 60 ]]; then elapsed="just started"; else elapsed="$(( secs / 60 ))m"; fi
  tail -c 6000000 "$raw" 2>/dev/null \
    | jq -R -n -r --arg label "$label" --arg model "$model" --arg elapsed "$elapsed" "$_CLAUDE_RENDER_JQ" 2>/dev/null \
    | redact_secrets
}

# claude_text_view RAW — the plain-text view of a run: what the failure classifier (agy-failure.sh) reads. The answer
# first, every line that is not an event next (the CLI's own stderr, `timeout`'s), and HOW THE RUN ENDED LAST because the
# classifier reads only the tail: a rejected rate_limit_event becomes "Error: usage limit reached · resetsAt=<epoch>", a
# result with is_error becomes "Error: <its text>". Narration and tool output stay out: an agent discussing a 401 must
# not read as one.
claude_text_view() {
  local raw="$1"
  jq -R -r 'fromjson? | objects | select(.type == "result" and .is_error != true)
            | ((.result // "") | rtrimstr("\n") | select(. != ""))' "$raw" 2>/dev/null
  grep -av '^{"type":"' "$raw" 2>/dev/null
  jq -R -r 'fromjson? | objects
            | if .type == "rate_limit_event" and .rate_limit_info.status == "rejected"
              then "Error: usage limit reached" + (if .rate_limit_info.resetsAt == null then "" else " · resetsAt=" + (.rate_limit_info.resetsAt | tostring) end)
              elif .type == "result" and (.is_error == true or ((.subtype // "success") | startswith("error")))
              then "Error: " + (if (.result // "") != "" then .result else "claude ended with " + (.subtype // "an error") end)
              else empty end' "$raw" 2>/dev/null
  return 0
}

# claude_quota_epoch TEXT_LOG — when claude's limit lifts, as epoch seconds, for a log classified as a quota wall.
# Non-zero for anything else. The CLI's own resetsAt when it is in the future and within CLAUDE_QUOTA_MAX_SEC; otherwise
# an hour from now (never "now": running again at once only hits the wall again).
claude_quota_epoch() {
  local log="$1" now epoch
  [[ "$(classify_agy_failure "$log")" == quota ]] || return 1
  now="$(date +%s)"
  epoch="$(agy_error_lines "$log" | grep -Eao 'resetsAt=[0-9]+' | tail -n 1 | cut -d= -f2)"
  if [[ -z "$epoch" || "${#epoch}" -gt 12 || "$epoch" -le "$now" ]]; then
    epoch=$(( now + CLAUDE_QUOTA_FALLBACK_SEC ))
  elif [[ "$epoch" -gt $(( now + CLAUDE_QUOTA_MAX_SEC )) ]]; then
    epoch=$(( now + CLAUDE_QUOTA_MAX_SEC ))
  fi
  printf '%s\n' "$epoch"
}

# claude_failure_line CLASS TEXT_LOG — the LAST error line in the tail that matches CLASS, to quote to the founder. Not
# agy_failure_line's first: the text view ends with the sentence the CLI itself said ("Error: You've hit your weekly limit
# · resets Oct 5, 6am (UTC)"), after an earlier, machine-made line ("Error: usage limit reached · resetsAt=1791180000").
# The caller redacts it before it leaves the box.
claude_failure_line() {
  local re errs
  re=$(_agy_regex_for "$1") || return 2
  errs=$(agy_error_lines "$2")
  [[ -n "$errs" ]] || return 0
  grep -Eai -- "$re" <<<"$errs" | tail -n 1
  return 0
}

# claude_run LABEL WORKDIR PROMPT_FILE MODEL TIMEOUT_SEC TEXT_LOG [TOKEN]
#
# Runs one claude turn in WORKDIR as $AG_USER. Same arguments, outputs and AGY_PROGRESS_* variables as agy_run. The prompt
# file is read BY the sudo'd shell (it must be readable by $AG_USER). TOKEN travels on STDIN. No token: claude gets none,
# and says "Not logged in" (the caller checks first, so that is the founder's cue, not a surprise).
# Returns claude's exit code, which is 0 for a weekly limit: the caller reads the text view, not the code.
claude_run() {
  local label="$1" workdir="$2" prompt_file="$3" model="$4" timeout_sec="$5" text_log="$6" token="${7-}"
  local raw pid rc started last text
  raw="$(mktemp /tmp/claude-run-XXXXXX)" # the X's last: BSD mktemp (macOS) does not randomise them when a suffix follows
  started="$(date +%s)"

  # Positional arguments only: $1 workdir, $2 prompt file, $3 timeout, $4 model. The outer `timeout` wraps the real
  # `claude` executable inside the sudo'd script: it cannot wrap a shell function.
  as_antigravity "$(gh_shell_prelude)"$'\n''IFS= read -r CLAUDE_CODE_OAUTH_TOKEN; if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then export CLAUDE_CODE_OAUTH_TOKEN; else unset CLAUDE_CODE_OAUTH_TOKEN; fi; unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; exec </dev/null; cd "$1" && timeout "$3" claude -p "$(cat "$2")" --model "$4" --dangerously-skip-permissions --output-format stream-json --verbose' \
    "$workdir" "$prompt_file" "$timeout_sec" "$model" <<<"${GH_TOKEN:-}"$'\n'"$token" >"$raw" 2>&1 &
  pid=$!

  AGY_PROGRESS_MSG_ID="$(agy_tg_send "🔧 ${label}: starting…")"
  log "progress: message ${AGY_PROGRESS_MSG_ID:-FAILED} sent for ${label}"
  last=""
  while kill -0 "$pid" 2>/dev/null; do
    sleep "${PROGRESS_POLL_SEC:-20}"
    text="$(claude_progress_render "$raw" "$label" "$model" "$started")"
    if [[ -n "$text" && "$text" != "$last" ]]; then
      agy_tg_edit "$AGY_PROGRESS_MSG_ID" "$text"
      last="$text"
      log "progress: message ${AGY_PROGRESS_MSG_ID:-none} updated"
    fi
  done
  wait "$pid"
  rc=$?

  claude_text_view "$raw" >"$text_log"
  AGY_PROGRESS_FINAL="$(claude_progress_render "$raw" "$label" "$model" "$started")"
  [[ -n "$AGY_PROGRESS_FINAL" ]] || AGY_PROGRESS_FINAL="🔧 ${label}"
  agy_tg_edit "$AGY_PROGRESS_MSG_ID" "$AGY_PROGRESS_FINAL"
  log "progress: message ${AGY_PROGRESS_MSG_ID:-none} finished (claude exit ${rc})"
  rm -f "$raw"
  return "$rc"
}
