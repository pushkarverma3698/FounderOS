# Jobhunt — Outcome Pipeline

*Design spec · 2026-07-31 · branch `feat/jobhunt-outcome-pipeline` (off `feat/jobhunt-screening-gates`, PR #393)*

## Goal

Turn the jobhunt sweep from a **screening log** into a **daily decision brief**.

Today the pipeline answers "is this lawful?" and stops. It emits 17 grouped
verdicts to Telegram, tells the founder nothing about what to *do*, and if he
ignores it entirely, nothing notices. Every remaining problem traces to that:
there is no ranking, so a large flag queue is undifferentiated; there is no
per-track split, so the market trends are un-interpretable; there is no liveness
check, so a dead posting looks exactly like a live one.

**Success = the founder opens Telegram at 07:00 IST, sees three roles worth
applying to today ranked by how well his CV actually overlaps them, and one
command produces the draft.**

## Non-goals

- Auto-submitting applications. ADR-009 stands: draft only, HITL-gated, never a
  click on "Apply".
- Writing to personal-rag. ADR-015 stands: read-only, by construction.
- LLM-scored fit. Ranking stays pure code at $0 (see D4).

---

## What the real data said

Verified against the live pipeline on 2026-07-31 (17 screened rows, 34 signals):

| finding | evidence |
|---|---|
| The reject bin is now 100% Dutch-language | 4/4 rejects; zero from sponsor or salary after PR #393 |
| The flag queue is the new bottleneck | 9 flag + 4 pass = 76% of postings need human attention |
| Market trends are un-interpretable | `cv_signals` is unique on `(tenant_id, term)` — all three tracks pool into one bucket |
| Sample is far below the reporting floor | `cv_gaps` needs ≥10 passing postings; it ran on 4 |
| `remote-contract` has near-zero source coverage | `DEFAULT_LOCATIONS = ["Netherlands"]` — a "Remote / worldwide" posting likely never matches (**unverified — see O1**) |
| Seniority is capped by HSM-only logic | `DEFAULT_EXPERIENCE = ["0-2","2-5"]`, justified in-comment by the under-30 salary band, which binds under HSM only |
| We use 10 of the feed's 38 input fields | `aiWorkArrangementFilter`, `hasSalary`, `titleExclusionSearch`, `descriptionSearch` all unused |

The last three are one error repeated: **HSM reasoning leaking into layers that
serve all three permit bases.** PR #393 fixed it in the gates. It is still
present in the source query.

---

## Architecture decisions

### D1 — Source becomes a matrix of three pools, not one query

Three live permit bases reach three different markets. One query cannot serve
them, and the one we have serves only the first.

The feed's own `aiWorkArrangementFilter` enum splits the market along exactly the
line the three bases need — *"Remote OK = remote with an office available.
Remote Solely = remote with no office available."*

| pool | query | serves |
|---|---|---|
| **A** NL on-site/hybrid | ATS · `locationSearch:["Netherlands"]` · `["On-site","Hybrid"]` | hsm, partner-permit |
| **B** NL remote | ATS · `locationSearch:["Netherlands"]` · `["Remote OK"]` + Indeed `country:NL, remote` | partner-permit, remote-contract |
| **C** EU companies hiring remote from India | ATS · **no `locationSearch`** · `["Remote Solely"]`, EU-employer filtered client-side + Indeed `country:IN, remote` | remote-contract |

Pool C must drop `locationSearch` entirely — see O1 (resolved). It is scoped to
EU employers only, so it is filtered on company data rather than posting
location.

Two further fields the feed exposes and we do not use:
`aiVisaSponsorshipFilter` (a direct boolean for sponsorship-offering roles — a
real signal for the HSM basis rather than an inference from the register), and
`aiLanguageFilter` (detected description language — a *measurement* of the Dutch
bar, not a replacement for the language gate, since an English-language posting
can still demand Dutch).

Pool C is new. It is scoped to **Dutch and EU employers only** (founder
decision, 2026-07-31): a US company hiring a contractor in India is income, not
a step toward the Netherlands, and mixing the two would blur the campaign's
actual goal.

`DEFAULT_EXPERIENCE` gains `"5-10"`. Under partner-permit and remote-contract
there is no salary band to stay under, and senior roles pay more.

### D2 — Indeed as the breadth source, ATS feed as the quality source

`kaix/indeed-scraper` at **$0.00005/job ($0.06 per 1,000)**, 54 countries
including NL and IN, real `remote`/`hybrid` filter, 98.8% success rate.

At 30/day it costs **~$0.05/month**. The approved $12/mo budget stays dominated
entirely by the ATS feed at $0.012/job. Cost is therefore not a factor in this
decision; coverage is.

The two sources are not interchangeable and must not be merged into one
undifferentiated stream:

- **ATS feed** — direct from 175k company career sites. High trust, full
  description text, agency reposts already removed. This is what the salary and
  language gates were tuned against.
- **Indeed** — aggregator. Broader, but carries reposts of the same ATS jobs,
  agency listings, and stale/ghost postings. Breadth at the cost of trust.

Each row records its `source`. The brief never shows an Indeed-only row in
DO TODAY without it having passed liveness verification (D3).

**Runtime path stays `runActorSync`** (`src/tools/apify.ts`), not the Apify MCP.
The Apify MCP was used to research this and is the right tool for that. At
runtime the kernel needs injected, deterministic, offline-testable tools; an MCP
hop is a moving part CI cannot exercise at $0.

Known actor constraint: `fromDays` cannot be combined with the `remote` filter.
Remote pools therefore use `sort: "date"` and filter by date client-side.

### D3 — Liveness verification, not just dedupe

The founder's constraint, verbatim: *"We need to act upon real and verified data
not just deduping it."*

Dedupe answers "have I seen this before". It does not answer "is this real and
still open". Ghost jobs and stale reposts are the dominant noise on an
aggregator, and a dead posting is indistinguishable from a live one in every
view we currently render.

`kaix/indeed-scraper` exposes a `jobKeys` lookup mode returning an **`expired`**
field. At $0.00005/job, re-verifying the entire open pipeline daily costs
fractions of a cent.

```
verifyLiveness(rows) →
  Indeed-sourced  → jobKeys lookup, read `expired`
  ATS-sourced     → GET the posting URL, treat 404/410/redirect-to-index as gone
  result: "live" | "expired" | "unverifiable"
```

Rules:
- **No row enters DO TODAY without a `live` result.** Verification runs on the
  shortlist only, after ranking — the shortlist is small, so this is cheap and
  the check lands where a wrong answer costs the most.
- `unverifiable` is **not** `expired`. It surfaces as "couldn't confirm still
  open" and stays on the list. Treating a network failure as a dead job is the
  silent direction.
- Expired rows move to stage `expired` **with the reason recorded**. Nothing is
  silently dropped.
- Everything still open is re-verified weekly.

### D4 — Ranking is stack overlap, deterministic, $0

Ranking is the missing piece that turns 76%-actionable into a shortlist.

`overlapScore(posting, cvText)` = the count of skill terms shared between the
posting and the track's CV, over the terms the posting asks for — computed with
`extractSkillTerms`, **the same extractor that builds the market signals**.
Using different logic on the two sides is how a report claims a gap in a skill
the CV states plainly.

It is named **"overlap", not "fit score"**. It knows nothing about seniority,
team, culture, or whether the founder would enjoy the work. A name implying
judgement would earn trust it cannot support. The brief prints it as `9/11`, not
as a percentage or a grade.

Pure function, no model call, no network. Unit-testable in isolation.

### D5 — Tracks threaded end to end

`cv_signals` is currently unique on `(tenant_id, term)`, so "Python 60%" blends
AI, backend and frontend. It could be 100% of AI roles and 0% of frontend and
the report cannot distinguish them. The founder's single highest-value CV
finding is, as it stands, un-interpretable.

- `classifyTrack(title)` — deterministic, matches `TRACK_TITLES` phrases,
  resolves multi-match by `TRACK_PRIORITY` (ai > backend > frontend), falls back
  to `"unclassified"`.
- Migration **0019**: `track` column on `agents.job_applications` and
  `agents.cv_signals`; the `cv_signals` unique index becomes
  `(tenant_id, track, term)`.
- Existing rows backfill to `"unclassified"` — they were screened under blended
  logic and must not masquerade as track data.

### D6 — Per-track CV workspaces

```
~/Projects/personal-rag/data/local_docs/cv/
  ai/         cv.md · gaps.md (regenerated) · cover-letter.md
  backend/    cv.md · gaps.md · cover-letter.md
  frontend/   cv.md · gaps.md · cover-letter.md
```

- `PERSONAL_CV_DIR` replaces `PERSONAL_CV_PATH`; the single-file path stays
  supported as a fallback so nothing breaks mid-migration.
- `readFullCvText(track)` resolves `cv/<track>/cv.md`. The existing
  `MIN_PLAUSIBLE_CV_CHARS` guard and the explicit refusal to fall back to the
  synthesized wiki both carry over per track.
- `cv_gaps({track})` compares one track's CV against that track's signals only.
- `ingest_local_docs.py` tags each as `doc_type="cv"` with a `track` field.
- The current `cv-master.md` seeds all three; they diverge as gap reports land.

### D7 — The brief replaces the log

```
JOB BRIEF — Fri 1 Aug · 34 screened · AI 12 · BE 14 · FE 8

▸ DO TODAY (2)
  1. Adyen — AI Engineer                       overlap 9/11 · verified live
     sponsor ✓ · €62k ✓ · English ✓
     They ask for Python; your CV doesn't say it.
     → /draft 1

▸ ONE QUESTION AWAY (3)
  3. Zzyzx — Backend Engineer                  overlap 7/10
     Salary not stated. Ask: "what's the band for this role?"
     → /ask 3

▸ NOT LAWFUL (4)   Dutch required ×4

▸ WHAT THE MARKET ASKED THIS WEEK
  AI (n=23)  Python 78% — missing from your CV for 14 days
  BE (n=31)  Kubernetes 52% — new this week

⚠ 6 PASS roles have sat undrafted for 5 days.
```

Three properties make this an outcome rather than a report:

1. **Ranked** by overlap, verified live, capped at what a person can act on.
2. **One command per row.** `/draft 1` produces the application draft — still
   HITL-gated, never auto-sent.
3. **It remembers.** "absent for 14 days", "6 undrafted for 5 days". Ignoring
   the brief is currently silent; the whole point is to make it loud. This is
   the same failure-direction argument that drove the reject→flag changes in
   PR #393.

Dutch-required postings keep being fetched and screened (founder decision,
2026-07-31). Excluding them at source would raise effective yield ~24% for free,
but the bar would become invisible and we could never notice it shrinking. ~$3/mo
at 30/day buys that measurement.

### D8 — Daily volume 30/day

Approved 2026-07-31. Three tracks need roughly 3× the volume of one; 10/day
split three ways leaves every track permanently below `MIN_SAMPLE_FOR_PERCENTAGES`.
At 30/day each track reaches a reportable sample in ~5 weeks.

---

## Data flow

```
01:30 UTC daily
│
├─ SOURCE   pool A (ATS·NL·onsite+hybrid)
│           pool B (ATS·NL·remote  +  Indeed NL remote)
│           pool C (Indeed IN remote, EU employers)
│           → detectFeedError per pool: an outage is reported as an outage,
│             never as an empty market
│
├─ MAP      mapAtsItems / mapIndeedItems → RawPosting (one shape)
│           classifyTrack(title) → ai | backend | frontend | unclassified
│
├─ SCREEN   screenPosting() — unchanged, one shared path
│           basesForPosting(route) → gates per live permit basis → best wins
│
├─ RECORD   agents.job_applications (+track, +source, dedupe_key)
│
├─ LEARN    PASS-only → agents.cv_signals (+track)
│
├─ RANK     overlapScore(posting, cv/<track>/cv.md) → shortlist
│
├─ VERIFY   liveness on the shortlist only → live | expired | unverifiable
│
└─ BRIEF    formatDailyBrief() → Telegram
```

Everything from MAP to BRIEF is pure or DB-only. Zero model spend, unchanged.

## Error handling

- **Per-pool isolation.** One pool failing does not abort the sweep; the brief
  reports which pool failed and screens the rest. Losing pool A because Indeed
  timed out would be the pipeline failing at exactly the moment it is unattended.
- **`detectFeedError` per source.** A 5xx must never render as "0 jobs today".
- **Liveness failures are `unverifiable`, never `expired`.**
- **`screenBatch` already isolates per-posting throws.** Unchanged.
- **A missing track CV** fails that track's gap report loudly with the path that
  was tried; it never falls back to another track's CV or to the wiki.

## Testing

| unit | test |
|---|---|
| `classifyTrack` | multi-match resolves by priority; unknown → `unclassified` |
| `overlapScore` | identical CV/posting → full; disjoint → 0; same extractor both sides |
| `mapIndeedItems` | Indeed shape → `RawPosting`; malformed rows dropped, not thrown |
| `verifyLiveness` | expired → expired; network error → `unverifiable`, NOT expired |
| pool builders | A/B/C produce the documented actor inputs byte-identically |
| `formatDailyBrief` | ranked order; expired excluded from DO TODAY; outage rendered |
| migration 0019 | existing rows backfill to `unclassified` |
| `readFullCvText(track)` | resolves per-track; missing file errors, no wiki fallback |

All offline, scripted, $0 — consistent with the existing 2136-test suite. One
live run at PR time for evidence (rule #24), as with PR #393.

## Success criteria

1. `pnpm gate` exit 0; architecture baselines unchanged or shrunk.
2. Pool C returns non-zero postings — proving the `remote-contract` basis has
   real source coverage for the first time.
3. `cv_gaps({track:"ai"})` reports on AI-track signals only, with its own sample
   size.
4. A live sweep produces a brief with a ranked DO TODAY list where every row is
   verified live.
5. An expired posting is demonstrably excluded from DO TODAY **and** its reason
   is recorded — verified by seeding a known-dead job key.

## Open questions

- **O1 — RESOLVED 2026-07-31, at $0, from the vendor's schema.** The feed
  documents `hasNoLocation`: *"returns only jobs with no normalized location
  (`locations_derived` is null). Do not combine with location search, which
  would always return zero rows."* Postings with a null location therefore exist
  and are mutually exclusive with `locationSearch`. `["Netherlands"]` provably
  cannot see them. **Consequence: pool C must not set `locationSearch` at all.**
  No probe was purchased — the answer was in the input schema.
- **O2.** Indeed↔ATS cross-source duplicates: same role, different company
  string ("Adyen" vs "Adyen N.V."). `dedupe_key` exists but was built for one
  source. Needs a normalisation pass before pool B runs both sources, or the
  founder applies twice to one job.
- **O3.** Whether the daily scheduler has ever actually fired in production is
  still unobserved (carried over from the PR #393 verification).

## Verification results

**Gate — 2026-07-31, fresh, exit 0.**
`pnpm gate` → lint (tsc --noEmit) clean · wiring passed (11 pre-existing
warnings, none for `job_brief`) · arch gates green (`loc-budget: 5 (= baseline)`,
after extracting `tracks.ts` off `ats-source.ts`, which had crossed 400 lines) ·
**218 test files, 2242 tests passed**.

**Migration.** `drizzle/0020_jobhunt_outcome_pipeline.sql` applied to the local
dev Postgres and verified by inspection: `job_applications` gained `track`,
`liveness`, `liveness_checked_at`, `external_id`; `cv_signals` gained `track`;
`cv_signals_term_uniq`/`_rank_idx` are dropped and replaced by the track-scoped
pair. **The migration was inert on first run** — the file existed but was never
added to `drizzle/meta/_journal.json`, so `db:migrate` reported success without
applying it. Registering idx 20 fixed it. A hand-written migration is not
applied until the journal names it.

**Live e2e — two real runs (paid Apify), both exit 0.** Run 1 fetched 22 and
screened 22; run 2 fetched 38 and screened 38. Four defects only a live run could
find, each fixed and regression-tested:

1. **Indeed mapped 0 of 20 rows, silently.** The actor nests everything
   (`title.text`, `company.name`, `description.text`, `urls.indeed`,
   `dates.posted`, `signals.isExpired`); the mapper was written against guessed
   flat names while the output schema was unpublished. Every row died at the
   title check and the sweep reported `failures: 0`. Fixed (nested reads first,
   flat kept as fallback) and made loud: `droppedUnmappable` is now counted
   separately from `droppedThin` and surfaced as a reported failure, because
   "returned 10, usable 0" is schema drift, not a quiet market. After the fix,
   live: **NL 10→7 usable, IN 10→9 usable**. `snippet` (200 chars) now sorts
   LAST behind `description.text` (3,961 chars) — preferring it would have pushed
   every row under `MIN_DESCRIPTION_CHARS` and reported the market as thin.
2. **`DO TODAY (0)` while five roles had passed every gate.** Liveness ran on the
   top 8 rows by overlap; all 8 were FLAGs, so every PASS ended the run at
   `unknown` and was ineligible for DO TODAY. Overlap is the right order to READ
   the brief in and the wrong order to VERIFY in. `verificationTargets()` now
   spends the budget pass-first, then flags, by overlap within each group;
   rejects get none, since a legal bar's being open changes nothing. Live result
   after the fix: **DO TODAY (0) → DO TODAY (3)**, all verified live.
3. **Headlines cut mid-word** ("…permit. They c"), dropping the clause the gate
   was about to qualify. Now trims to the last complete sentence, falling back to
   a word boundary with an ellipsis.
4. **"Distributed Systems 150%".** `seen_count` is an all-time counter
   incremented on every passing screen; the denominator counted distinct rows
   standing today. The two populations differ, so the ratio can exceed 1. The
   percentage is removed rather than clamped — the brief now reports the raw
   sighting count, which is the number the data actually supports.

**Liveness discipline held.** Across both runs: `live: 6, expired: 0,
unverifiable: 2`. Rows that could not be reached were reported `unverifiable`
and never downgraded to `expired` — the loud direction, as designed.

**Per-track CVs.** `~/Projects/personal-rag/data/local_docs/cv/{ai,backend,
frontend}/cv.md` created, seeded verbatim from `cv-master.md` and headed with a
comment marking them untailored. The ingester globs `local_docs/*.md`
non-recursively, so this subtree is NOT indexed and does not pollute personal-rag.
**Limitation: until the founder tailors them, all three tracks score identical
overlap.**

### Known limitations (measured, not speculative)

- Overlap is per-track in mechanism but not yet in substance — see above.
- `classifyTrack` returns null for genuinely cross-cutting titles ("Full Stack
  Engineer"): 2 of 38 rows in run 2. This is the designed behaviour (forcing a
  guess corrupts two gap reports), but such rows score 0 overlap and sink.
  13 further `unclassified` rows are pre-0020 rows backfilled by the migration.
- Indeed rows dropped for expiry or age are not counted. Deliberate filters
  rather than failures, but the number is currently invisible.
- **O2 remains open**: cross-source duplicate detection between Indeed and the
  ATS feed is still unbuilt. Both sources now run daily, so the founder can
  receive the same role twice under two company strings. Extending
  `LEGAL_SUFFIX_TOKENS` was considered and rejected — `normaliseCompanyName`
  also backs the IND sponsor-register match, so collapsing `gmbh/ltd/inc` risks
  a **false PASS on the sponsor legal gate**, which is far worse than a duplicate.
- **O3 remains unobserved**: whether the daily scheduler has ever fired in
  production. The sweep was exercised here by direct invocation, not by the timer.
