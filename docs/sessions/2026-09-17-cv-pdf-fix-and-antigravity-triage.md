# 2026-09-17 — CV/PDF fix, senior-role backfill, kernel-timeout fix, Antigravity branch triage

## What we did

Founder asked for five things in one message: (1) reproduce and fix the CV-as-PDF failure for
both jobhunt profiles, (2) review and merge whatever Antigravity has fixed, (3) pick up pending
AG docs and fix what's required, (4) find why senior roles still leak through despite a prior fix
and stop it recurring, (5) get FounderOS demo-stable, confirm turicks-brain is the shared RAG.
Dispatched 4 parallel background agents (production/Telegram log audit folded into direct log
queries instead; 5 stale Antigravity branches; 3 fresh "AG-015/016/020" branches; turicks-brain
wiring; pr-brain/agent-dispatch health) while personally root-causing the CV/PDF bug end to end.

## What we fixed

- **CV/PDF bug (item 1) — root cause + fix, live-verified both profiles.** Traced the full path
  (`tailor-cv.ts` → `apply-packet.ts` → `jobhunt-commands.ts`) rather than guessing from the issue
  text. The CV body is locked and pasted verbatim on every tailoring attempt (2026-09-15 change);
  `findSlop()` runs against the whole composed document, so a false positive anywhere in the base
  CV body fails *every* attempt, for *every* role, permanently — not role-specific, contrary to
  the AG-018 brief's own (unverified) "silent degrade" theory, which the actual code doesn't do.
  Real prod log (2026-09-16 17:00 UTC) named the exact two false positives: `"harness"` banned as
  an AI-cliché word but also the standard CS term for a test/eval harness (removed from
  `BANNED_WORDS`); the colon-reveal detector unable to tell a rhetorical "Here's the secret: X"
  from a factual enumeration "Measures X: A, B, C" (fixed by requiring 2+ commas after the colon
  to exempt a list from the reveal check). [PR #697](https://github.com/pushkarverma3698/FounderOS/pull/697),
  regression tests use the real rejected prod text. Live-verified via `scripts/telegram-probe.ts`
  against the real bot for both `/draft 1` (Pushkar, Vattenfall) and `/wife_draft 1` (Tashi,
  Hitachi) post-deploy — both produced a real cover letter, which only fires after
  `buildApplicationPacket` succeeds.
- **Senior-role leakage (item 4) — root cause + fix, live-verified both profiles.** PR #679
  (2026-09-16) shipped the level-gate but its own commit message said the prod backfill was never
  run and `/draft` was never driven through real Telegram. Ran
  `scripts/jobhunt-backfill-gates.ts --profile=<id>` for both profiles: 15 real senior/lead/staff/
  principal-level rows for Pushkar flipped `pass`/`flag` → `reject` (Capital One "Lead Software
  Engineer", Adobe "SDE 4", 4× Genpact "Tech Lead", 2× Renesas "Staff/Principal Engineer", etc.);
  0 changed for Tashi (her queue was already fresher). Found a second, distinct gap: `brief_rank`
  is a cached value from the last ranking pass and isn't invalidated when a row's underlying status
  changes later, so several now-rejected rows still held a live `brief_rank` in `do_today`/`ask`
  until a fresh render recomputes it. Forced that render for both profiles
  (`scripts/jobhunt-brief-only.ts` for Pushkar, an inline `buildDailyBrief({ profile })` call for
  Tashi) — both now show a proper "🚫 TOO SENIOR / TOO JUNIOR" bucket with per-row reasons, and
  genuinely-reachable "Senior"-titled roles (stated years within reach) still correctly surface as
  actionable. No code change needed here — the level-gate itself was already correct; it just had
  never been run against existing data or re-rendered.
- **`docs(process)` — a prior session's unmerged recurring-bug audit shipped.**
  [PR #698](https://github.com/pushkarverma3698/FounderOS/pull/698): 9-theme audit of 2+ months of
  incidents, root-caused why issue #687's Antigravity dispatch failed (4 of 6 "files in scope"
  didn't exist — the brief was never path-verified), split #687 into 6 correctly-scoped AG-014
  through AG-019 briefs, added CLAUDE.md rules #34–36 (done-claims need real command+output
  everywhere, freshness must assert against source not a proxy, every PR/brief must name a
  real-path verification or say NOT VERIFIED). Was sitting unmerged since it predated PR #688;
  confirmed the apparent conflict was pure staleness, rebased clean, zero unintended diff.
- **`scripts/telegram-probe.ts`** — [PR #700](https://github.com/pushkarverma3698/FounderOS/pull/700):
  `TRANSIENT_PREFIXES` didn't include the "📝 Tailoring your CV..." progress message, so the probe
  reported success 30–80s too early on a non-answer. Found and fixed while doing the live
  verification above; without it, the CV/PDF fix could not have been genuinely verified end-to-end.
- **AG-015 (kernel turn-timeout, B5/B6/B7) — the real fix, not Antigravity's partial attempt.**
  [PR #702](https://github.com/pushkarverma3698/FounderOS/pull/702), merged and deployed
  (`ActiveEnterTimestamp` moved to `2026-09-17 07:02:07 UTC`). Three defects from one incident:
  the 300s outer turn-timeout always fired before `claude_code`'s own 15-minute budget could ever
  matter (B5) — fixed by making the deadline touch()-able, reset by real LangGraph state
  transitions AND by a new `configurable.onTurnActivity` channel that lets a single long tool call
  report its own progress as activity, since one graph node can run `claude_code` for its whole
  duration with zero intermediate state; a truly hung run with neither kind of activity still times
  out at 300s unchanged. An outer abort never reached the spawned `claude` CLI child process at all
  (B6) — fixed by threading `RunnableConfig.signal` through as `_signal`. The resume path's phantom
  HITL-approval-row cleanup only ran on success, leaving timeouts orphaned forever (B7) — moved into
  a `finally`, extracted to `resume-artifact-cleanup.ts` since `kernel-run.ts` was at the 400-line
  budget. 9 new tests, `pnpm gate` green throughout. Live verification of the exact failure mode
  (a real 300s+ `claude_code` run) was not run — real token/time cost — flagged honestly as
  NOT VERIFIED live rather than claimed.

## Why

Item 3 and item 5 (Antigravity/pr-brain "working properly", turicks-brain as shared RAG) turned
out to be blocked or already-fine rather than something to build:

- **Antigravity's account hit a subscription quota wall, resets ~2026-09-23.** This is why issue
  #687's dispatch shows `agent:failed` — not a wiring bug. Confirmed via the actual VPS-side
  Antigravity error (`Individual quota reached... Resets in 165h52m20s`). Do not demo a live
  Antigravity dispatch until the reset. `pr-brain` (Claude-review half) is separately proven live
  today — it gated and merged real PR #691 autonomously this morning.
- **turicks-brain is mostly solid, not broken.** MCP retrieval verified live with current data.
  CI-driven sync (`.github/workflows/brain-sync.yml`, daily, runs over SSH on the VPS) genuinely
  works. The only real gap: a `pnpm brain:sync` invoked from a laptop checkout writes to a dead
  local DB and reports false success — already documented as a known defect in the merged PR #698,
  not new. **This session deliberately did not run `pnpm brain:sync` locally for that reason**,
  despite CLAUDE.md's "Automated Brain Sync" instruction to do so after touching `docs/` — running
  it here would have reproduced the exact bug just confirmed, not closed the loop. The daily CI
  sync will pick this file up on schedule.
- **Antigravity's own branches — reviewed everything, salvaged almost nothing.** 8 local branches
  existed across two Antigravity sessions, none pushed, none PR'd, none an open PR to review.
  5 older ones (from an earlier, stale-based dispatch) are all dead — every real change in them is
  already superseded on `main`, including the one branch (`fix/tashi-pipeline-parity`) that sounded
  most relevant to this session's bug (confirmed zero file overlap with the CV/PDF or level-gate
  code). 3 newer ones (nominally AG-015/016/020) each solve a smaller or different problem than
  their actual brief — none closes what it claims to, though each is a small, harmless, honest
  side-fix on its own. This is concrete evidence for the founder's "we are still merging AI slop"
  complaint, not just a feeling — and it's what PR #698's new rules (#34–36) exist to catch going
  forward. The real AG-015 (turn timeout shorter than the tools it wraps — B5/B6/B7, Tier-0 in an
  earlier audit) was picked up and fixed directly rather than re-dispatched — see PR #702 above.

## Metrics

- `pnpm gate`: green throughout every merge (399 files / 4,440→4,453 tests as fixes landed).
- CV/PDF fix: 4 new regression tests, all using real rejected prod text; 0 regressions in
  `cover-letter.test.ts` / `tailor-cv-grounding.test.ts`.
- Senior-role backfill: 15/~230 Pushkar rows corrected (0 Tashi rows needed correction).
- AG-015 (kernel timeout): 9 new tests (fake-timer + a real spawned-process abort test); fixed a
  self-introduced LOC-budget and fail-open-catch ratchet violation before merge.
- 5 PRs merged to `main` (#697, #698, #700, #702, plus this doc's own #701) — 2 real deploys
  watched and confirmed (`ActiveEnterTimestamp` moved to `2026-09-17 05:53:49 UTC` then again to
  `07:02:07 UTC`, both after their respective merges).
- 2 live Telegram round-trips against the real production bot, both successful post-deploy.
- 8 Antigravity branches investigated; 0 merged (5 dead, 3 partial/mis-scoped); 1 small unclaimed
  feature identified (`/tashijobs` + menu pruning) for later hand-porting.

## Outstanding

1. **AG-015 live verification.** The B5/B6/B7 fix (PR #702) is merged and deployed but the exact
   original failure mode (a real 300s+ `claude_code` run) was never reproduced live — that needs a
   real multi-minute engineering task dispatched through Telegram, at real token/time cost. Fake-timer
   unit tests cover the timing/threading logic; this is the one piece those can't substitute for.
2. **5 dead Antigravity branches + their worktrees** (`fix/tashi-pipeline-parity`,
   `fix/gateway-echo-and-personio`, `fix/infra-and-path-resolution`,
   `fix/scheduler-and-funding-grower`, `fix/telegram-ux-routing`) — confirmed superseded, safe to
   delete. Not deleted yet; recommend the founder confirm before deletion.
3. **`/tashijobs` command + menu pruning** — the one piece of real, unclaimed value in
   `fix/telegram-ux-routing` — needs hand-porting onto a fresh branch off current `main`.
4. **AG-016's actual ask** (confirm PR #683 already fixed the 503/fallback issue, or root-cause a
   residual gap) is still technically undone, though the evidence gathered this session strongly
   suggests it's already fixed and just needs a closing comment on the relevant issue.
5. **AG-014 (OAuth invalid_grant), AG-017 (judge Nemotron parsing), AG-019 (LangSmith PII
   scrubbing)** — not started. Lower priority; not blocking today's demo.
6. Founder should personally spot-check one or two of the newly-corrected "TOO SENIOR / TOO JUNIOR"
   rows in the live brief (`/jobs`) before relying on this fully — this session verified via direct
   script invocation and one live `/draft` per profile, not a full `/jobs` read-through.
