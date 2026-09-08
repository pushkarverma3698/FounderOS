# 2026-09-08 — PR queue review, merge, and a deploy-break recovery

## What we did

Founder asked for a full sweep: review every open branch (Antigravity's and Claude's),
manually test each, combine into mergeable state, and merge everything into `main` with
evidence. Started with reconnaissance: 9 open PRs total (4 `antigravity/*`, 4 `claude/*`,
1 auto-generated beta-sync). `agy-guard` showed 3 live Antigravity conversations running
(confirmed via `lsof` — the main checkout at `/Users/pushkarverma/Projects/founderos` was
mid-session on `antigravity/feat-dispatch-antigravity-task`, and two other worktrees
holding `claude/feat-nl-finance-board-supply` and `claude/fix-tailor-cv-grounded-vocabulary`
had live `claude`/`node`/`disclaimer` processes attached). Per repo rule #31, did not touch
any of those trees. Worked the 4 Claude PRs instead, in isolated `git worktree add --detach`
checkouts under `/tmp/pr-review/`, never touching a path another session held.

Founder later redirected mid-session: leave Antigravity for now, verify the merged work is
actually deployed. That surfaced a real production incident (below).

## What we fixed

**Merged, in order, each gated fresh in this session (not trusted from CI or the PR body):**

- **#618** `chore: sync beta with main` — beta was 19 commits behind main, which was
  inflating every beta-targeted PR's diff with already-shipped history. Merged first
  (merge commit, matching the existing #616 pattern) so downstream diffs would be honest.
- **#624** `chore(scripts): remove stale VPS MCP deploy/status scripts` → beta. True diff
  after the sync: 3 files, 262 deletions, 0 additions — confirmed both scripts were
  reachable only from two doc lines and each other, nothing live. Branch protection's
  `strict: true` demanded an update after #618 landed; merged main into it, re-gated
  (346 files / 3800 tests), pushed, squash-merged.
- **#625** `docs(vps-mcp): rewrite VPS-MCP-SETUP.md` → beta (retargeted from its original
  stacked base once #624 merged). The squash-merge of #624 orphaned this branch's diff
  (GitHub can't see that beta already has an equivalent change under a different SHA) —
  diff temporarily reinflated to 541 deletions. Merged beta in directly (not rebase, to
  avoid any force-push), resolved the one real conflict in `VPS-MCP-SETUP.md` by taking
  the full rewrite (beta's side was the file's stale pre-rewrite content, confirmed by
  diffing the two — nothing of value on beta's side), re-gated (346/3800), merged.
  Independently verified its two live claims against prod directly over SSH:
  `/home/founderos/.mcp.json` does not exist, and `founderos.service`'s `ExecStart` is a
  plain `pnpm start` — both exactly as claimed.
- **#634** `fix(jobhunt): close the vocabulary that let tailor_cv fabricate skills` → main.
  Read the actual mechanism, not just the PR body: independently grepped
  `cv-claim-guard.ts:134` and confirmed `verifyCvClaims` really does check against the
  default "tech" skills dictionary regardless of profile — which is exactly why
  `tailorCv`'s new `permittedTerms` union (profile dictionary + default) is necessary and
  is safe by construction (both operands are extracted from the base CV text, so the
  union can't admit anything not truthfully on the CV). The one-repair-round re-verifies
  through the same, unmodified guard — confirmed no relaxation. Hit a real merge conflict
  with #637 (both bump the same "Scale, if asked" line in `INTERVIEW-BRIEF.md` —
  345→346 source files vs. 1,297→1,312 boards); resolved by combining both numbers.
  Re-gated after conflict resolution (347/3823), pushed, merged.
- **#637** `feat(jobhunt): widen board supply for the NL finance lane` → main. Verified the
  core data claims live, not just from the PR's own numbers: hit the actual ATS endpoints
  myself. Deloitte Netherlands (SmartRecruiters) returned 673 real postings. Rabobank
  (Workday) returned 213. The `stripSiteSuffix` fix's specific claim — that
  `nngroup/wd3/external` is dead (0 postings) while `nngroup/wd3/wdexternal` is the real
  board — checked out exactly: the old token returned 0, the new one returned 202, and its
  very first result was literally "Senior Financial Control Specialist | The Hague," the
  same example cited in the PR body.

**Then found and fixed a live production incident**, once asked to verify the deploy:

- Both post-merge `Deploy` runs on `main` had failed (`gh run list --branch main`), silently
  — main had been stuck on the pre-merge commit since 16:44 that day while CI stayed green,
  the exact "CD silently failing" failure mode this repo's CLAUDE.md names explicitly.
- Root cause, from the failed run's log: `tsc --noEmit` failed on
  `scripts/dump-chat.ts(117,16)` — a file that **does not exist on `main` at all**.
  SSH'd into `/opt/founderos` and found four untracked items sitting in the deploy tree:
  `repro-ashby-dist.mjs`, `scripts/dump-chat.ts`, `scripts/ingest_blueprint.mjs`, and a
  `secrets/` directory. `scripts/dump-chat.ts` matches a commit
  (`3be39e5 fix(telegram): audit chat links...`) that only exists on Antigravity's unmerged
  `antigravity/fix-telegram-chat-audit` branch — someone had manually placed it on the VPS
  for one-off debugging and never cleaned it up. Because `deploy.sh` does
  `git checkout --force --detach origin/main` (which resets tracked files but never touches
  untracked ones), this stray `.ts` file has been sitting there ready to fail `tsc`'s
  whole-project type-check on the next deploy that happened to trigger it.
- Checked `secrets/google-vertex-sa.json` before touching anything near it: it's real,
  load-bearing credential material (600 perms, actively refreshed by
  `apply-prod-env-overrides.sh` on every deploy per the deploy log's own
  "Patched .env: GOOGLE_APPLICATION_CREDENTIALS refreshed" line) — left it untouched.
  Confirmed via crontab/systemd/`ps` that nothing on the box invokes the other three stray
  files by path, then removed just those three. `pnpm lint` on the VPS went clean
  immediately after.
- Manually re-triggered `Deploy` (`workflow_dispatch`, since `main` had no new commit to
  re-trigger it automatically) and watched it to completion.

## Why

CLAUDE.md rule #24 (evidence over assertion) and the founder's own instruction this
session ("measurements and evidence are needed for the things working and done") — a
green PR check and a green merge are not a shipped fix. The deploy failure is the textbook
case this rule exists for: every unit test passed, CI was green, the merge succeeded, and
production was still running yesterday's code.

## Metrics

- 4 Claude PRs + 1 beta-sync merged: #618, #624, #625 → `beta`; #634, #637 → `main`.
- Each re-gated fresh in an isolated worktree in this session (not reused from CI):
  #624 → 346 files/3800 tests, #625 → 346/3800, #634 → 347/3823 (post-conflict-resolution),
  #637 → 346/3812. All exit 0.
- Live, non-LLM verification performed directly against prod/VPS (not asserted from the
  PR bodies): 2 VPS infra claims (#625), 4 live ATS endpoint checks (#637, including the
  exact NN Group before/after), 1 source-code grep confirming the dictionary-union
  mechanism in #634 is necessary and safe.
- Deploy: two silent failures (21:31, 21:39/21:40) before the fix; VPS drift cleared;
  `workflow_dispatch` re-run succeeded in 1m29s. `founderos.service`
  `ActiveEnterTimestamp` = `2026-09-07 21:53:38 UTC`, correlated against the deploy run's
  own timing (not a stale `git rev-parse HEAD`). Confirmed the actual fix content is live
  in the compiled output the process loads: `dist/src/tools/jobhunt/tailor-cv.js` contains
  "PERMITTED TECHNOLOGY VOCABULARY" (2 occurrences), and `free-ats-boards.csv` on disk has
  1,313 lines (1,312 boards + header), matching #637's claimed registry growth. Live logs
  show the restarted process serving real Telegram traffic cleanly within seconds of boot.

## Outstanding

- **Antigravity's 4 PRs not yet reviewed** (#632 fix-telegram-chat-audit, #633
  feat-ats-pipeline-scale, #635/#636 feat-dispatch-antigravity-task — #636 duplicates #635
  targeting `main` directly, which violates this repo's "Antigravity always → beta" rule
  and needs a decision). #633 showed real CI test failures (`Unit + regression tests`:
  FAILURE) as of the last check before Antigravity's live session started — worth
  rechecking once quiet, since the live session may already be addressing it. Founder
  explicitly deferred this: "leave for antigravity for now."
- **Beta and main have re-diverged by design**: beta has #624+#625 that main lacks; main
  has #634+#637 that beta lacks. A fresh `chore: sync beta with main` PR (#638) was
  auto-generated after the #634/#637 merges — intentionally left unmerged, to fold in with
  whatever Antigravity's beta-targeted PRs add, rather than syncing multiple times.
  Whoever finishes the Antigravity review should merge #638 as part of the final
  reconciliation, not before.
- **The VPS deploy-tree drift is a recurring risk, not a one-time fix**: nothing prevents
  another manually-placed debug file from breaking the next deploy the same way. Not fixed
  here (would mean editing `deploy.sh` or the CI workflow, out of scope for "get today's
  merges deployed") — flagged as a candidate for a `git clean -fdx --dry-run` pre-flight
  check in `deploy.sh`, or a CI step that fails loudly on unexpected untracked files before
  the type-check ever runs, so the failure names the real cause instead of a confusing
  unrelated-looking `tsc` error on a file that isn't even in the diff.
- **`docs/ROADMAP.md`'s "Free ATS boards polled | **1,297**" table row is stale** (should
  be 1,312) and structurally unreachable by `verify-doc-claims.ts`'s regex
  (`/\b(\d[\d,]*) (ATS )?boards\b/`-style patterns expect the number to precede or
  immediately follow "boards"; this row's phrasing is "boards polled | **N**", which
  neither pattern matches). Predates both #634 and #637 — not fixed here to avoid scope
  creep on an unrelated merge-conflict resolution.
