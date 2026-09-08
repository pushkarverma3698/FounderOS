# 2026-09-08 — Fresh-first jobhunt: Blocks A + B

Implements [`docs/antigravity/AG-014-fresh-first-blocks-ab.md`](../antigravity/AG-014-fresh-first-blocks-ab.md)
against the audit in [`docs/plans/2026-09-08-fresh-first-jobhunt.md`](../plans/2026-09-08-fresh-first-jobhunt.md).
Block C (supply — the company grower) is untouched and remains the highest-value
item in that plan.

## What we did

**Block A — five mislabels.** Every number in the brief was already correct on
2026-09-08; every word around them was wrong, which is the harder failure to see
because nothing about it looks broken.

| id | What it said | What it meant |
|---|---|---|
| A1 | `seen 3d ago` | when WE stored it — the employer's publication date appeared nowhere |
| A2 | `Nothing is cut — read to the end` | 100 of 166 qualifying rows loaded; the other 66 had no `brief_rank` and no command could reach them |
| A3 | `100 screened` | the apply-queue size, printed again one line below as "100 fresh roles in the queue" |
| A4 | `💰 WHAT TODAY COST` · `280 of them failed` | a 3-day window · 280 sweeps that ran fine and hit a board error, on a $0 lane |
| A5 | `🆕 40 new roles` | 40 roles newly visible to us, most published weeks ago |

**Block B — three verbs over one queue.** `/fresh` (found since you last looked),
`/today` (published < 24h), `/jobs` (everything on file), each with a `wife_`
counterpart, plus the same three reachable in English through `job_brief`.

## What we fixed, and why it was shaped this way

**One resolver, in `tools/` not `gateway/`.** `verify-architecture.ts` R1 forbids
anything outside `src/gateway` from importing it, and the English path runs
inside a tool — so a resolver in the gateway could only ever serve half the
surface, which is the drift it exists to prevent. The gateway's private copy of
the profile-alias table was deleted in favour of `resolveProfileToken`.

**One numbering, or `/draft 3` is a coin flip.** `brief-select.ts` already
carried the warning: *"A filtered subset would renumber the message and
`/draft 3` would tailor for the wrong company."* Every display before this was a
PREFIX of the ordering, so position and pinned rank agreed by construction.
`/today` and `/fresh` are genuine filters, so that construction had to be
replaced: the queue is read once (unbounded), ranked once, numbered once, and
the rank travels on the row. The renderer prints `row.rank`, not the row's index.

**Freshest day first, then CV overlap** (founder decision, this session). Lifting
the age limit without it would fill APPLY TODAY's six slots with whatever matched
the CV best across all time — the "442 standing vs 35 fresh" brief rejected on
2026-09-07. Day-granularity buckets, so overlap still decides within a day; for
the founder's own lane, where 166 of 500 rows are same-day, almost nothing moves.

**A hole this change opened, closed in the same session.** The unbounded read is
capped at `BRIEF_QUEUE_LIMIT` (500) and ordered `created_at DESC`, so it sees
back only as far as its oldest row. A narrow verb whose cutoff reaches past that
horizon would lose rows with no header cut notice, because under a scope the
displayed count and the queue total describe different populations.
`scopeMayBeIncomplete` makes that case loud.

## Metrics (measured on prod, 2026-09-08)

| | Pushkar | Tashi |
|---|---:|---:|
| actionable rows (all) | 1,676 | 118 |
| inside 24h | **166** | 15 |
| rows created in 24h | 345 | 38 |
| oldest 24h-fresh row's position in the 500-row read | 339 | 28 |

* **166 > 100** — the silent cap was cutting 66 rows every brief. A2 confirmed
  against live data, not inferred.
* Rows carrying a `brief_rank` go **166 → 500** per profile (limit-bound, and the
  limit is now stated on screen).
* `/fresh` returned 7 rows with ranks **3, 6, 8, 137, 138** — non-contiguous,
  which is the whole point: under positional numbering they would have printed
  1–5 and `/draft 1` would have drafted a different company.
* **B5 checked, not asserted: 151 rows shared between verbs, 0 disagreed.**
* `pnpm gate` exits 0 — 376 test files, 4,104 tests.
* Cost: **$0**. No model call, paid or free, in any of it.

## Verification status — read this before trusting the above

* **VERIFIED** — `pnpm gate` green, run fresh in-session.
* **VERIFIED** — the three verbs rendered against the real production queue via
  `scripts/jobhunt-verify-verbs.ts` on the VPS review checkout
  (`/opt/review/founderos`, never `/opt/founderos`). Read-only: it deliberately
  does not call `buildDailyBrief`, because that persists `brief_rank`, and
  rewriting prod's numbering from an unreleased branch would retarget `/draft N`
  on the live queue.
* **NOT VERIFIED — the deployed bot answering `/fresh` in Telegram.** Rule #24
  requires driving the real transport, and `TELEGRAM_TESTER_API_ID` /
  `_API_HASH` / `_SESSION` are still unset on this machine (carried defect D-3,
  open since 2026-09-07). The rehearsal above exercises DB → rank → number →
  filter → render with the real data and the real code; it does not prove grammy
  routed `/fresh`, or that the planner reaches `job_brief` with the right fields.
  The founder must send the three commands himself after deploy.

## Outstanding

1. **Block C1** — the company grower still discovers 0 boards/night and can only
   ever find tech startups. Unchanged by this work and still the binding
   constraint on Tashi's lane.
2. **D-3** — no live Telegram E2E until the MTProto tester credentials exist.
3. **Q-3** — the cost block is still tenant-wide; A4 labels it rather than fixing
   it, because `job_ingest_runs` carries no profile column.
4. `BRIEF_QUEUE_LIMIT` is 500 against 1,676 actionable rows. Deliberately not
   raised: the cut is now stated on screen and the constant is env-tunable, so
   the founder can decide what the extra ranking cost is worth.
