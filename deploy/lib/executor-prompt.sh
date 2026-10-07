# shellcheck shell=bash
#
# executor-prompt.sh — the executor of an APPROVED spec gets a prompt built from the contract (AGENT_PIPELINE_V2=1).
# SOURCED by deploy/agent-dispatch (after pass-p.sh; it reuses log, notify, gh, issue_has_label, as_antigravity,
# set_integration_branch, redact_secrets from there). With the flag off every function here answers "off" and touches nothing.
#
# WHAT IT DECIDES (the judgement is in scripts/pipeline-executor-prompt.ts, pure and unit-tested; this file only runs it)
#   exec_lookup ISSUE        -> "off" | "none" | "contract <spec_commit>" | "invalid <why>"
#       none      = nobody ever approved a spec for this issue: the legacy free-text path runs, unchanged.
#       invalid   = a contract exists and cannot be used (corrupt, unreadable, no spec commit). NEVER falls back to legacy:
#                   the founder approved a locked test, so running without it would be running a different task.
#   exec_build ISSUE BRANCH TARGET OUT [STANDARDS_FILE]
#       writes the prompt to OUT; on failure prints why and returns 1.
#   exec_prompt_into ISSUE BRANCH TARGET OUT
#       the same, with STANDARDS.md read from the checkout in $WORKSPACE (the spec branch), as the executor's user.
#   exec_refuse ISSUE TITLE WHY
#       once per issue: agent:ready off, agent:needs-brief on, one comment, one Telegram message.
#   exec_changed_nothing ISSUE PR ENAME LOG
#       the executor of an approved spec finished with no commit on top of the locked test: the PR (if any) is closed,
#       agent:working -> agent:needs-brief, one comment, one Telegram message. Only called for a contract run.
#
# NEEDS FROM THE SOURCING SCRIPT: log, notify, gh, jq, as_antigravity, issue_has_label, finish_issue, redact_secrets,
#   agy_progress_outcome, REPO, WORKSPACE, DRY_RUN, NEEDS_BRIEF_LABEL.

EXEC_ROOT="${AGENT_DISPATCH_PIPELINE_ROOT:-/opt/founderos}"
EXEC_NODE="${AGENT_DISPATCH_NODE:-node}"
EXEC_STANDARDS_MAX=200000

exec_enabled() { [[ "${AGENT_PIPELINE_V2:-}" == "1" ]]; }

# exec_ts ARGS... — scripts/pipeline-executor-prompt.ts with stdin passed through; prints its one JSON line.
exec_ts() {
  ( cd "$EXEC_ROOT" && "$EXEC_NODE" --import tsx/esm scripts/pipeline-executor-prompt.ts "$@" )
}

exec_lookup() {
  if ! exec_enabled; then echo off; return 0; fi
  local out status
  if ! out="$(exec_ts lookup "$REPO" "$1" </dev/null 2>/dev/null)" || [[ -z "$out" ]]; then
    echo "invalid the contract lookup did not run (is node and ${EXEC_ROOT} in place?)"
    return 0
  fi
  status="$(jq -r '.status // empty' <<<"$out" 2>/dev/null)"
  case "$status" in
    NONE) echo none ;;
    CONTRACT) echo "contract $(jq -r '.spec_commit' <<<"$out")" ;;
    INVALID) echo "invalid $(jq -r '.error // "unknown"' <<<"$out" | tr '\n' ' ' | cut -c1-300)" ;;
    *) echo "invalid the contract lookup answered ${status:-nothing}" ;;
  esac
}

exec_build() {
  local issue="$1" branch="$2" target="$3" out_file="$4" standards="${5:-/dev/null}" out status
  if ! out="$(exec_ts build "$REPO" "$issue" "$branch" "$target" <"$standards" 2>/dev/null)" || [[ -z "$out" ]]; then
    echo "the prompt builder did not run"
    return 1
  fi
  status="$(jq -r '.status // empty' <<<"$out" 2>/dev/null)"
  if [[ "$status" != "PROMPT" ]]; then
    jq -r '.error // "the prompt builder answered " + (.status // "nothing")' <<<"$out" 2>/dev/null | tr '\n' ' ' | cut -c1-300
    return 1
  fi
  jq -r '.prompt' <<<"$out" >"$out_file" || { echo "could not write the prompt"; return 1; }
}

exec_prompt_into() {
  local issue="$1" branch="$2" target="$3" out_file="$4" std rc=0
  std="$(mktemp /tmp/agent-dispatch-standards-XXXXXX.md)"
  # The checkout belongs to the executor's user; a missing file just means a repo with no STANDARDS.md.
  as_antigravity 'head -c "$2" "$1/docs/antigravity/STANDARDS.md" 2>/dev/null || true' "$WORKSPACE" "$EXEC_STANDARDS_MAX" >"$std" 2>/dev/null
  exec_build "$issue" "$branch" "$target" "$out_file" "$std" || rc=$?
  rm -f "$std"
  return "$rc"
}

exec_refuse() {
  local issue="$1" title="$2" why="$3"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRY RUN would not run #${issue} '${title}': the approved contract cannot be used — ${why}"
    return 0
  fi
  if [[ "$(issue_has_label "$issue" "$NEEDS_BRIEF_LABEL")" == "true" ]]; then
    gh issue edit "$issue" --repo "$REPO" --remove-label agent:ready >/dev/null 2>&1 || true
    log "#${issue} already carries ${NEEDS_BRIEF_LABEL} and its contract is still unusable (${why}) — agent:ready removed again, no new comment or message"
    return 0
  fi
  gh label create "$NEEDS_BRIEF_LABEL" --repo "$REPO" --color FBCA04 \
    --description "The issue is not a complete brief; agent-dispatch will not claim it until it is" --force >/dev/null 2>&1 || true
  if ! gh issue edit "$issue" --repo "$REPO" --remove-label agent:ready --add-label "$NEEDS_BRIEF_LABEL" >/dev/null 2>&1; then
    log "#${issue} contract is unusable (${why}) but could not be labelled ${NEEDS_BRIEF_LABEL} — nothing sent; this repeats next tick until GitHub accepts the label"
    return 0
  fi
  gh issue comment "$issue" --repo "$REPO" --body "<!-- agent-needs-brief --> agent-dispatch did not run this issue: the contract you approved cannot be used (${why}). It did not fall back to the free-text path, because that would run a different task than the one with the locked test you approved. Nothing was spent: no run started.

Fix: repair or re-create the spec (ask FounderOS again), then put \`agent:ready\` back." >/dev/null
  notify "📝 agent-dispatch did NOT run #${issue} in ${REPO} ('${title}'): the approved contract cannot be used (${why}). No executor run was started. You hear about this issue once."
  log "#${issue} not run: contract unusable (${why}) — labelled ${NEEDS_BRIEF_LABEL}, commented, Telegram sent"
}

exec_changed_nothing() {
  local issue="$1" pr="$2" ename="$3" run_log="$4" last_line closed=""
  last_line="$(grep -v '^[[:space:]]*$' "$run_log" 2>/dev/null | tail -n1 | redact_secrets | cut -c1-200)"
  log "#${issue}: ${ename} finished with no commit on top of the locked test (pr=${pr:-none}) — closing the empty PR, asking the founder"
  if [[ -n "$pr" ]]; then
    if gh pr close "$pr" --repo "$REPO" --comment "Closed by agent-dispatch: this PR holds only the locked test for #${issue}, no change on top of it. The branch stays, so a retry builds on the same test." >/dev/null 2>&1; then
      closed=" Its PR #${pr} held only the test and was closed; the branch stays."
    else
      log "WARNING: could not close the empty PR #${pr} for #${issue} — close it by hand: gh pr close ${pr} --repo ${REPO}"
      closed=" Its PR #${pr} holds only the test; close it (agent-dispatch could not)."
    fi
  fi
  gh label create "$NEEDS_BRIEF_LABEL" --repo "$REPO" --color FBCA04 \
    --description "The issue is not a complete brief; agent-dispatch will not claim it until it is" --force >/dev/null 2>&1 || true
  finish_issue "$issue" "$NEEDS_BRIEF_LABEL"
  gh issue comment "$issue" --repo "$REPO" --body "<!-- agent-changed-nothing --> ${ename} finished but committed nothing on top of the locked test you approved.${closed} It found nothing to change, or could not make the test pass and stopped. Its last line: \`${last_line:-<empty>}\`

Still broken? Add what you see, then put \`agent:ready\` back: the approved spec is kept, so the retry builds on the same test. Done? Close this issue." >/dev/null
  notify "🤷 #${issue} (${REPO}): ${ename} committed nothing on top of the locked test, so there is nothing to review.${closed} Retry: add what is still wrong to the issue and relabel agent:ready. Done: close it."
  agy_progress_outcome "🤷 ${ename} committed nothing on top of the locked test. #${issue} is ${NEEDS_BRIEF_LABEL}.${closed}"
}
