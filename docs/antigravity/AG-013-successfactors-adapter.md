# AG-013 — SuccessFactors adapter for the NL finance lane

**Milestone:** jobhunt supply (`wife-nl-finance` profile's binding constraint)
**Branch:** `feat/successfactors-adapter` — cut from fresh `origin/beta`. PR base: `beta`.
**Status:** ⚠ ON HOLD — its central number did not survive measurement (2026-09-08)

> **DO NOT DISPATCH AS WRITTEN.** This brief says "85 of 126 NL finance employers are on
> SuccessFactors". Re-measured against the same 1,393-row corpus it cites, using exact normalised
> name matching, the figure is **7** (Vistra, Heineken, AkzoNobel, DSM-Firmenich, SBM Offshore — two
> of the nine raw hits are duplicate spellings). A deliberately loose matcher put it at 13.
>
> Meanwhile **10** of her missing employers are on platforms this repo ALREADY polls — Grant
> Thornton, Crowe, NN Group, Shell and RELX on Workday, KLM and Fenergo on Workable, MN, All Options,
> ComplyAdvantage — reachable for the cost of ten CSV rows and no new code, and **77 (82% of the
> gap)** are on none of the eleven published corpora at all.
>
> So this adapter is not the biggest remaining lever for her lane. Full measurement and the ranked
> alternative: [docs/sessions/2026-09-08-jobhunt-supply-audit.md](../sessions/2026-09-08-jobhunt-supply-audit.md).
> Founder call required before any dispatch.
**Read [STANDARDS.md](STANDARDS.md) in full before writing any code. It is binding.**
**Read [docs/plans/2026-09-08-successfactors-adapter-for-tashi-supply.md](../plans/2026-09-08-successfactors-adapter-for-tashi-supply.md) first — it has the full reasoning this brief assumes.**

---

## Goal

Tashi Goyal's (`wife-nl-finance` profile) job lane has produced **zero passes from the automated
sweep in 17 consecutive checks** (measured 2026-09-08, `agents.job_lane_heartbeats`). Her
vocabulary is confirmed correct (see the profile file's own audit trail,
`src/tools/jobhunt/profiles/wife-nl-finance.ts:170-176`). The binding constraint is supply: **85 of
126 curated NL finance employers are on an ATS platform this repo cannot poll** — SuccessFactors,
confirmed live against a public corpus (`successfactors.csv`, 1,393 companies, same source as every
other adapter's corpus) and one real example, HEINEKEN
(`career5.successfactors.eu/career?company=C0000032666P`).

**Done means:** a new adapter, following the exact `Adapter` interface every existing platform
implements (`src/tools/jobhunt/adapters/types.ts`), that can poll a SuccessFactors career site and
return normalized postings — wired into the free-lane sweep the same way Workday, Personio, and the
other 8 already are. Scoped to the ~85 known NL finance gap employers
(`docs/strategy/data/nl-finance-employers.csv`'s rows with no corpus match today), not the full
1,393-company corpus.

---

## Measured starting state — verify these yourself before you begin

```bash
# Confirm the corpus and the one verified-live example
curl -s "https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/successfactors.csv" | wc -l
curl -s "https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/successfactors.csv" | grep -i heineken

# Confirm today's gap — recompute, don't trust this number by the time you read it
node --import tsx/esm scripts/jobhunt-import-sponsor-boards.ts --employers-path docs/strategy/data/nl-finance-employers.csv --market NL --dry-run 2>&1 | grep -A200 "NO CORPUS ROW"
```

| Measure | Value (2026-09-08) |
|---|---|
| SuccessFactors corpus size | 1,393 companies |
| Confirmed live example | HEINEKEN, `career5.successfactors.eu`, company `C0000032666P`, 715 total jobs (all regions, unfiltered) |
| Her gap employers with no adapter today | ~~85 of 126~~ — **7**, re-measured 2026-09-08 (see the hold notice above) |
| Existing adapters this repo has for reference | 10 — read `adapters/workday.ts` first, it is the other POST-based, paged, non-REST-shaped one |

**The one thing you must answer before writing the adapter, not after:** is
`careerJobSearchControllerProxy.getInitialJobSearchData.dwr` (SAP's DWR — Direct Web Remoting —
protocol, NOT a REST/JSON endpoint) callable statelessly, or does it need a session established by
a prior page load? Load `https://career5.successfactors.eu/career?company=C0000032666P` in a real
browser, capture the exact POST body and required cookies/headers for that call, then try
replicating it with a bare `fetch()` and nothing else. If it fails without a warm-up request, that
warm-up is now part of every board's cost — say so in the PR, do not hide it in a retry loop.

**Check the cheap path first.** Some SuccessFactors deployments expose a static, server-rendered SEO
sitemap of job postings (a common ATS feature for search-engine indexing) that would need no DWR
call at all. Check `robots.txt` and common sitemap paths on 2-3 real instances before committing to
DWR. This was not conclusively ruled out in scoping — don't assume DWR is the only way in.

---

## Files in scope

| Path | Change |
|---|---|
| `src/tools/jobhunt/adapters/successfactors.ts` | **new** — the adapter, following `adapters/types.ts`'s `Adapter` interface |
| `src/tools/jobhunt/adapters/index.ts` | register the new adapter |
| `src/tools/jobhunt/free-boards.ts` | add `successfactors` to `FREE_ATS_PLATFORMS` / `FreeAts` |
| `scripts/jobhunt-import-sponsor-boards.ts` | extend the corpus join to fetch `successfactors.csv`, scoped to `nl-finance-employers.csv`'s unmatched rows only |
| `tests/unit/jobhunt/adapters.test.ts` | adapter unit tests, following the existing per-platform pattern |
| `docs/sessions/YYYY-MM-DD-successfactors-adapter.md` | session record per the repo's episodic-memory rule |

Do not touch the rate limiter, the cache, or any other adapter. This is additive.

---

## The pattern to follow

**Read `adapters/workday.ts` and `adapters/types.ts` before writing anything.** Workday is the
closest existing analog: POST-based, paged, non-trivial request construction. Your adapter needs
the same shape — `getBoardUrl`, `getBoardRequest` (if paging applies), `listJobs`, `extractBody`,
`getWireFormat`, `getJobUrl` — nothing new invented at the interface level, even though the
transport underneath is unlike anything else here.

**Every board that fails is COUNTED, never silently skipped** — this is `free-ats-source.ts`'s
header rule and it is not optional for this adapter. Given DWR's session-bound failure modes are
new to this repo (a stale `scriptSessionId` fails differently than an HTTP 404), be explicit in the
adapter about what "this board is unreachable" looks like versus "this company genuinely has zero
open roles," and never let the two look the same from the caller's side.

**Verify every candidate board live before it's written to the registry** — same discipline
`jobhunt-import-sponsor-boards.ts` already applies to every other platform (`verifyLive`). A
SuccessFactors board that resolves to a company page with zero results for the target market must
be reported, not silently imported as dead weight.

**Scope to the 85, not the 1,393.** The full corpus is mostly irrelevant companies. Join only
against `nl-finance-employers.csv`'s currently-unmatched rows, the same `--employers-path`/`--market`
flags `#639`/`#637` already added to this script — you should not need to extend the CLI surface,
just add `successfactors` to the platforms the join checks.

---

## Explicitly forbidden

- **No paid API calls, obviously — this is unauthenticated public data**, same as every other
  adapter. If you find yourself needing an API key, you've found the wrong endpoint.
- **Do not guess a URL pattern for a company not in the corpus.** The corpus join is how every
  other platform in this registry gets its board tokens; guessing slugs was tried and rejected for
  IND-sponsor boards specifically because a wrong board is worse than no board — same rule applies
  here.
- **Do not silently fall back to a smaller result set on a parse failure.** If the DWR response
  format varies by company in a way you can't handle generically, report which companies fail and
  why, in full — do not truncate the list (see `free-ats-source.ts`'s `summariseFailures`, which
  exists specifically because a truncated failure list reported the least interesting failures by
  construction).
- **Do not touch `wife-nl-finance.ts`'s vocabulary.** It was audited 2026-09-07 and is correct.
  This brief is supply-side only.
- No `any`, no `console.log` — `pnpm verify:arch` enforces both.

---

## Verify

```bash
pnpm gate
```

Then a live dry-run against the real 85-employer gap, and paste the raw output:

```bash
node --import tsx/esm scripts/jobhunt-import-sponsor-boards.ts --employers-path docs/strategy/data/nl-finance-employers.csv --market NL --dry-run
```

In the PR body state: how many of the 85 gap employers actually resolved to a live, verified board;
how many failed and why (grouped by cause, not a bare count — the whole reason
`reportBrandCoverage`/`summariseFailures` exist); and whether the DWR call needed a session warm-up
or worked statelessly. If fewer than 85 work, that is an honest result to report, not a gap to paper
over — partial coverage that is accurately reported beats a claimed "done" that silently drops the
companies that didn't parse.
