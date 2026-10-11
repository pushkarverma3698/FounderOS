# shellcheck shell=bash
#
# agent-guard.sh — hard checks around an agent run, in code, so they do not depend on the agent obeying its prompt.
# SOURCED by deploy/agent-dispatch. Born from the Oplify sign-in work (issues #117/#119, 2026-10-11): three agents worked
# the same bug, one PR was titled for a different task, one fixed an unrelated billing path, and nothing stopped a PR
# from being aimed at the production branch.
#
#   guard_forbidden_base BRANCH        exit 0 when an agent must never target BRANCH (production, prod)
#   guard_issue_refs BODY_ON_STDIN     the #N numbers a body mentions, unique, one per line
#   guard_issue_conflict ISSUE BODY    ONE AGENT PER ISSUE. Exit 0 and one line of reason when the issue (or an issue its
#                                      brief points at) already has agent work in flight; exit 1 = free; exit 2 = could not
#                                      read GitHub (the caller skips this tick, it does not guess).
#                                      "In flight" for ISSUE itself: an open task/issue-N PR. For a referenced issue: an open
#                                      task/issue-N PR, ANY remote task/issue-N branch, or agent:working / agent:review.
#                                      A hand run (`agent-dispatch --issue N`, FORCE_ISSUE set) skips the referenced-issue check:
#                                      the founder named the issue on purpose. The issue's own open PR still blocks.
#   guard_after_pr PR TARGET           after a run: the PR's base must be TARGET and it must still be a draft and unmerged.
#                                      Wrong base is retargeted; a ready PR is put back to draft. Exit 0 = PR is as required,
#                                      1 = could not be put right (the caller fails the issue), 2 = the PR is already merged.
#                                      Prints one line per correction on stdout.
#
# What this cannot do: the executors run with the bot's own token, which can merge and approve, so those two are only
# forbidden in the prompt; guard_after_pr is the net that catches the visible damage (wrong base, ready, merged).
#
# NEEDS FROM THE SOURCING SCRIPT: log, gh, jq, REPO. FORCE_ISSUE is read when set.

guard_forbidden_base() {
  case "$1" in production|prod) return 0 ;; esac
  return 1
}

guard_issue_refs() {
  # Strip fenced code and HTML comments first: a pasted log line is not a reference.
  perl -e 'local $/; my $t = <STDIN> // "";
    $t =~ s/<!--.*?-->//gs; $t =~ s/```.*?```//gs;
    my %s; for ($t =~ /(?<![\w\/])#(\d{1,7})\b/g) { $s{$_+0} = 1 }
    print "$_\n" for sort { $a <=> $b } keys %s'
}

# The open task/issue-N PRs and remote task/issue-N branches for ONE issue, as "pr #P (head)" / "branch name" lines.
_guard_agent_work_for() { # _guard_agent_work_for N OPEN_PRS_JSON WITH_BRANCHES(0|1)
  local n="$1" prs="$2" with_branches="$3" refs
  jq -r --arg e "task/issue-${n}" --arg p "task/issue-${n}-" \
    '.[] | select(.headRefName == $e or (.headRefName | startswith($p))) | "open PR #\(.number) (\(.headRefName))"' <<<"$prs"
  if [[ "$with_branches" == 1 ]]; then
    refs="$(gh api "repos/${REPO}/git/matching-refs/heads/task/issue-${n}" --jq '.[].ref' 2>/dev/null)" || return 2
    # matching-refs is a prefix match: task/issue-11 also returns task/issue-115. Keep exact and "-slug" forms only.
    while IFS= read -r ref; do
      [[ -z "$ref" ]] && continue
      ref="${ref#refs/heads/}"
      [[ "$ref" == "task/issue-${n}" || "$ref" == "task/issue-${n}-"* ]] && printf 'remote branch %s\n' "$ref"
    done <<<"$refs"
  fi
  return 0
}

guard_issue_conflict() {
  local issue="$1" body="$2" prs found n labels rc=0 reasons=""
  prs="$(gh pr list --repo "$REPO" --state open --limit 200 --json number,headRefName 2>/dev/null)" || return 2
  [[ -n "$prs" ]] || prs="[]"

  # The issue itself: only an OPEN PR blocks. A spec run's branch task/issue-N (carrying the locked test) and a retry's
  # leftover branch are normal for the issue's own dispatch.
  found="$(_guard_agent_work_for "$issue" "$prs" 0)" || return 2
  [[ -n "$found" ]] && reasons+="#${issue} already has ${found//$'\n'/; }"$'\n'

  if [[ -z "${FORCE_ISSUE:-}" ]]; then
    while IFS= read -r n; do
      [[ -z "$n" || "$n" == "$issue" ]] && continue
      found="$(_guard_agent_work_for "$n" "$prs" 1)" || rc=2
      [[ -n "$found" ]] && reasons+="the brief points at #${n}, which already has ${found//$'\n'/; }"$'\n'
      # A referenced number that is not an issue (a PR, a typo) simply has no labels: no verdict from it.
      labels="$(gh issue view "$n" --repo "$REPO" --json labels --jq '[.labels[].name] | join(",")' 2>/dev/null)" || continue
      case ",${labels}," in
        *,agent:working,*|*,agent:review,*) reasons+="the brief points at #${n}, which is ${labels//,/ } (an agent holds it)"$'\n' ;;
      esac
    done < <(guard_issue_refs <<<"$body")
  fi

  if [[ -n "$reasons" ]]; then
    reasons="${reasons%$'\n'}"
    printf '%s' "${reasons//$'\n'/; }"
    return 0
  fi
  [[ "$rc" -eq 2 ]] && return 2
  return 1
}

guard_after_pr() {
  local pr="$1" target="$2" info state base draft merged
  info="$(gh pr view "$pr" --repo "$REPO" --json state,baseRefName,isDraft 2>/dev/null)" || {
    echo "could not read PR #${pr}"; return 1; }
  state="$(jq -r .state <<<"$info")"; base="$(jq -r .baseRefName <<<"$info")"; draft="$(jq -r .isDraft <<<"$info")"
  merged=0; [[ "$state" == MERGED ]] && merged=1
  if [[ "$merged" -eq 1 ]]; then
    echo "PR #${pr} was MERGED into ${base} by the agent run"
    return 2
  fi
  if [[ "$base" != "$target" ]]; then
    if guard_forbidden_base "$base"; then
      echo "PR #${pr} was aimed at ${base} (forbidden); retargeting to ${target}"
    else
      echo "PR #${pr} was aimed at ${base}, not ${target}; retargeting"
    fi
    if ! gh pr edit "$pr" --repo "$REPO" --base "$target" >/dev/null 2>&1; then
      echo "could not retarget PR #${pr} to ${target}"
      return 1
    fi
  fi
  if [[ "$draft" != "true" ]]; then
    echo "PR #${pr} was not a draft; put back to draft"
    gh pr ready "$pr" --repo "$REPO" --undo >/dev/null 2>&1 || { echo "could not return PR #${pr} to draft"; return 1; }
  fi
  return 0
}
