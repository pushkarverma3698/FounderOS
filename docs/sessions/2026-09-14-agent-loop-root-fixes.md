# 2026-09-14 — Agent loop + judge-monitor root-cause fixes

## What we did

Senior-QA pass over production logs and the Claude↔Antigravity agent loop,
requested directly (not a scheduled audit). Read `founderos-vps` journald (7
days), both daemon logs (`pr-brain.log` 7428 lines, `agent-dispatch.log`
3216+ ticks), GitHub PR/issue state, and ran the two tests `pr-brain` had
excused as "pre-existing failures" against a clean `main` checkout.

Found 5 real bugs (one of the 5 turned out to be misdiagnosed on first pass —
corrected below, not just patched over). Branched `claude/fix-agent-loop-judge-blindspots`
off `main` and root-caused each with a failing test first, per repo TDD rule.

## What we fixed

1. **`judgeAnswer` never fed the judge-outage monitor.** Only `judgeOutbound`
   called `recordJudgeFailure`/`recordJudgeSuccess`. Every real judge outage
   in prod since 2026-09-07 (17 occurrences) came through `judgeAnswer`, so
   the monitor built 2026-09-08 specifically to end silent judge failures was
   blind to the one path that kept failing — zero outage alerts ever fired.
   Wired identically to `judgeOutbound`, `log.warn` → `log.error` to match.
   ([src/infra/judge.ts](../../src/infra/judge.ts))

2. **Root cause of the "Cannot read properties of undefined (reading
   'message')" prod incidents** (2026-09-08T07:29, 2026-09-10T12:50): both
   `judge.ts` catch blocks did `(err as Error).message` — an unsafe cast.
   LangChain's OpenAI-compatible client can reject with a non-Error value;
   reading `.message` off that crashes the error HANDLER itself, silently
   replacing the real judge-outage reason with a TypeError. This was
   misdiagnosed at the time as "the free slug died again." Added a safe
   `errorMessage()` helper, used only in `judge.ts` (190 occurrences of the
   same unsafe-cast pattern exist across 68 other files — out of scope for
   this fix, flagged separately, see Outstanding).

3. **Two source files were binary to grep, ripgrep, AND `git grep`.**
   `src/infra/judge.ts` and `src/tools/gap-scan-insights.ts` each had a
   literal NUL byte (0x00) in a template-literal cache-key separator instead
   of the intended `\0` escape sequence. This is not cosmetic: it made both
   files invisible to Claude Code's own Grep tool and to Antigravity's
   search mid-session (hit live during this audit — a grep falsely reported
   the judge-health recorders had no callers). Fixed with a byte-level
   script; runtime behavior is unchanged.

4. **Two independent, disagreeing defaults for the judge model.**
   `src/infra/judge-model.ts` defaulted to `nemotron-3-super-120b-a12b:free`
   (confirmed live against a fresh `GET /api/v1/models`); `scripts/lib/content-judge.ts`
   had drifted to `minimax/minimax-m2.7:free`, which OpenRouter has in fact
   withdrawn. Realigned to one default; comment now says the two files must
   never disagree again.

5. **`pr-brain` had no merge step.** `dispatch-antigravity.ts`'s own header
   comment documents the pipeline as ending "pr-brain (Claude review) →
   Merge" — that arrow never existed in code. GitHub blocks self-approval on
   same-account PRs, so the pass signal is draft→ready, and nothing after
   that ever merged anything. PRs #671/#672/#673 sat CLEARED, all CI green,
   mergeable, for 4 days. Fixed: on a CLEARED verdict, `pr-brain` now
   attempts `gh pr merge --squash` (never into main/master — pr-adversary's
   own hard limit), and if `beta`'s `strict` branch-protection refuses
   because the branch is behind, runs `gh pr update-branch` and lets the
   existing marker-comment cycle re-gate and retry on the next sweep rather
   than blocking on a synchronous CI wait inside a cron tick.

6. **`pr-brain`'s review checkout accumulated dirt and produced a false
   pass.** `/opt/review/founderos` was never reset between sweeps. A prior
   gate that crashed, timed out, or ran `git stash -u` without dropping it
   left the tree dirty for every future sweep — live-found sitting on a
   stale PR branch with 2 orphaned stashes. `pnpm test` then failed on files
   the DIRT introduced, and got excused in real review comments as
   "pre-existing failures, not this PR's responsibility." Verified live: both
   named tests pass cleanly on `main`, 31/31. Fixed with an unconditional
   `git reset --hard && git clean -fdq && git stash clear` at the top of
   every repo's sweep, mirroring the self-heal `agent-dispatch`'s own
   workspace already had.

7. **Bonus, same subsystem:** `agent-dispatch` branched every new task from
   `origin/main` while every PR it opens targets `beta` — so every fresh PR
   started life already "BEHIND" its own base by construction (not
   occasionally; every time). This is why all 3 stuck PRs showed
   `mergeStateStatus: BEHIND`. New `AGENT_DISPATCH_BASE_BRANCH` env var
   (default `beta`) used for both the branch-creation checkout and the
   new-commits diff.

**Also, for the first time:** `deploy/vps-daemons/{pr-brain,agent-dispatch}`
brought under version control. Until today these existed ONLY as hand-edited
files in `~/bin/` on `founderos-vps` — no git history, no PR review, no
rollback, no diff between "what's running" and "what was intended." That gap
is not cosmetic: it is why bugs 5 and 6 went undetected for as long as they
did — nothing ever diffed the deployed script against a known-good version.
See [deploy/vps-daemons/README.md](../../deploy/vps-daemons/README.md) for
the daemon map and the (still-manual) deploy step.

## Why

CLAUDE.md rule #25 (deep-ideate, self-critique) and rule #33 (accept valid
feedback from other AIs after verification) both apply here in an unusual
direction: the "other AI" being audited was the system's own automation, and
the first-pass diagnosis of bug 4 (judge model "dead") was itself wrong —
corrected by tracing the actual stack trace rather than trusting the
existing code comments' own historical narrative, which had accumulated
three plausible-sounding but unverified "the free slug died again" entries.
Two of those three were real; one was this bug hiding behind a coincidence
in symptom text.

## Metrics

- Judge outage alerts fired in the 14 days before this fix: **0**
- Judge failures that should have alerted: **17** (2026-09-07 through
  2026-09-10, all through `judgeAnswer`)
- PRs stuck CLEARED-but-unmerged before this fix: **3** (#671, #672, #673),
  4 days
- Orphaned stashes found in the live review checkout: **2**
- `pr-brain` sweeps that logged "already gated — skipped" against the 3
  stuck PRs before this fix landed: **873**
- Files invisible to grep/ripgrep/git-grep before this fix: **2**
  (`src/infra/judge.ts`, `src/tools/gap-scan-insights.ts`)
- Unsafe `(err as Error).message` casts fixed: **2** (both in `judge.ts`);
  **190** of the same pattern remain across 68 other files, out of scope

## Verification

```
npx vitest run tests/unit/infra/judge-health.test.ts tests/unit/infra/answer-eval.test.ts tests/unit/scripts/content-judge.test.ts
  -> 3 files, 36 tests, all passing (new tests confirmed RED before each fix)
bash -n deploy/vps-daemons/pr-brain / agent-dispatch  -> syntax OK
```

Live, real-world verification of the deployed fix (not a simulation):
- Applied the exact reset sequence to the live, dirty `/opt/review/founderos`
  checkout — confirmed it cleaned 2 orphaned stashes and a stale branch to a
  fully clean tree.
- Deployed both fixed scripts to `founderos-vps:~/bin/` — sha256 confirmed
  matching the repo copy.
- Ran the exact merge logic the fixed script now runs against the 3 real
  stuck PRs: immediate `gh pr merge --squash` correctly failed on all 3 (base
  branch protection is `strict`, and the branches were genuinely behind —
  this was NOT anticipated in the first version of the fix and was corrected
  before merging, see commit history on this branch), then `gh pr
  update-branch` correctly succeeded on all 3.
- **All 3 PRs are now actually merged to `beta`**: #671 (12:38 UTC), #672
  (12:43 UTC), #673 (12:47 UTC). Discovered en route: because all 3 share
  `beta` as their base and `beta` has `strict` protection, merging PR N
  re-invalidates every other open PR against the same base (their branch is
  now behind the NEW tip) — #672 and #673 each needed a **second**
  `update-branch` round after #671 (then #672) landed, not just one. The
  deployed fix's "defer to the next sweep" design handles this correctly by
  construction — each deferred PR just re-enters the normal gate cycle and
  gets re-merged once current — it's simply bounded by the 20-minute cron
  interval per round instead of the few minutes of manual polling used here.
  With 3 PRs sharing one base, a real sweep would take up to ~3 cron ticks
  (~60 min) to drain the whole queue; documented in Outstanding below rather
  than built around, since it's correct, just not the fastest possible.

## Outstanding

1. Deploying a change to `deploy/vps-daemons/*` still requires a manual
   `scp` + `chmod` to `founderos-vps:~/bin/` — the crontab runs the file
   there, not a checkout of this repo. Known gap, not fixed here (see the
   README). A future improvement would be a small deploy step triggered on
   merge to `main`.
2. The unsafe `(err as Error).message` cast pattern (190 occurrences, 68
   files) is systemic, not judge-specific. Flagged as a separate follow-up
   task rather than fixed here — fixing it properly touches most of the
   codebase and was not part of what broke in this incident.
3. This was not driven through real Telegram end-to-end (repo rule #24
   "gateway means the real transport") — the judge fixes were verified via
   unit tests and the agent-loop fixes via live `gh`/`git` commands against
   the actual VPS and the actual stuck PRs, which is the correct verification
   surface for an ops/infra fix, but is a different claim than "a founder
   message through the bot now behaves differently."
4. When N open PRs share one `strict`-protected base, draining the queue
   takes up to N cron ticks (~20 min each) because each merge re-invalidates
   the rest. Correct, not fast. If this becomes a real bottleneck (it was not
   today — 3 PRs, manually drained in ~10 min), the fix is polling with a
   bounded timeout inside a single sweep rather than always deferring to the
   next tick — not built here since 3 PRs was not that bottleneck.
