# shellcheck shell=bash
#
# agy-failure.sh — why did a coding-CLI run (Antigravity, or Claude Code through claude-run.sh) end without a PR? SOURCED by
# deploy/agent-dispatch; every function is a pure function of the log file, which is
# what lets tests/unit/scripts/agy-failure-classifier.test.ts pin each pattern
# without running the daemon.
#
# The four answers, and what the daemon does with each:
#   quota      a quota wall (carries a reset time)  -> back off until it lifts, issue stays agent:ready
#   auth       a rejected key / expired login       -> pause the WHOLE loop, one message, issue stays agent:ready
#   transient  timeout / 5xx / connection reset     -> retry next tick, agent:failed on the 3rd
#   unknown    anything else                        -> agent:failed, exactly as before
#
# The two mistakes are not equally expensive. A false "auth" pauses every repo until
# the founder acts; a false "unknown" only falls back to the old behaviour (agent:failed
# plus a message). So the classifier is deliberately hard to trip:
#   1. it reads only the TAIL of the log — the terminating error is the last thing agy
#      prints; everything above it is the agent's narration and echoed code;
#   2. a signature counts only on an ERROR LINE, one the CLI or a tool printed about
#      its own failure. A transcript that discusses 401, "please log in" or "500 lines"
#      while it implements a login page is not an error line;
#   3. a bare status code counts only in an HTTP / status / code context.
#
# VERIFIED against a real failure, one: an agy with no login (2026-10-02, agy 1.2.14, run with an empty
# HOME) prints "Error: authentication timed out." and "error: authentication failed or timed out" on
# stderr and exits 1. Before that line was added here, an expired login classified as "unknown": the issue
# went agent:failed and the loop never paused. The log also carries verbatim the quota line,
# "Error: timeout waiting for response", "timeout: failed to execute process" and "HTTP 401: Bad
# credentials". The other formats below are what Google's APIs and gRPC print, not something observed from
# agy. When a real failure of another shape lands in ~/.claude/agent-dispatch.log, add its line to FIXTURES
# in the test and its shape to the patterns. Until then it degrades to agent:failed.

# How many trailing lines of the log are examined (constant, not a magic number).
AGY_FAILURE_TAIL_LINES=40

# What makes a line an ERROR LINE (case-insensitive ERE): it opens with a severity or a
# program name and a colon (optionally after [bracketed] tags), or is a [ERROR] tag, a
# JSON error object, or an HTTP status line. "Error handling: …", "- Error: …" and
# echoed code such as `throw new Error("…")` do not qualify.
AGY_ERROR_LINE_RE='^[[:space:]]*(\[[^]]*\][[:space:]]*)*(error|fatal|panic|agy|timeout|curl|gh|googleapi|grpc)[[:space:]]*:|^[[:space:]]*\[(error|fatal|err)[^]]*\]|^[[:space:]]*\{[[:space:]]*"error"|^[[:space:]]*HTTP/[0-9.]+[[:space:]]+[0-9]{3}([^0-9]|$)|^[[:space:]]*HTTP[[:space:]]+[0-9]{3}:'

# The context a bare status code must appear in: HTTP 401, HTTP/1.1 503, status: 503,
# statusCode=403, "code": 429 — never a bare 500 ("500 lines"), never 4010.
_AGY_STATUS_CTX='(^|[^[:alnum:]_])(HTTP(/[0-9.]+)?|status([ _]?code)?|code)"?[[:space:]]*[:=]?[[:space:]]*"?'

# One ERE per element, tried in this order; a class matches when ANY element does.
# tests/unit/scripts/agy-failure-classifier.test.ts fails when an element has no fixture.
AGY_QUOTA_PATTERNS=(
  'Individual quota reached'
  'RESOURCE_EXHAUSTED'
  # Claude Code (claude-run.sh's text view puts "Error: " in front of the result text and of a rejected rate_limit_event)
  'hit your .*limit'
  'usage limit reached'
)
AGY_AUTH_PATTERNS=(
  'PERMISSION_DENIED'
  'UNAUTHENTICATED'
  'invalid_grant'
  'API key not valid'
  'API_KEY_INVALID'
  'please log ?in'
  'not logged in'
  'bad credentials'
  "${_AGY_STATUS_CTX}(401|403)([^0-9]|\$)"
  'authentication (failed|timed out)'
  # Claude Code: a made-up CLAUDE_CODE_OAUTH_TOKEN prints "Failed to authenticate. API Error: 401 ..."; no login at all
  # prints "Not logged in", which 'not logged in' above already reads
  'failed to authenticate'
  'oauth token (has )?expired'
)
AGY_TRANSIENT_PATTERNS=(
  'timeout waiting for response'
  'timeout: failed to execute process'
  'ECONNRESET'
  'UNAVAILABLE'
  "${_AGY_STATUS_CTX}(429|500|502|503|504)([^0-9]|\$)"
)

# agy_patterns CLASS — the class's patterns, one per line. Non-zero for a name that is
# not a class, so a typo can never turn into an empty list that classifies nothing.
agy_patterns() {
  case "$1" in
    quota) printf '%s\n' "${AGY_QUOTA_PATTERNS[@]}" ;;
    auth) printf '%s\n' "${AGY_AUTH_PATTERNS[@]}" ;;
    transient) printf '%s\n' "${AGY_TRANSIENT_PATTERNS[@]}" ;;
    *) echo "agy_patterns: unknown class '$1' (quota, auth or transient)" >&2; return 2 ;;
  esac
}

# The class's patterns as ONE ERE: (p1)|(p2)|…
_agy_regex_for() {
  local out="" p
  while IFS= read -r p; do
    out+="${out:+|}(${p})"
  done < <(agy_patterns "$1")
  [[ -n "$out" ]] || return 2
  printf '%s' "$out"
}

# The error lines among the last AGY_FAILURE_TAIL_LINES lines of the log $1.
agy_error_lines() {
  tail -n "$AGY_FAILURE_TAIL_LINES" "$1" 2>/dev/null | grep -Eai -- "$AGY_ERROR_LINE_RE"
  return 0
}

# agy_failure_line CLASS LOG — the FIRST error line in the tail that matches CLASS.
# This is the line quoted to the founder; the caller redacts it before it leaves the box.
agy_failure_line() {
  local re errs
  re=$(_agy_regex_for "$1") || return 2
  errs=$(agy_error_lines "$2")
  [[ -n "$errs" ]] || return 0
  grep -Eai -m1 -- "$re" <<<"$errs"
  return 0
}

# agy_model_unknown LOG — true when agy refused the --model it was given because its catalog has no such model.
# 2026-10-03: claude-sonnet-4-6 was retired for claude-sonnet-5-5-*, and agy answers a retired name with exit 1 and
#   error: invalid model selection (--model "X" --effort ""): model X is not recognized as a known model or custom model in settings
#   Available models: (the catalog, ~20 lines)
# That is neither an outage nor a quota wall: THAT model can never answer, another candidate may. Like the classes
# below it looks only at error lines in the tail, so a transcript that merely mentions the phrase does not count.
agy_model_unknown() {
  local errs
  errs=$(agy_error_lines "$1")
  [[ -n "$errs" ]] || return 1
  grep -Eaiq -- 'invalid model selection|is not recognized as a known model' <<<"$errs"
}

# classify_agy_failure LOG — echoes quota | auth | transient | unknown. Quota wins
# over auth (it carries a reset time, and a run can print both); auth wins over
# transient (a rejected credential explains everything and retrying would burn quota).
classify_agy_failure() {
  local errs klass re
  errs=$(agy_error_lines "$1")
  if [[ -n "$errs" ]]; then
    for klass in quota auth transient; do
      re=$(_agy_regex_for "$klass") || continue
      if grep -Eaiq -- "$re" <<<"$errs"; then
        echo "$klass"
        return 0
      fi
    done
  fi
  echo unknown
}
