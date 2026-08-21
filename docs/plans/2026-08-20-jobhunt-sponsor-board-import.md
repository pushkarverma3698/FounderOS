# Jobhunt: replace board probing with a deterministic CSV join

Date: 2026-08-20 · Status: **SHIPPED**, gate green, live-verified

## Context

The free lane polled **285 company job boards**, extracted from a public gaming-heavy dataset.
Only 106 were sourced for the NL market and **zero** were Recruitee, the platform Dutch firms
actually use.

The previous attempt to grow it (`2026-08-20-jobhunt-apply-queue-and-registry.md`) **probed**: guess
a slug from a company name, hit four ATS domains, keep the 200s. It measured a 0.36% hit rate on
Greenhouse/Lever/Ashby and it never reached prod — `/opt/founderos-data/free-ats-discovered.csv`
does not exist on the box, so the harvest path has produced zero boards to date.

The founder's research: the company→ATS-token mappings probing tries to rediscover are **already
published** by open-source projects. `kalil0321/ats-scrapers` maintains one `name,slug,url` CSV per
platform. Joining those against the IND recognised-sponsor register is deterministic, free, and
needs no LLM.

## What shipped

| | before | after |
|---|---|---|
| Boards polled | 285 | **623** |
| Recruitee boards | 0 | **113** |
| Ashby / Lever | 16 / 60 | 107 / 99 |
| Live postings per sweep | ~16k | **29,547** |
| Sweep failures | — | **7** (was 40 before the concurrency fix) |
| Sweep duration | — | **61s** |
| Postings published in the last 24h | — | **492** |

338 boards imported, every one an IND recognised sponsor, every one verified live before it was
written. 8 candidates were rejected as genuinely dead (3× 404, 1 timeout, 3 custom-domain slugs our
URL shape cannot express, 1× 500).

## The decision that matters: board membership is not a sponsorship claim

`matchSponsor` is deliberately strict — it will not strip `holding`, `group` or `netherlands`,
because "Deeploy Holding" is a different legal entity from "Deeploy". Using it as the join key
yields 188 boards instead of 349: Deliveroo, Stripe, Samsara and Airbnb all fall out on a country
word.

So `boardMatchKey` in `src/tools/jobhunt/board-import.ts` is **looser**, and that is only safe
because of one line:

> **The `name` column carries the ATS corpus's company name, never the IND registered one.**

`free-ats-mappers.ts:285` sets `company: candidate.board.name`, so that column IS what gets
screened. Writing "Deliveroo Netherlands B.V." there would have made every posting on the board an
exact register match **by construction** — a confident `sponsor` verdict manufactured by our own
CSV, for a board matched on a loose key. That is a manufactured application that cannot lawfully
succeed, and it would have failed silently.

With the corpus name, `ashby/deliveroo` screens to `uncertain` with `Deliveroo Netherlands B.V.`
named as the candidate, and a human decides. The registry decides which URLs to poll; sponsorship
stays a per-posting decision made downstream by untouched code.

This was caught during implementation, after the plan was approved. The approved plan had it wrong.

## Second defect found by running it: Recruitee 429s

The first full sweep at 623 boards failed 40 times — **34 of them Recruitee HTTP 429**, all in rows
just added. Recruitee serves each customer on its own subdomain but rate-limits the caller, so a
burst of eight is refused.

Fixed with `PLATFORM_CONCURRENCY` in `free-ats-source.ts`: groups run in parallel, each bounded on
its own terms (Recruitee 2, the rest 8). Failures dropped **40 → 7**, zero 429s, and the sweep got
*faster* (76s → 61s) because platforms no longer serialise behind one another. Per-origin load went
down, not up: previously all eight slots could land on `boards-api.greenhouse.io` at once.

## Files

- `src/tools/jobhunt/board-import.ts` — NEW, pure: `boardMatchKey`, `parseAtsCorpus`,
  `joinSponsorBoards`, `toBoardCsvRows`
- `scripts/jobhunt-import-sponsor-boards.ts` — NEW: fetch, join, live-verify (with 429 retry),
  append. `pnpm jobhunt:import-boards [--dry-run]`
- `tests/unit/jobhunt/board-import.test.ts` — NEW, 21 tests, no network
- `src/tools/jobhunt/free-ats-source.ts` — `PLATFORM_CONCURRENCY`, grouped sweep
- `src/tools/jobhunt/free-boards.ts` — `MIN_EXPECTED_BOARDS` 200 → 500
- `src/tools/jobhunt/sponsor-match.ts` — export `LEGAL_SUFFIX_TOKENS` (reuse, one word)
- `docs/strategy/data/free-ats-boards.csv` — +338 rows

## Deliberately not done

- **`outscal/OpenJobs`** — keys on website domain; the IND register carries only `name,kvk`. Needs a
  name→domain step for no measured gain over the name join.
- **`Jeonghoan93/netherlands-visa-sponsors` as upstream** — checked: last push 2026-07-06, register
  "as of 2026-07-01", 2 commits, 0 stars. **Our own scraper is fresher** (12,884 rows, 2026-07-29).
  Adopting it would make our data older. Not useful as a fallback either: a failed IND scrape
  already fails loudly and leaves the existing CSV in place, which is better data than the mirror.
- **SmartRecruiters / Workable / Personio** — would reach ~200 more sponsors; founder scoped this to
  the four platforms already supported. Personio additionally has no usable per-posting URL.
- **The apply loop** — scoped out by the founder, see below.

## The constraint this does NOT move

Prod, measured 2026-08-20: **40 NL-sponsor rows screened lifetime, 2 applications lifetime, 0 in the
last 14 days.** Supply was throttled and now is not. Whether the founder applies is untouched, and
it is the only step that converts to a job.

## Monthly refresh

`pnpm jobhunt:import-boards` re-reads the register, re-joins, re-verifies and appends only what is
new. Dead tokens are reported, never auto-removed — a transient outage must not silently shrink the
registry.
