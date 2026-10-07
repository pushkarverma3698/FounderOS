# shellcheck shell=bash
#
# pr-moves.sh — an agent PR names the outcome it moves, so the "PR scope (freeze + Moves)" check is not red for a line
# the agent forgot (#965, 2026-10-06: a pipeline PR was red only because its body had no `Moves:` line).
# SOURCED by deploy/agent-dispatch. Flag-independent: every agent PR, legacy or pipeline.
#
#   pr_body_has_moves < BODY   exit 0 when the body names a move scripts/verify-pr-scope.ts parseMoves accepts:
#                              HTML comments stripped, the FIRST `Moves:` line, a token A|B|C|D|crash-fix|unfreeze.
#                              tests/unit/scripts/pr-moves-line.test.ts runs both on the same bodies; keep them equal.
#                              Exit 1 = no move; any other exit is not an answer and changes nothing.
#   ensure_moves_line PR       a PR in a repo with that check ($WORKSPACE/scripts/verify-pr-scope.ts) whose body names no
#                              move gets `Moves: A` as its first line. A is the coding loop, which every agent PR is part
#                              of; the founder can change it. Other repos (Oplify) are left alone. Never fails the caller.
#
# NEEDS FROM THE SOURCING SCRIPT: log, gh, as_antigravity, REPO, WORKSPACE.

pr_body_has_moves() {
  perl -e 'local $/; my $b = <STDIN> // "";
    $b =~ s/<!--.*?-->//gs;
    if ($b =~ /^\s*moves\s*:\s*(.+)$/im) { for (split /[\s,\/|]+/, $1) { exit 0 if /^(?:[abcd]|crash-fix|unfreeze)$/i } }
    exit 1'
}

ensure_moves_line() {
  local pr="$1" body
  as_antigravity 'test -f "$1/scripts/verify-pr-scope.ts"' "$WORKSPACE" >/dev/null 2>&1 || return 0
  # An unread body is left alone: writing `Moves: A` over it would erase the agent's evidence.
  if ! body="$(gh pr view "$pr" --repo "$REPO" --json body --jq .body 2>/dev/null)"; then
    log "WARNING: could not read PR #${pr}'s body to check its Moves line — the PR scope check may be red. Fix: add 'Moves: A' to the PR body"
    return 0
  fi
  local rc=0
  pr_body_has_moves <<<"$body" || rc=$?
  [[ "$rc" -eq 0 ]] && return 0
  # 1 = no move named. Anything else (perl missing, a crash) is not an answer: never stack a second Moves line on a guess.
  if [[ "$rc" -ne 1 ]]; then
    log "WARNING: could not check PR #${pr}'s Moves line (exit ${rc}) — left as is. Fix: make sure perl is installed"
    return 0
  fi
  if gh pr edit "$pr" --repo "$REPO" --body "Moves: A${body:+$'\n\n'$body}" >/dev/null 2>&1; then
    log "PR #${pr} named no move — added 'Moves: A' for the PR scope check"
  else
    log "WARNING: PR #${pr} names no move and its body could not be edited — the PR scope check stays red. Fix: add 'Moves: A' to the PR body"
  fi
  return 0
}
