# 2026-09-08 — concurrency/rate-limit hard audit, main/beta desync fix, Tashi's ranking, and the board expansion goes to prod

## What we did

1. **Diagnosed "main broke"** — it wasn't. CI and prod were green throughout. The real problem:
   `sync-beta.yml` opens a PR when `beta` falls behind `main`, but can't resolve real conflicts —
   once both branches independently edited the board registry, that PR (#638) sat CONFLICTING while
   still reporting "success" (the job ran; the sync didn't land). Drift had grown from 21 commits
   (2026-09-05, per memory) to 24. Resolved by hand (#643): 5 conflicting files, all reconcilable —
   the board CSV conflict was a pure union (all of `main`'s 15 exclusive rows were already present
   verbatim in `beta`'s 3,223), the import script conflict was `beta`'s generalization (`--in-tech`/
   `--de-tech`/`--uk`) strictly containing `main`'s narrower NL-finance path.
2. **Hard-audited PR #633** (persistent cache + Retry-After + per-platform rate limiter, the
   requested concurrency/rate-limit review). Found it redundant, not necessary: the persistent cache
   and Retry-After honoring it wanted are already on `beta` — and #633 has the *exact* 304-cache
   bug I fixed in #639 (`return cache.read(url)`, no undefined check, same false invariant about the
   cache never disagreeing with itself). Its one real gap — Retry-After had zero test coverage — got
   a test (#644) instead of a reimplementation. Its per-platform rate-limiter numbers deleted the
   evidence-based `PLATFORM_CONCURRENCY` comments and replaced them with unsourced reductions
   (ashby 8→2, smartrecruiters 8→3, workable 8→2, teamtailor 8→4); checked prod directly — zero
   Recruitee 429s in 48 hours at current scale, so there's no live problem those numbers solve.
   Closed #633 with the full evidence trail rather than a silent close.
3. **Ranked Tashi's existing PASS rows** by running `buildDailyBrief({profile: WIFE_FINANCE_PROFILE})`
   against prod through the exact code path `/brief` uses (`persistBriefRanks`, profile-scoped, no
   Telegram side effect). Verified in the DB: Thales (Financial Accountant, Hengelo, zoekjaar basis)
   ranked #1, Michael Kors #2. The other 4 historical PASS rows stay unranked — correctly: the
   founder's 2026-09-07 decision to go fresh-only (24h window, standing pool removed) makes rows
   older than 24h invisible to the brief by design. Reviving them would contradict that decision,
   not fix a bug.
4. **Scoped, did not build, a SuccessFactors adapter** for Tashi's actual binding constraint (#645).
   Her vocabulary is confirmed correct (own profile file cites the 2026-09-07 audit). 85 of her 126
   curated NL finance employers are on SuccessFactors — confirmed against the same public corpus
   every other adapter uses (1,393 companies), with one live example, HEINEKEN. Ruled out Taleo as
   an alternative (168 companies, zero overlap with her gap list). Loaded HEINEKEN's real career
   site and found it talks DWR (Direct Web Remoting — legacy, session-bound RPC), not REST like the
   other 10 adapters — real new-protocol work, not a same-session fix. Founder chose "scope it" over
   "build it now"; `docs/plans/2026-09-08-successfactors-adapter-for-tashi-supply.md` has the
   tradeoff, `docs/antigravity/AG-013-successfactors-adapter.md` is ready to dispatch.
5. **Promoted `beta` to `main`** (#646). Last session held this back specifically because of #633;
   with #633 closed as redundant, that was the only blocker. Same 5-file conflict shape reappeared
   (main had drifted 5 commits by squash-merge artifact, not real new content) — resolved by taking
   `beta`'s side wholesale, since it was already the hand-reconciled superset.
6. **Found and fixed a stale drizzle migration tracking row on prod.** Post-deploy, `agents.
   ats_board_cache` didn't exist despite the deploy log saying "migrations applied successfully" and
   `drizzle.__drizzle_migrations` recording id=40 as applied. The table's DDL is idempotent
   (`CREATE TABLE IF NOT EXISTS`) — applied it directly and verified. Root cause not fully chased
   down (see Outstanding) but the discovery pattern matches a documented recurring failure mode
   ("the drizzle journal makes migrations inert," memory 2026-08-01-era).

## What we fixed

- `docs/strategy/data/free-ats-boards.csv`, `scripts/jobhunt-import-sponsor-boards.ts`,
  `docs/ROADMAP.md`, `docs/study/EVIDENCE-MAP.md`, `docs/study/INTERVIEW-BRIEF.md` — main↔beta
  conflict, resolved twice (beta←main in #643, then main←beta in #646 for the promotion).
- `tests/unit/jobhunt/free-board-retry.test.ts` — two new tests pinning that a board's real
  `Retry-After` header is honored (not just guessed via exponential backoff) and that a >60s ask is
  abandoned rather than hanging the sweep.
- Prod: `agents.ats_board_cache` table created directly after the deploy's migration step silently
  no-op'd on a stale tracking row.
- Tashi's `brief_section`/`brief_rank` on her 2 currently-fresh PASS rows.

## Why

The founder's ask was a hard audit — "the boards or company tokens we are growing and the sweep
should work properly for both pushkar and tashi... concurrency and rate limits of the platforms
handled properly" — plus "the main branch got break" and "Tashi's pipeline should also produce a
lot of roles." All three turned out to be the same investigation: the board-expansion work (#639)
was correct and already gated last session, but it had stalled on `beta` behind a phantom blocker
(#633) that turned out to be worse than what already shipped. Getting it to `main` — where it
actually produces roles for two real people — was the actual point of the audit, not a separate ask.

Tashi's ranking gap was never a ranking bug: `buildDailyBrief` was simply never invoked for her
profile, because the automated gate (`newPasses.length > 0`) requires a pass her lane hasn't
produced. That reframes "unranked roles" correctly as a symptom of the supply constraint, not an
independent defect — which is why the SuccessFactors scoping mattered more than the mechanical fix.

## Metrics

- `pnpm gate`, every merge this session: exit 0. Final state on `main`: 359 files, 3,917 tests.
- Board registry live on `main`: **1,312 → 3,223** (+145.7%).
- PRs opened: #643 (sync), #644 (retry-after test), #645 (SuccessFactors scoping), #646 (promotion).
  All merged. #633 closed as redundant, with evidence.
- Deploy verified on the box: `git rev-parse HEAD` = `e2a7261`,
  `ActiveEnterTimestamp=Tue 2026-09-08 07:59:04 UTC`, `/health` → `status: ok`.
- Tashi: 2 of 6 lifetime PASS rows now ranked and visible in her brief (the other 4 are correctly
  invisible under the fresh-only policy, not a bug).

## Outstanding

1. **The stale migration-40 tracking row's root cause is not found.** The DDL I applied directly
   matches the merged migration exactly and is now correct on prod, but *why* `__drizzle_migrations`
   already had an entry for id=40 before this deploy ever ran is unexplained — a plausible but
   unverified guess is that PR #633's competing, differently-shaped migration 0040 was at some point
   run with prod credentials outside the normal deploy path. Worth a deliberate check next session:
   whether any local machine's `.env` points at prod and had `db:migrate` run against it recently.
2. **SuccessFactors adapter not built** — deliberately, founder's call this session. AG-013 is ready.
   Estimated 4-8 hours, real per-company variance risk, the biggest remaining lever for Tashi's lane.
3. **`ats_board_cache` still has no TTL/pruning** (carried from last session, unchanged) — now costs
   2 reads + 1 write per board per sweep at 3,223 boards × 48 sweeps/day. Unmeasured impact.
4. **No live Telegram end-to-end run** (carried from last session). MTProto tester still unconfigured.
   Tashi's ranking fix was verified by reading prod DB state after driving the real production
   function against the real production database — stronger than a unit test, weaker than watching
   the message land in her actual chat.
