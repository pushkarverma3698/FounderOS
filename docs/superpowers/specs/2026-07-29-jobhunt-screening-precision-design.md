# Job-screening precision — design

_Date: 2026-07-29 · Extends `docs/strategy/09-NL-ENTRY-CAMPAIGN.md` §3 · Builds on
`feat/jobhunt-screening-gates` (a6386c0)_

## Why

The screening gates shipped earlier today were reviewed adversarially against realistic
Dutch postings and four defects were confirmed empirically:

| # | Defect | Observed |
|---|---|---|
| 1 | Language gate is blind to Dutch written in Dutch | `"Nederlands is vereist"` → **PASS** |
| 2 | Holiday allowance unmodelled | `"€55.000 incl. 8% vakantiegeld"` → **PASS**, real base €50,926 (below floor) |
| 3 | Salary unit unmodelled | `"€5.000 per maand"` → **FLAG**, is €60k/yr and should pass |
| 4 | Dedupe is cosmetic-text-brittle | 4 spellings of one role → 4 distinct keys → 4 applications |

Defect 3 has a deeper cause: `screen_job` accepts `salary_min`/`salary_max` as **numbers an
LLM extracted from the posting**. That violates the kernel's determinism rule — parsing must
be a pure unit-tested function, never a prompt instruction. Dutch writes `€4.500` for four
and a half thousand; a model reading that dot as a decimal separator yields `4.5` and the
entire market is rejected as sub-floor.

Three structural gaps were also found: no register-freshness check (a stale register turns
newly-registered sponsors into *silent* hard rejects), a hardcoded salary criterion that goes
wrong on 2027-01-01 when IND revises, and no part-time detection (the HSM floor is not
pro-rated).

## The governing principle

**Flag only when resolving the ambiguity would change the verdict.**

The binding constraint on this machine is the founder's 15 minutes/day, not gate coverage.
Today every unknown becomes a flag, so the queue fills with "I couldn't tell" — which is the
manual screening the machine was built to replace.

Mechanically: each gate enumerates the candidate interpretations left open by the posting,
screens **each**, and collects the resulting statuses. A singleton set is the verdict. A
mixed set is a flag whose evidence names the specific ambiguity.

| Situation | Before | After |
|---|---|---|
| €80k, holiday basis unstated | flag | **pass** — €74k under either reading |
| €54k, holiday basis unstated | flag | **flag** — €50k vs €54k straddles the floor |
| Sponsor `uncertain`, salary already rejects | flag | **reject** — sponsor cannot rescue it |
| 32 uur, €90k FTE | invisible | **pass** — €72k pro-rated, still clears |

## Failure-direction rule

The two error directions are not symmetric:

- **Too permissive** → we apply somewhere that cannot hire → a wasted application. Costly,
  but *visible*.
- **Too strict** → we drop a real opportunity → *silent*, and therefore worse.

Therefore: **when parsing is uncertain, emit `unstated` rather than a guess.** A wrong number
produces a confident wrong verdict; an absent number produces a flag a human resolves.

## Components

### 1. `src/tools/jobhunt/extract.ts` — pure, no I/O, no model

```ts
interface PostingFacts {
  salary: {
    min?: number; max?: number;            // as written, before normalisation
    unit: "annual" | "monthly" | "hourly" | "none";
    unitInferred: boolean;                  // magnitude-inferred, not stated
    holidayBasis: "included" | "excluded" | "unstated";
    fteFactor?: number;
    raw?: string;                           // matched substring, for evidence
  };
  language: { dutchRequired: "yes" | "no" | "unstated"; evidence: string };
  route: "hsm" | "remote-contract" | "unclear";
}
```

Number parsing must handle what the market writes: `€4.500` (Dutch dot = thousands),
`€4.500,50`, `€55K`, `€ 4.357,-`, ranges with `-`/`–`/`tot`/`tussen … en`. Ambiguous
separators are disambiguated by **salary-magnitude plausibility** (hourly 10–300, monthly
1,000–30,000, annual 15,000–500,000); genuinely ambiguous input returns `null`.

### 2. Bilingual language gate

Dutch requirement lexicon (`vereist, verplicht, vloeiend, uitstekende beheersing,
moedertaal, goede beheersing`) and Dutch softeners (`pré, een pluspunt, wenselijk`).
Closes defect 1.

### 3. Route-aware gating

| Gate | HSM track | Remote-contract track |
|---|---|---|
| Sponsor register | hard gate | not applied |
| Floor | €52,284/yr base | €27/hr equivalent (same floor, hourly) |
| Language | applied | applied |
| Dedupe | applied | applied |

`route` becomes a column on `job_applications`. **`unclear` screens under both routes and
passes if either passes** — because misclassifying in either direction loses something, and
this is the only reading that never silently drops a role.

### 4. Register freshness

`scripts/ind-sponsors.ts` stamps `# scraped: YYYY-MM-DD` as the first CSV line; the loader
surfaces `scrapedAt`. Beyond 35 days the sponsor gate downgrades `not-sponsor` → `uncertain`
with "register is N days old, re-scrape". A stale register must never produce a confident
hard reject.

### 5. Date-aware criterion

Replace the bare `4357` literal with a table of criteria and validity windows, selected by
date + DOB (under-30 band expires 2028-06-03). Outside a known-valid window the function
**refuses to assert** and the gate flags. IND revises every 1 January, so the current
literal is wrong from 2027-01-01.

### 6. Dedupe: hard block + soft warn

Exact key still blocks. Same-company **token-set** equality (`senior ai engineer` ≡
`ai engineer senior` ≡ `senior ai engineer (m/f/d)`) raises a warning rather than a block —
catching cosmetic re-posts without over-merging genuinely distinct roles.

### 7. `review_screened` tool

Rejects are recorded but unreadable. If a gate breaks or the register goes stale, nothing
surfaces it. One query, one tool — the only defence against silent systematic error, and the
observability half of §4.

## Testing

Every component is a pure function, so each edge case is a unit test. Required coverage:
Dutch numerals, both separator conventions, all unit spellings, holiday-basis variants,
FTE forms, Dutch and English language requirements and softeners, route markers, criterion
window boundaries (2026-12-31 / 2027-01-01 / 2028-06-03), and the verdict-relevance rule
producing pass/flag/reject correctly on straddling ranges.

Screening tests run against the **real** 12,883-row register, not a fixture.

## Out of scope

Fit ranking, draft generation, the Telegram approval queue, and the daily sweep. Sponsor-match
candidate precision is being handled separately (background task, same `uncertain` volume
problem).
