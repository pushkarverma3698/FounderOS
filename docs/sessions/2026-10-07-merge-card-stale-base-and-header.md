# 2026-10-07: the merge card names its PR, and a moved beta no longer strands it

Moves: A. Two seams left after #982/#983, both found by reading code (session doc
`2026-10-07-pipeline-merge-card-seams.md` on PR #984).

## What we fixed

1. **The card did not name its PR (rule #26).** `renderEvidenceCard` now opens with
   `Evidence for owner/repo#PR (issue #N): <title>`. `EvidenceCardInput.subject` carries it;
   `scripts/pipeline-evidence-card.ts` reads the title from the PR it already fetches.
2. **A tap after beta moved dead-ended.** `canMerge` refused on `baseAtReview !== baseNow` and promised a
   fresh card, but pr-brain skips a PR already gated at its head, so none came.
   - Beta has `strict: true` required checks, so "re-run evidence and send a fresh card" is not enough:
     GitHub would refuse the merge on the stale branch anyway.
   - Fix: when the base is the only thing that moved (same canMerge, base pinned to the record's own),
     the tap calls `updateBranch` (GitHub's update-branch, pinned to the head the card showed). The new head
     reruns CI; pr-brain's existing carry-forward path (`only_our_commits_since`) re-stamps it, and
     `merge_or_card` builds a fresh card without a second review.
   - pr-brain: in the carry-forward branch, a pipeline PR (`task/issue-*`, `AGENT_PIPELINE_V2=1`) whose required
     CI is still pending is left unstamped, so the card is not built on UNKNOWN evidence and the next sweep retries.
   - A head move, a non-APPROVE review, or failing evidence still refuse with no update.

## Strongest argument against

The tap now writes to the PR branch (a merge commit from beta) on a button labelled "merge". The mitigation: it
only runs after the founder tapped, only when nothing else is wrong, it is pinned to the reviewed head
(`expected_head_sha`), and the message says plainly that nothing was merged. The cheaper alternative (tell the
founder to ask for a re-review) leaves the PR stuck until someone else notices.

## Left to know

- With pr-brain off (`~founderos/.claude/pr-brain.off`), the fresh card does not come after the update until it is
  on again. The tap message says so.
- Not run live: a real tap against GitHub's update-branch, and a real sweep of pr-brain. Both are covered offline
  (chain e2e, bash carry-forward harness).
