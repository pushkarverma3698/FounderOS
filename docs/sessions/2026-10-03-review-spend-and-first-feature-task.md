# 2026-10-03 — review spend fixed, auto-merge off, and the first feature-sized task through the loop

## What we did

The founder asked three things: switch pr-brain's auto-merge off, say whether FounderOS can handle real tasks "on the go", and say whether review tokens are being wasted. Then: test with a real task, cover the edge cases, fix the leaks, do the PR work.

1. **Auto-merge off.** `PR_BRAIN_MERGE=0` on the pr-brain crontab line (VPS). Only pr-brain merges or promotes, so this stops both. Cleared PRs stay ready and the founder merges.
2. **A real task, from Telegram, as the founder** (`scripts/telegram-tester.ts`, MTProto): `/task add a Ready for you to merge section to /tasks …`, in plain English, no repo syntax.

   | Step | Evidence (UTC) |
   |---|---|
   | repo buttons → approval card | 06:43:07 → 06:44:04, card shows Goal / Expected / Files / Verify |
   | Approve → issue #801 → claimed | 06:44:38 → 06:45:04 (26 s) |
   | Antigravity implements | 06:45:09 → 07:11:52, 26 m 43 s, 142 tool calls, `gemini-3.6-flash-medium` |
   | draft PR #803 to `beta` | 256 additions, 2 files, CI green; PR body has What changed / How verified / NOT VERIFIED |
   | review | blocked by a reviewer outage (below), then `claude-sonnet-5-5-medium`, 1 m 47 s, `BRAIN-VERDICT: PASS` |
   | merge | withheld by `PR_BRAIN_MERGE=0`: "CLEARED … a human merges" |

   The review's non-blockers match what a hostile read finds: the PR deleted the ~24-line "WHY IT EXISTS" header of `tasks-command.ts` (unrelated to the task; to stay under the 400-line budget), `isGreenCI` treats "no checks at all" as green, and PR comments are read without pagination.
3. **Audit of review spend**, then four fixes (PR #804, promoted by #805, deployed).
4. **A live drill of the new red-CI path** (issue #806, PR #807, a throwaway test that fails on purpose), all on the real loop:

   | Time (UTC) | What happened |
   |---|---|
   | 07:51 | CI red on the head (`Unit + regression tests`) |
   | 08:00:06 | pr-brain: `required CI is red (Unit + regression tests) — no review spent` |
   | 08:00:08 | agent-dispatch: `required CI is red … so pr-brain spends no review on it — re-dispatching Antigravity (attempt 1)` |
   | 08:06:38 | Telegram: `re-dispatched Antigravity on PR #807 (attempt 1/3): pushed fbad258a` (it deleted the failing file) |
   | 08:20 | CI green → pr-brain reviewed the new head in 25 s → `REVIEWED, left as draft — not cleared` (the diff was empty) |

   Closed unmerged afterwards.

## What we fixed

1. **Promotion PRs were fully reviewed** (Oplify api#60 and app#41, ~4 min each) against the "no re-review on a promotion" rule. Head branches `beta`, `main`, `master`, `chore/promote-*` are skipped.
2. **Red CI was reviewed** (founderos#791 on four heads while "Unit + regression tests" failed). pr-brain skips a head whose *required* CI is red; agent-dispatch Pass B now also sends the executor back on a draft with a red required check and no review (the skipped head is never stamped, so the old Pass B would have stranded it). CI still running waits up to 4 sweeps. CI that cannot be read is reviewed, as before. Shared by both daemons in `deploy/lib/ci-state.sh`.
3. **No bound on total reviews.** `PR_BRAIN_DAILY_MAX` (20 per 24 h, `0` = off), one notice a day.
4. **The reviewer paused itself at 07:00 UTC** because `claude-sonnet-4-6` is no longer in agy's catalog (`error: invalid model selection … is not recognized as a known model`, exit 1, catalog printed). The preflight read it as an outage while `gemini-3.1-pro-high` still answered. An unknown name is now skipped like a spent model and reported once; the default is `claude-sonnet-5-5-medium`. Downtime 07:00 → 07:40 (the 07:20 sweep was still paused). A parallel session added a `PR_BRAIN_MODELS` override to the crontab at 07:22 as a stopgap, and the deploy of this fix landed at 07:38; both were in place for the 07:40 sweep, which resumed it (announced 07:42).

## Why

The founder wants the phone to be enough. That needs the loop to (a) not burn the one shared Gemini window on reviews that cannot change the outcome, and (b) not stop silently when a vendor renames a model. Auto-merge stays off because the founder merges once a day.

## Metrics

- Feature task: phone → card 57 s, claim 26 s, executor 26 m 43 s (the 30-minute cap is close: 6 m 36 s of it was the executor's own full `pnpm test`), review 1 m 47 s.
- Reviewer on Sonnet 5.5: 1 m 47 s (#803), 47 s (#802, docs only), 2 m 27 s (#804); on Gemini 3.1 Pro the 10-02 reviews took 3–10 min.
- Tests: 22 of 24 new pr-brain tests failed before the code; 3 of 10 new agent-dispatch tests fail against the old daemon. Whole suite on Linux: 517 files / 6,915 tests. Script tests on the final tree: 33 files / 715.
- Red-CI drill: skip → executor sent back → fix pushed in 6 m 30 s → reviewed once CI was green.
- Deploy: `sha256` of `~/bin/{pr-brain,agent-dispatch,lib/ci-state.sh,lib/agy-failure.sh}` equal the checkout; `/opt/founderos` at the promotion merge.

## Outstanding

- **Executor model drift is not handled.** A retired `AGENT_DISPATCH_MODEL` would still end each issue `agent:failed` one by one. `gemini-3.6-flash-medium` exists today; the catalog already has 3.7 and 3.8.
- **The 30-minute executor cap** (`AGENT_DISPATCH_TIMEOUT_SEC`) is tight for a task with a full test run: 26 m 43 s here. The lease (45 min) leaves room for about 40 min; raise both together.
- **A reviewer's non-blockers go nowhere.** #803 was cleared with "restore the deleted header", and nothing sends that back to the executor. Only a FAIL does.
- **Strict branch protection:** after one PR merges into `beta`, the others are BEHIND and need "Update branch" and a CI run before they merge.
- Pass B still labels any failing check (not only required ones) as "CI failure" in the re-dispatch brief (pre-existing).
- The crontab still carries that stopgap, `PR_BRAIN_MODELS="claude-sonnet-5-5-medium gemini-3.1-pro-high"`, which now equals the code default. Delete it so the default is the single source (otherwise the next catalog change is pinned by a stale cron value; an unknown name is skipped and reported, so it would not pause the reviewer).
