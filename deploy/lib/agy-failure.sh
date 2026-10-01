# shellcheck shell=bash
#
# agy-failure.sh — why did an Antigravity (agy) run end without a PR? SOURCED by
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
# NOT VERIFIED against a real failure: the log carries verbatim only the quota line,
# "Error: timeout waiting for response", "timeout: failed to execute process" and
# "HTTP 401: Bad credentials". The other formats below are what Google's APIs and
# gRPC print, not something observed from agy. When the first real auth failure lands
# in ~/.claude/agent-dispatch.log, add its line to FIXTURES in the test and its shape
# to AGY_AUTH_PATTERNS. Until then an unrecognised auth failure degrades to agent:failed.

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
