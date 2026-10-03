# shellcheck shell=bash
#
# ci-state.sh — what the REQUIRED CI checks of a PR say right now. SOURCED by deploy/vps-daemons/pr-brain and
# deploy/agent-dispatch, so the two agree on what "red CI" means.
#
#   required_ci_state PR [REPO]     sets CI_STATE and CI_DETAIL
#     CI_STATE   red      a required check failed       CI_DETAIL = its name(s), comma separated
#                pending  none failed, one still runs (or was cancelled: it has no result)
#                green    every required check passed or was skipped
#                none     there is no answer: the base branch has no required checks, gh failed, or it printed
#                         something that is not a list of checks
#
# WHY REQUIRED ONLY. A failing "Deploy to EC2 Staging" on an Oplify PR is a deploy, not a verdict on the code; the
# checks branch protection requires are the ones that decide whether the PR can merge, and the ones a reviewer
# cannot talk its way past.
#
# WHY "none" IS NOT "green" AND NOT "red". Callers spend a review on "none", exactly as they did before this
# existed. A failure to read CI that quietly meant "skip the review" would stop the loop with nothing in any log;
# one that means "review it" costs one session.
#
# `gh pr checks --required --json` prints a JSON array on success (exit 0 on gh 2.63, whatever the buckets are),
# and for a branch with no required checks a sentence and exit 1: both are handled, and neither exit code is trusted.
required_ci_state() { # required_ci_state PR [REPO]
  local out
  CI_STATE=none
  CI_DETAIL=""
  if [[ -n "${2:-}" ]]; then
    out="$(gh pr checks "$1" --repo "$2" --required --json bucket,name 2>/dev/null)" || out=""
  else
    out="$(gh pr checks "$1" --required --json bucket,name 2>/dev/null)" || out=""
  fi
  jq -e 'type == "array" and length > 0' >/dev/null 2>&1 <<<"$out" || return 0
  CI_DETAIL="$(jq -r '[.[] | select(.bucket == "fail") | .name] | unique | join(", ")' <<<"$out" 2>/dev/null)"
  if [[ -n "$CI_DETAIL" ]]; then
    CI_STATE=red
  elif jq -e 'any(.[]; .bucket == "pending" or .bucket == "cancel")' >/dev/null 2>&1 <<<"$out"; then
    CI_STATE=pending
  else
    CI_STATE=green
  fi
  return 0
}
