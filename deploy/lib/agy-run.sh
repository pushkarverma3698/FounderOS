# shellcheck shell=bash
#
# agy-run.sh — run ONE Antigravity (agy) turn as the antigravity user, and show it live in Telegram.
# SOURCED by deploy/agent-dispatch (the executor) and deploy/vps-daemons/pr-brain (the reviewer), so the
# two cannot drift: the invocation used to be pasted into every call site, and each bug found in it had to
# be fixed at all of them.
#
# WHAT IT DOES
#   agy_run starts agy with --output-format stream-json, so every tool call arrives as an event, and edits ONE
#   Telegram message every PROGRESS_POLL_SEC with what agy is doing right now: the last tool calls, the clock,
#   the model. When the run ends the message is left in the chat, finished, and the caller adds the outcome
#   ("-> PR #45 opened"). It is never deleted: that message is the founder's record of what ran.
#
#   Before this, the "progress" was the last line agy printed in --output-format text, which is narration and
#   noise: "root agent idle; waiting for 1 background task", "</app_notification>", "- No new PR opened".
#
# THE TWO FILES A RUN LEAVES
#   raw   the stream exactly as agy wrote it: JSON events, plus anything agy printed that is not an event.
#         Deleted when the run ends; only the text view below goes into logs.
#   text  a plain-text VIEW of the run for the failure classifier (agy-failure.sh): the final answer, then every
#         line that is not an event (agy prints its own errors that way: "Error: authentication timed out."),
#         then the result event's error as "Error: <text>". HOW THE RUN ENDED COMES LAST because the classifier
#         reads only the tail: a 28-minute review whose answer was 100 lines long, followed by a quota wall, was
#         counted as an ordinary failed attempt (2026-10-02) when the error lines sat in front of the answer.
#         Tool output stays out of it.
#
# WHAT agy ACTUALLY DOES (agy 1.2.14, observed 2026-10-02, not assumed)
#   {"event":"init", ...} then {"event":"step_update","step_update":{step_index,state ACTIVE|DONE,step_type
#   user_input|agent_response|tool,tool_name,tool_info:{parameters:{CommandLine|TargetFile|AbsolutePath|...}}}}
#   per step, then {"event":"result","result":{status SUCCESS|ERROR,response,error,duration_seconds,...}}.
#   A --print-timeout is NOT an error: exit 0, status SUCCESS, partial output. An unusable login or model is:
#   exit 1, status ERROR, and the same words on stderr.
#
# NEEDS FROM THE SOURCING SCRIPT (defined before any function here is called)
#   log()  redact_secrets (deploy/lib/down-state.sh)  ENV_FILE (dotenv holding TELEGRAM_BOT_TOKEN and
#   TELEGRAM_CHAT_ID)  AG_USER (the Linux user agy runs as)  PROGRESS_POLL_SEC (seconds between edits)
#
# agy IGNORES GEMINI_API_KEY (verified 2026-10-02: a bogus key still ran, a bogus HOME did not): it signs in
# with the antigravity user's own login. The key is still handed over when the caller has one, exactly as
# before, because agent-dispatch's tests pin that it never reaches a command line or a log.

# The model the EXECUTOR writes code with. One definition for both daemons: pr-brain must never review a PR with
# the model that wrote it (ADR-046, the first independence condition), and it can only know that by reading the
# same setting the executor reads. Explicit --model matters: bare `agy` runs on whatever default the quota allows.
AGY_EXECUTOR_MODEL="${AGENT_DISPATCH_MODEL:-gemini-3.6-flash-medium}"

# Runs a command as $AG_USER without ever letting arbitrary content (issue bodies, review comments) pass
# through shell interpolation: arguments after the script reach the inner bash as $1, $2, ..., never
# substituted into the script text. -l (login shell) is required, not cosmetic: agy lives in ~/.local/bin,
# which only the antigravity user's profile puts on PATH.
as_antigravity() {
  local script="$1"; shift
  sudo -u "$AG_USER" -- bash -lc "$script" _ "$@"
}

_agy_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if ! declare -f tg_is_quiet >/dev/null 2>&1; then
  if [[ -f "$_agy_lib_dir/tg-quiet.sh" ]]; then
    # shellcheck source=/dev/null
    source "$_agy_lib_dir/tg-quiet.sh"
  fi
fi

# ------------------------------------------------------------------ Telegram
_agy_tg_creds() {
  [[ -n "${ENV_FILE:-}" && -f "$ENV_FILE" ]] || return 1
  AGY_TG_TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"'\r')
  AGY_TG_CHAT=$(grep -m1 '^TELEGRAM_CHAT_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"'\r')
  [[ -n "$AGY_TG_TOKEN" && -n "$AGY_TG_CHAT" ]]
}

# agy_tg_send TEXT -> the new message's id on stdout (nothing when Telegram refused or is unset).
# A progress ping is cosmetic: it must never fail or block the tick it describes.
agy_tg_send() {
  tg_is_quiet 2>/dev/null && return 0
  _agy_tg_creds || return 0
  local mid
  mid="$(curl -s --max-time 20 \
    "https://api.telegram.org/bot${AGY_TG_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${AGY_TG_CHAT}" \
    --data-urlencode "text=$1" \
    --data "disable_web_page_preview=true" 2>/dev/null \
    | jq -r '.result.message_id // empty' 2>/dev/null || true)"
  [[ -n "$mid" ]] || return 0
  declare -F tg_screen_log >/dev/null && tg_screen_log "$1" "$AGY_TG_CHAT" "$mid"
  printf '%s\n' "$mid"
  return 0
}

# agy_tg_edit ID TEXT — replaces the text of message ID. Silent when there is no ID (the send failed).
agy_tg_edit() {
  tg_is_quiet 2>/dev/null && return 0
  [[ -n "${1:-}" ]] || return 0
  _agy_tg_creds || return 0
  if curl -sf -o /dev/null --max-time 20 \
    "https://api.telegram.org/bot${AGY_TG_TOKEN}/editMessageText" \
    --data-urlencode "chat_id=${AGY_TG_CHAT}" \
    --data "message_id=$1" \
    --data-urlencode "text=$2"; then
    declare -F tg_screen_log >/dev/null && tg_screen_log "$2" "$AGY_TG_CHAT" "$1"
  fi
  return 0
}

# ------------------------------------------------------------------ the live view
# jq program: the raw stream on stdin (one JSON event per line, other lines ignored) -> the Telegram text.
# --arg label model elapsed. Written to render the same stream at ANY point of a run, finished or not: a
# half-written last line is skipped by fromjson?, a run with no events yet renders just its header.
_AGY_RENDER_JQ=$(cat <<'JQ'
def clip($n): gsub("[\r\n\t]+"; " ") | if length > $n then .[0:($n - 1)] + "…" else . end;
def shown: sub("^/opt/agy-workspace/(review/)?[^/]+/"; "");
def verb: ({
  "run_command": "run", "view_file": "read", "view_file_outline": "outline", "write_to_file": "write",
  "replace_file_content": "edit", "multi_replace_file_content": "edit", "grep_search": "search",
  "find_by_name": "find", "list_dir": "ls", "search_web": "web", "read_url_content": "fetch",
  "command_status": "wait for", "send_command_input": "type into", "browser_subagent": "browser"
}[.] // .);
def what: (.tool_info.parameters // {}) as $p
  | ($p.CommandLine // $p.TargetFile // $p.AbsolutePath // $p.DirectoryPath // $p.SearchPath // $p.Query
     // $p.query // $p.SearchPattern // $p.Pattern // $p.Url // $p.url // $p.Path // $p.path // "")
  | if type == "string" then . else tostring end;

[inputs | fromjson? | objects] as $ev
| [$ev[] | select(.event == "step_update") | .step_update] as $steps
| ($steps | map(select(.step_type == "tool")) | group_by(.step_index)
    | map({name: .[0].tool_name, done: (map(.state) | index("DONE") != null), what: (.[0] | what)})) as $tools
| ($ev | map(select(.event == "result")) | last) as $res
| ($steps | last // {}) as $last
| (if $res == null then "🔧"
   elif $res.result.status == "SUCCESS" then "✅"
   else "⚠️" end) as $icon
| [
    ($icon + " " + $label),
    ("⏱ " + $elapsed + " · " + $model + " · " + ($tools | length | tostring) + " tool call" + (if ($tools | length) == 1 then "" else "s" end)),
    "",
    ($tools[-5:][] | (if .done then "✅ " else "⏳ " end) + (.name | verb)
        + (if .what == "" then "" else " " + (.what | shown | clip(64)) end)),
    (if $res == null and $last.step_type == "agent_response" and $last.state == "ACTIVE" then "💭 thinking…" else empty end)
  ] | join("\n")
JQ
)

# agy_progress_render RAW LABEL MODEL STARTED_EPOCH — the Telegram text for the run so far, secrets masked.
# Only the tail of the stream is read: a long run's tool output can be megabytes, and the rendering polls it.
agy_progress_render() {
  local raw="$1" label="$2" model="$3" started="$4" secs elapsed
  secs=$(( $(date +%s) - started ))
  if [[ "$secs" -lt 60 ]]; then elapsed="just started"; else elapsed="$(( secs / 60 ))m"; fi
  tail -c 6000000 "$raw" 2>/dev/null \
    | jq -R -n -r --arg label "$label" --arg model "$model" --arg elapsed "$elapsed" "$_AGY_RENDER_JQ" 2>/dev/null \
    | redact_secrets
}

# agy_text_view RAW — the plain-text view of a run (see the header): what the failure classifier reads. The answer
# first, how the run ended last: the classifier looks only at the tail.
agy_text_view() {
  local raw="$1"
  jq -R -r 'fromjson? | objects | select(.event == "result") | .result
            | ((.response // "") | rtrimstr("\n") | select(. != ""))' "$raw" 2>/dev/null
  grep -av '^{"event":' "$raw" 2>/dev/null
  jq -R -r 'fromjson? | objects | select(.event == "result") | .result
            | (if (.error // "") != "" then "Error: " + .error else empty end)' "$raw" 2>/dev/null
  return 0
}

# agy_run LABEL WORKDIR PROMPT_FILE MODEL TIMEOUT_SEC TEXT_LOG [KEY]
#
# Runs one agy turn in WORKDIR as $AG_USER. LABEL is the Telegram message's first line. PROMPT_FILE is read BY
# agy's shell (it must be readable by $AG_USER), so the prompt never sits in an argv here. TEXT_LOG receives the
# text view. KEY, when given, travels on STDIN and never on a command line: a positional argument would sit in
# /proc/<pid>/cmdline, readable by any local user through `ps`, for the whole run.
#
# Returns agy's exit code. Sets, for the caller:
#   AGY_PROGRESS_MSG_ID  the Telegram message that showed the run (empty when Telegram was unreachable)
#   AGY_PROGRESS_FINAL   its final text, to which agy_progress_outcome adds the outcome
agy_run() {
  local label="$1" workdir="$2" prompt_file="$3" model="$4" timeout_sec="$5" text_log="$6" key="${7-}"
  local raw pid rc started last text
  raw="$(mktemp /tmp/agy-run-XXXXXX.jsonl)"
  started="$(date +%s)"

  # Positional arguments only: $1 workdir, $2 prompt file, $3 timeout, $4 model, $5 print-timeout. The outer
  # `timeout` wraps the real `agy` executable inside the sudo'd script: it cannot wrap a shell function.
  # --print-timeout is REQUIRED: agy's own wait-for-response timeout defaults to 5m regardless of the outer
  # `timeout`, and every real task (pnpm install + lint alone can take longer) died at 5m05s on it before this
  # was set just under the outer bound (#452, #508, #670).
  as_antigravity 'IFS= read -r GEMINI_API_KEY; if [ -n "$GEMINI_API_KEY" ]; then export GEMINI_API_KEY; else unset GEMINI_API_KEY; fi; exec </dev/null; cd "$1" && timeout "$3" agy --new-project --model "$4" --print "$(cat "$2")" --print-timeout "$5" --dangerously-skip-permissions --output-format stream-json' \
    "$workdir" "$prompt_file" "$timeout_sec" "$model" "$(( timeout_sec - 120 ))s" <<<"$key" >"$raw" 2>&1 &
  pid=$!

  AGY_PROGRESS_MSG_ID="$(agy_tg_send "🔧 ${label}: starting…")"
  log "progress: message ${AGY_PROGRESS_MSG_ID:-FAILED} sent for ${label}"
  last=""
  while kill -0 "$pid" 2>/dev/null; do
    sleep "${PROGRESS_POLL_SEC:-20}"
    text="$(agy_progress_render "$raw" "$label" "$model" "$started")"
    if [[ -n "$text" && "$text" != "$last" ]]; then
      agy_tg_edit "$AGY_PROGRESS_MSG_ID" "$text"
      last="$text"
      log "progress: message ${AGY_PROGRESS_MSG_ID:-none} updated"
    fi
  done
  wait "$pid"
  rc=$?

  agy_text_view "$raw" >"$text_log"
  AGY_PROGRESS_FINAL="$(agy_progress_render "$raw" "$label" "$model" "$started")"
  [[ -n "$AGY_PROGRESS_FINAL" ]] || AGY_PROGRESS_FINAL="🔧 ${label}"
  agy_tg_edit "$AGY_PROGRESS_MSG_ID" "$AGY_PROGRESS_FINAL"
  log "progress: message ${AGY_PROGRESS_MSG_ID:-none} finished (agy exit ${rc})"
  rm -f "$raw"
  return "$rc"
}

# agy_progress_outcome TEXT — adds the outcome to the run's message ("-> PR #45 opened for review"). The
# caller knows what only the caller can: whether a PR really landed, and what the reviewer decided.
agy_progress_outcome() {
  [[ -n "${AGY_PROGRESS_MSG_ID:-}" ]] || return 0
  local text; text="$(printf '%s\n\n%s' "$AGY_PROGRESS_FINAL" "$1" | redact_secrets)"
  agy_tg_edit "$AGY_PROGRESS_MSG_ID" "$text"
}
