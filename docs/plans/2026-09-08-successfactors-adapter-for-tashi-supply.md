# SuccessFactors adapter — the last lever for Tashi's supply

**Status:** scoped, not built. Founder chose "scope it, don't build it yet" on 2026-09-08 — this
doc is the tradeoff for that decision, and [AG-013](../antigravity/AG-013-successfactors-adapter.md)
is the ready-to-dispatch brief if/when the answer changes.

## The constraint, confirmed three separate times

Her own profile file (`src/tools/jobhunt/profiles/wife-nl-finance.ts:170-176`) already states the
conclusion from the 2026-09-07 audit: of 174 Dutch postings her classifier dropped, exactly one was
a genuine miss. **"The same audit is what says her lane's problem is supply, not vocabulary."**
`docs/sessions/2026-09-07-jobhunt-nl-finance-board-supply.md` measured it again and named the
ceiling explicitly: **"85 of 126 curated brands have NO CORPUS ROW on any of the ten platforms...
They are on SuccessFactors, Taleo or bespoke career sites."**

This session re-verified both halves live, 2026-09-08:
- Vocabulary is not the lever — confirmed by reading the profile file's own audit trail, not
  re-measuring it a third time.
- The other 9 platforms are exhausted for her specific gap employers — `board-expansion` (#639,
  merged to `beta`) already tripled the total registry (1,312 → 3,223 boards) across UK/DE/IN/NL,
  and none of that growth touches her named gap list (ABN AMRO, Aegon, KPMG, EY, Heineken,
  AkzoNobel, Ahold Delhaize, a.s.r., PGGM, Triodos, Van Lanschot, de Volksbank, Michael Page,
  Robert Half, Hays, Undutchables) because none of them are on Greenhouse/Lever/Ashby/etc.
- **Taleo is a dead end for her, specifically.** Checked the same public corpus source
  (`kalil0321/ats-scrapers`) used for all 10 existing adapters: `taleo.csv` is 168 rows, almost
  entirely US companies (`ACME Brick Company`, `Adelphi University`, ...), **zero matches** against
  her gap list.
- **SuccessFactors is real and reachable.** `successfactors.csv` in the same corpus: **1,393
  companies**, matching the row count the 2026-09-07 session recorded ("fetched and confirmed").
  Cross-referencing found **HEINEKEN** verbatim: `HEINEKEN,C0000032666P,https://career5.successfactors.eu/career?company=C0000032666P`
  — one of her named gap employers, sitting in a corpus this repo already knows how to download
  and join (`scripts/jobhunt-import-sponsor-boards.ts`'s existing `CORPUS_BASE` pattern).

## Why this isn't a same-session build

Loaded HEINEKEN's career site live and read its network traffic. Every other adapter in this repo
(`src/tools/jobhunt/adapters/*.ts`) talks to a clean REST endpoint — a `GET` that returns JSON or
XML, matching Greenhouse's `boards-api.greenhouse.io/v1/boards/<token>/jobs` shape. SuccessFactors
does not have one of those. It renders as a SAP UI5 single-page app and fetches job data through
**DWR (Direct Web Remoting)** — a pre-REST Java RPC framework from the mid-2000s:

```
POST https://career5.successfactors.eu/xi/ajax/remoting/call/plaincall/careerJobSearchControllerProxy.getInitialJobSearchData.dwr
```

This is a materially different integration than any adapter this repo has: DWR calls are
session-bound (a `window.dwr`/`DWREngine` client object mediates them), the request body is a
DWR-specific batch-call string format rather than JSON, and the response is a JavaScript-eval'able
string rather than parseable JSON. None of the existing adapters, mappers, or the transport layer
(`free-ats-transport.ts`) have a pattern for any of this — it would be new infrastructure, not a
10th instance of the existing one.

**What is NOT yet known, and has to be answered before code is worth writing:**

1. Does `getInitialJobSearchData.dwr` require a real session (cookies from a prior page load), or
   does the `plaincall` variant work statelessly from a cold POST? This is the single biggest cost
   driver — stateless roughly doubles nothing, session-bound means a warm-up GET before every real
   request, which is a second round trip per board per sweep.
2. What is the exact DWR batch-call request body format for this specific method, and does it need
   a `scriptSessionId` that has to be minted per session?
3. Is the response format consistent across companies, or does per-tenant SF customization change
   the shape? (Untested — only checked HEINEKEN.)
4. **Not checked this session, worth checking first — cheapest possible path:** does this or any
   SF instance expose the SEO-friendly static sitemap some SF deployments enable for search-engine
   indexing? That would be server-rendered HTML, crawlable without touching DWR at all. Probed three
   guessed paths and got no answer, but the local shell's `curl` was unexpectedly unavailable
   mid-session (works from other tooling) — the probe wasn't conclusive and should be redone
   properly, via `robots.txt` and a real HTTP client, before assuming DWR is the only path in.

## What building it actually costs

Estimate: 4-8 focused hours, not a same-session add-on. Breakdown:
- 1-2h: settle questions 1-2-4 above against 2-3 real companies (Heineken + one more from the gap
  list) using a full browser session to observe the real request, then attempt to replicate it
  headlessly.
- 1-2h: build `src/tools/jobhunt/adapters/successfactors.ts` against the existing `Adapter`
  interface (`adapters/types.ts`) once the protocol is understood, following the pattern in
  `adapters/workday.ts` (the other platform here with a paged, POST-based, non-trivial protocol).
- 1h: extend `scripts/jobhunt-import-sponsor-boards.ts`'s corpus join for `successfactors`, scoped
  to the ~85 known NL finance gap employers specifically — **not all 1,393** in the corpus. A
  narrower join keeps the live-verification pass (already a required step for every board this
  script imports) fast and keeps the blast radius to the companies this was actually for.
- 1-3h: live verification + per-company failure triage. Given the protocol is undocumented,
  expect SOME companies to need individual handling (different `career<N>` shard, different SF
  version, different customization) — this is where the estimate has the most spread.

## Risk this creates that the other 10 adapters don't

- **Fragility.** An undocumented internal API can change without notice, unlike the versioned REST
  endpoints the other adapters use. No SLA, no changelog to watch.
- **Per-company variance.** Confirmed only ONE company's shape (Heineken, `career5`). The other ~84
  are unverified — some fraction may need bespoke handling or may simply not work.
- **Maintenance cost is asymmetric.** If this breaks silently, it fails exactly the way the
  200-year-old failure mode this repo is built to avoid: a board that returns zero candidates reads
  identically to an employer with no openings. The existing "board that fails is COUNTED, never
  skipped silently" rule (`free-ats-source.ts` header) has to hold for this adapter as strictly as
  every other one, and DWR gives more ways to fail quietly (a malformed session, a stale
  `scriptSessionId`) than a REST 404 does.

## Recommendation

Build it — this is the only lever left for the founder's stated main goal for her lane, and the
corpus + one confirmed live example (Heineken) de-risks it more than a cold start would. But it is
new protocol work, not a fix, and the honest estimate is hours, not minutes, with real uncertainty
in the per-company tail. [AG-013](../antigravity/AG-013-successfactors-adapter.md) is written and
ready to hand to Antigravity, or to pick up directly, whenever that's greenlit.
