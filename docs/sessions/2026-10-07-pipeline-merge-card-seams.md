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

## Left open

- The daemons' GitHub token cannot see OplifyMessage: 600 "Could not resolve to a Repository" lines
  since 10-06 11:00Z, and no alert. The founder has to issue a token; a fine-grained token covers
  one owner.
- The planner filed junk Oplify issue #83 for work PR #81 had already done, and said an agent had
  claimed it. Not fixed here.
- pr-brain is off (the founder's `/review`, 10-07 10:40Z). Until it is back on, nothing sends cards
  on its own.
