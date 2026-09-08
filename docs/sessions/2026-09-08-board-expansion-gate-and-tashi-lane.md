# 2026-09-08 — board expansion gate, prod-QA merge, and what Tashi's lane actually sends

## What we did

1. **Merged PR #641** (`fix(prod-qa): close seven defects from the 5-day production audit`) into `main`
   as `3c592a1`. Deploy verified on the box: `ActiveEnterTimestamp=Tue 2026-09-08 06:40:10 UTC`, not
   just `git rev-parse` — that distinction is on record as a false green.

2. **Gated and merged PR #639** (`feat(jobhunt): multi-market board expansion`) into `beta` as
   `a80f8a42`, after fixing one blocker on the branch (`12ed696`).

3. **Answered "will Telegram tell me about Tashi's jobs?"** by reading prod rather than the code —
   `agents.job_lane_heartbeats`, `agents.job_applications`, and 18 hours of `journalctl`.

## What we fixed

### A 304 could silently empty a board (PR #639, `12ed696`)

PR #639 moved the ETag cache from an in-memory `Map` to Postgres. That split `headersFor()` and
`read()` into two separate round trips and broke the invariant the in-memory version documented and
held:

> the header and the payload come from the same entry: if the entry is gone, no header is sent and
> the fetch is unconditional. A cache miss must cost bandwidth, never correctness.

After the change, the row can be dropped between the two reads, and `read()` fails open to
`undefined` when the cache DB errors *after* `headersFor` already succeeded. A 304 carries no body,
so that `undefined` reached the adapter as an empty board: **zero candidates, recorded as neither a
failure nor a find, indistinguishable from an employer with no openings.**

The test that pinned this — `"never offers a validator whose payload has been evicted"`, whose
comment names the defect verbatim — was deleted with the in-memory implementation and not replaced.
`tests/setup.ts` now mocks the cache queries globally with an always-succeeding `Map`, so **no unit
test can reach this failure at all.** That is why green CI missed it.

Fix: `fetchPayload` re-asks without the validator when a 304 lands on a payload the cache cannot
produce. Failing test first (`free-ats-conditional-get.test.ts`), then the change.

## Why

### The UK/DE boards are NOT dead supply — the first read of the diff was wrong

The structural argument said zero: no profile targets UK or DE, `countryFromLocation` returns
`other` for both, and `free-ingest-filters.ts:112` drops `other`. 1,872 of 3,223 boards (58%) are
UK- or DE-sourced.

A live $0 sample disproved it, because a board is a company and a company posts wherever it hires —
which `free-boards.ts` already documents ("market is provenance, not a claim about postings"):

| sample | boards | postings | resolved NL/IN/unknown | screenable after all filters |
|---|---|---|---|---|
| UK-sourced | 40 | 723 | 15.1% | 0.13 / board |
| NL-sourced (control) | 40 | 876 | 15.8% | 0.40 / board |

~3× less efficient per board, but at 1,799 boards that is **~225 screenable postings per full
sweep**, against ~453 from the entire existing NL set. The lesson is the one already in rule #25:
the structural reading named a real mechanism and still got the answer wrong, because it never asked
what the boards actually return.

### Tashi's automated Telegram alert is wired and alive — and has never fired with jobs

The delivery path exists and is per-profile: `runFreeSweepForProfile` → new passes →
`buildDailyBrief` → `sendToChat(formatNewRowsAlert(..., profile.candidateName))`. Quiet sweeps roll
up into a 3-hourly alive-ping. Her channel is alive: `last_message_at = 2026-09-08 04:31`.

But the gate is `newPasses.length > 0`, and prod says that has not happened:

- `job_lane_heartbeats.zero_pass_streak = 17` for `wife-nl-finance` (0 for `pushkar-nl-tech`).
- Every sweep's funnel for her, unchanged for 9+ hours:
  `seen 47,675 → undated 1,516 → stale 25,258 → offTrack 20,485 → offMarket 383 → known 33 → screened 0`.
  All 33 survivors are already in the DB. Her funnel closes at "already known", not at a broken gate.
- All 91 of her rows were written by **manual rescreen runs** (64 on 09-04, 24 in one second at
  09-07 22:01:56), never by the automated sweep.
- All 6 of her PASS roles have `brief_section` and `brief_rank` **NULL** — `buildDailyBrief` has
  never persisted a ranking for her, so `/draft` and the apply queue have nothing to read.

Binding constraint: **33 postings out of 47,675 reach her dedupe stage per sweep**, and `offTrack`
eats 20,485. Supply into her finance vocabulary is the lever, which is what #639 widens.

## Metrics

- `pnpm gate` on the #639 branch: **exit 0, 349 files, 3,830 tests** (local, post-fix). CI on
  `12ed696`: all three checks green.
- Board registry: **1,312 → 3,223** (+145.7%, PR claim verified through the real `getFreeBoards()`).
  UK 1,799 · NL 1,133 · IN 185 · DE 73 · IN|NL 33.
- Prod sweep timing: 1,312 boards in ~90s (sweeps complete :01:33 / :31:32). 3,223 extrapolates to
  ~220s inside a 30-minute cron — **no overlap risk**, and `runFreeSweep` has no overlap guard, so
  this mattered.
- Tashi: 91 screened rows lifetime, 6 PASS, 0 ranked, 0 produced by the automated sweep.
- Pushkar: 1,366 screened rows, 800 PASS, 3–5 new per sweep.

## Outstanding

1. **PR #633 collides with #639 head-on.** Both create `drizzle/0040_ats_board_cache.sql` and both
   rewrite `src/tools/jobhunt/free-ats-cache.ts` — two implementations of the same feature under the
   same migration index. `git merge-tree` reports 7 conflicting files. #633's version is the more
   complete one (Retry-After + per-platform rate limiter). It needs rebasing and re-scoping, or
   closing as superseded. Founder call.

2. **`beta` is not promoted to `main`.** Deliberate: promoting now ships a 2.46× board count with the
   *weaker* cache implementation, and a 3,223-board sweep is exactly where #633's rate limiter earns
   its keep. Resolve #633 first, then promote.

3. **Tashi's 6 PASS roles are unranked and unreachable.** `buildDailyBrief` has never run for her
   profile in prod. Not fixed here — it is a separate defect from the supply problem, and this
   session's rule was to finish the merge before widening.

4. **`ats_board_cache` has no TTL or pruning**, and the cache now costs 2 reads + 1 jsonb upsert per
   board per sweep — ~310k extra queries/day at 3,223 boards × 48 sweeps. Unmeasured. Watch after
   the promotion to prod.

5. **No Telegram end-to-end run.** `TELEGRAM_TESTER_API_ID` / `_API_HASH` / `_SESSION` still unset,
   so the MTProto founder-simulation could not drive the real transport. Everything above is read
   from prod state and prod logs, which is stronger than a unit test and weaker than a live send.
