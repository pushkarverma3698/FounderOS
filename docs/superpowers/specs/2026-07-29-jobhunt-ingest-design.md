# Job-Hunt Ingest + CV Signals — Design

**Date:** 2026-07-29
**Status:** Approved
**Supersedes nothing. Extends:** `docs/strategy/09-NL-ENTRY-CAMPAIGN.md` §3

## Problem

`screen_job` applies the hard legal gates correctly and records verdicts in
`agents.job_applications`. Nothing feeds it. Every posting that has ever been
screened was pasted in by hand.

`search_jobs` does not close this gap: it wraps `web_search` and returns eight
title/URL/snippet triples. A snippet is not a posting. The salary and language
gates parse the posting body, so feeding them a snippet produces a confident
verdict from absent evidence — the silent failure direction.

The binding constraint on the campaign is **supply of screened postings**, not
gate precision. This spec builds supply.

## Non-goals

- Fit ranking, draft generation, and the Telegram approval queue (campaign doc §3,
  later phases).
- Any auto-submission. ADR-009/ADR-015 hold: draft only, founder submits.
- Any write to personal-rag. ADR-015 holds: read-only, always.
- Outcome-driven CV A/B testing. Needs ~50 applications per variant; the data is
  recorded from day one, the analysis waits until the volume is real.

## Architecture

```
daily cron 07:00 IST (zero-LLM, src/infra/scheduler.ts)
   ↓
runJobIngest()                              src/tools/jobhunt/ingest.ts
   ↓
fetchAtsPostings()                          src/tools/jobhunt/ats-source.ts
   → Apify: fantastic-jobs/career-site-job-listing-api
     via the EXISTING runActorSync() in src/tools/apify.ts
   ↓  RawPosting[] { company, title, url, description, postedAt, location }
screenPosting()                             src/tools/jobhunt/screen.ts  (extracted)
   → sponsor register · permit floor · Dutch bar · dedupe
   ↓
agents.job_applications                     (existing table, unchanged)
   ↓  on PASS only
extractSkillTerms()                         src/tools/jobhunt/skills.ts
   ↓
agents.cv_signals                           (new table)
   ↓
cv_gaps tool                                src/tools/jobhunt/gaps.ts
```

### Why this actor

`fantastic-jobs/career-site-job-listing-api` over every LinkedIn scraper:

1. `descriptionType: "text"` returns the **full verbatim posting body**. That is
   what `screen_job` contractually requires. LinkedIn scrapers return truncated
   snippets, which silently break the salary and language gates.
2. `aiVisaSponsorshipFilter` pre-filters the binding constraint at the source,
   before we pay to screen non-sponsors.
3. `organizationSearch` accepts an array of company names, so the 12,882-row IND
   register in `docs/strategy/data/ind-sponsors-work.csv` can become a target
   list rather than only a post-hoc filter.

Pricing: PAY_PER_EVENT, $0.012/job on the FREE tier + $0.01 per actor start.
At 10 jobs/day that is ~$4/month.

### Component boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `ats-source.ts` | Build actor input; map dataset items → `RawPosting[]`. Network isolated in one function; mappers pure. | `apify.ts` |
| `skills.ts` | Deterministic term extraction from posting text. No network, no model, no DB. | — |
| `screen.ts` | `screenPosting()` — the gates, as a function. `screenJobTool` becomes a formatter over it. | `filters`, `extract`, `sponsor-match`, `job-queries` |
| `ingest.ts` | Orchestration: fetch → screen → summarise. | all of the above |
| `gaps.ts` | Read `cv_signals`, read the CV, report the difference. | `cv-signal-queries`, `career.ts` |
| `cv-signal-queries.ts` | Upsert/read `cv_signals`. | `schema.ts` |

## The screenPosting extraction

`screenJobTool.execute()` currently holds dedupe → extract → gates → persist
inline. `ingest_jobs` must run exactly the same gates. Re-implementing them is
the drift failure: the batch path and the manual paste path disagree, and the
disagreement is invisible.

So the body moves into:

```ts
export type ScreenOutcome =
  | { kind: "error"; message: string }
  | { kind: "duplicate"; company; title; stage; appliedAt }
  | { kind: "screened"; company; title; route; verdict; match; nearDuplicates };

export async function screenPosting(input: PostingInput): Promise<ScreenOutcome>;
```

`screenJobTool.execute()` becomes a pure formatter over `ScreenOutcome`. No
behaviour change; the existing tests are the guard.

## Skill extraction — deterministic, not a model

A curated dictionary of ~150 canonical terms with aliases (`k8s` → Kubernetes,
`golang` → Go), matched against the posting body with non-alphanumeric
boundaries so `C++`, `.NET`, `CI/CD` and `Node.js` match correctly.

**Counted once per posting, not once per occurrence.** A posting that says
"Kubernetes" eight times is one data point, not eight. Getting this wrong would
make verbose postings dominate the frequency table.

Rationale for a dictionary over an LLM pass: deterministic (same input → same
signals, forever), unit-testable, $0 per posting, and no dev-loop API spend.

**Unknown-term tracking.** Tokens shaped like technology names (`MCP`, `LangGraph`)
that are absent from the dictionary are recorded with `category = "unknown"` and
a conservative shape filter plus a stopword list. They are **stored always but
only reported above a frequency threshold of 5 postings**, so the dictionary
extends under founder review instead of drifting, and low-frequency noise stays
out of the report.

## Data model

```sql
CREATE TABLE agents.cv_signals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  term          text NOT NULL,          -- canonical, e.g. 'Kubernetes'
  category      text NOT NULL,          -- language|framework|infra|data|ai|practice|unknown
  seen_count    integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz DEFAULT now(),
  last_seen_at  timestamptz DEFAULT now(),
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX cv_signals_term_uniq ON agents.cv_signals (tenant_id, term);
```

Plus, on `agents.job_applications`: `description text` and `posted_at timestamptz`
and `source text`. The description is needed to re-derive signals when the
dictionary changes — without it, adding a term means losing all history before
the change.

`job_applications` is otherwise untouched.

## How the resume gets updated

Two loops. Only one is available soon, and the spec is explicit about which.

**Loop 1 — vocabulary gaps (live from week one).** Signals accumulate only from
postings that **pass the gates**. This is the design decision that makes the
output meaningful: comparing the CV against the whole market is noise, comparing
it against legally reachable roles is signal.

`cv_gaps` reports three buckets:

- **Missing** — frequent in the reachable market, absent from the CV. Some are
  real skill gaps; some are things already built under a different name
  (pgvector RAG built, "vector database" never written). The second kind is a
  free win and is invisible without frequency data.
- **Confirmed** — in both. Evidence the CV is aimed correctly.
- **Rising unknowns** — above the threshold, for the founder to accept or reject
  into the dictionary.

It **suggests; it never edits.** No write path to the CV or to personal-rag exists
in this design.

**Loop 2 — outcome-driven tuning (deferred, months out).** Reply rate per
application is already recorded by `job_applications.stage`. When application
volume supports it, variant analysis becomes possible. Building an A/B harness
now would produce noise and label it evidence.

## Error handling

- `fetchAtsPostings` never throws. No `APIFY_TOKEN`, actor error, or non-array
  dataset returns `{ ok: false, error }` and the sweep reports zero ingested
  **with the reason**. It does not fall back to `web_search` — a snippet through
  the salary gate is the silent-wrong direction, and no result is better.
- A posting that fails to screen does not abort the batch. Per-posting errors are
  collected and reported in the summary.
- Signal recording failures are logged and swallowed (`// allow-failopen:`) —
  losing a frequency count must never lose a screening verdict.
- Zero results is a **reported finding**, not an error. NL + sponsorship + 2–5
  years is a narrow slice; a low number is the first honest measurement of the
  market the strategy has been guessing at.

## Testing

Unit ($0, no network, no model):
- `ats-source`: input construction; mapping of realistic dataset items; missing
  fields; empty dataset; truncation bounds.
- `skills`: alias resolution; `C++`/`.NET`/`CI/CD` boundaries; once-per-posting
  counting; unknown-term shape filter and stopwords; no false positive on `go`.
- `screen`: existing suite must pass unchanged (the extraction guard).
- `ingest`: batch with injected postings — pass/flag/reject mix, per-posting
  error isolation, empty-result reporting.
- `gaps`: bucket assignment against a fixed CV text and fixed signal rows.

Live e2e (one run): real actor → real Dutch postings → real gates → rows in
`agents.job_applications` and `agents.cv_signals`, read back through
`review_screened` and `cv_gaps`.

`APIFY_TOKEN` is set on prod but absent from the local `.env`, so the local e2e
runs the actor through the operator's Apify connection and feeds genuine data
through the full chain.

## Open questions

None. Volume (10/day) and the resume loop shape (new table, suggest-only) were
decided by the founder on 2026-07-29.
