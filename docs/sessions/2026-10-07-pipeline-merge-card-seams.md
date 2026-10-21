# 2026-10-07: why PR #974 never got a merge card

Founder's ask: audit the coding pipeline, its context and three days of Telegram chat, find why a
simple fix never lands, and fix it at the root. The audit is
[docs/audits/2026-10-07-coding-pipeline-audit.md](../audits/2026-10-07-coding-pipeline-audit.md).

## The two bugs (fixed in #982, promoted in #983)

1. **The contract key was case-sensitive.** Pass P stored `pushkarverma3698__FounderOS__972.json`
   (GitHub's spelling). pr-brain asks for `pushkarverma3698/founderos`, the name of its checkout dir
   `/opt/review/founderos`. The lookup said NONE, `ec_run` treated #974 as a legacy PR, and
   `PR_BRAIN_MERGE=0` turned that into "a human merges" with no button.
   Fix: `contractFileName` lowercases the key, reads fall back to the old exact-case name, and the
   repo check compares case-insensitively (`src/tools/contract-store.ts`).
2. **The locked test counted against the executor's limits.** Pass P's 56-line locked test pushed a
   1-line fix over the 1 file / 20 line budget. Fix: `verifyImplementationGreen` skips locked-test
   files when counting (`src/tools/pr-evidence.ts`). The locked test is still pinned by hash.

## Proof

- Before the fix, on prod's copy of the #972 contract: `--repo pushkarverma3698/founderos` gave
  NONE; the exact casing gave CARD with `mergeable:false` and the limits check FAILING.
- After the fix, locally against the real PR #974 at head 79a8ff9e: CARD, `mergeable:true`, all four
  checks PASS, an ack-merge button.
- The offline chain test (`tests/unit/tools/pipeline-chain-e2e.test.ts`) now spells the repo the
  way pr-brain does. It fails on the old code (4 of 6 tests) and passes on the new one.

## On prod

- #983 deployed 10-07 12:47Z (67204008); `/opt/founderos` code and `~/bin/lib` match the repo.
- The two contract files written before the fix were copied to lowercase names, byte-identical.
- A dry run of the deployed card step against a throwaway contracts dir gave CARD, `mergeable:true`.
- The real card went out by hand at 12:52Z (pr-brain is off): Telegram message 11683, merge record
  `MesXX0gez48TIEUb.json`, base pinned at beta dd6da94b.

## Later on 10-07: #974 merged, and three more seams

PR #974 (`list_issues` excludes PRs) merged into beta at 14:12Z as 99c08887, through the real path:
Telegram evidence card, a tap (Claude sent it through the MTProto tester), GitHub squash merge. The
gateway log shows "Coding pipeline: merged".

It took more than the two bugs above. Three more seams showed up on the way:

1. **A hand run of `pr-brain --pr N` had an empty `head_ref`.** `ec_issue_of` takes the branch name,
   found no issue number in an empty string, and the PR silently took the legacy no-card path.
   Fixed in #989.
2. **Beta is strict, so every beta merge strands the other open PRs.** Beta requires branches to be
   up to date, and CI takes about 7 minutes, so each merge into beta pushes every other open PR
   BEHIND. A card is bound to the beta SHA it was made against. The first #974 card (pinned at beta
   dd6da94b) was refused after beta moved; #985 merged into beta at 13:22Z. `gh pr update-branch 974`,
   a CI rerun and a new card fixed it by hand. #988 makes the tap call update-branch, pinned to the
   reviewed head, instead of refusing. #988 also puts the PR name on the card.
3. **The OplifyMessage repos were invisible to the daemons from 10-06 ~11:00Z.** The token was a
   fine-grained, single-owner PAT. The founder swapped it 10-07 between 13:00Z and 13:15Z. At 13:16Z
   the dispatcher picked up Oplify issue #83 and ran spec pass P on it (outcome not checked here).

## Decisions

- The founder decided on 10-07 to replace the cron daemons and labels with direct runs, in three PRs.
  PR 1 is #990 (`fos-job.socket`, draft). That plan replaces the alert PR #987, which was closed as
  superseded: the founder rejected detect-and-alert patches.
- Option A (canary) over option B (LangGraph coding graph), from the audit. The orchestrator chose A on
  the founder's "use your intelligence" instruction. Journey A (`scripts/journey-coding.ts`) already
  runs a canary on `pushkarverma3698/fos-journey-sandbox` every 3 nights from the VPS crontab
  (`0 3 */3 * *`) and was GREEN on 10-04 and 10-07. B would duplicate the direct-run plan.

## Left open

- #988 and #989 are open (#988 is a draft). Until they merge, a beta move between card and tap
  still strands the card, and a hand-run `pr-brain --pr N` still skips the card.
- #990 is PR 1 of 3 and is a draft.
- The planner filed junk Oplify issue #83 for work PR #81 had already done and said an agent had
  claimed it. #985 (merged 13:22Z) makes a request naming an existing issue read it first.
- pr-brain was off (the founder's `/review`, 10-07 10:40Z). Not re-checked after that.
