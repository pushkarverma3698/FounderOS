# Jobhunt: reach the queue, then make applying easy

**Date:** 2026-08-24
**Status:** approved by the founder, 2026-08-24
**Supersedes nothing. Extends:** `docs/plans/2026-08-20-jobhunt-apply-queue-and-registry.md`

---

## 1. The problem, measured

Production, 2026-08-24. Every number here was read off the box, not estimated.

### The apply funnel

| rows in `agents.job_applications` | count |
|---|---|
| screened + actionable (`stage='screened'`, verdict pass/flag) | **464** |
| inside 7 days | 73 (21 NL) |
| inside 72 hours | 17 |
| **inside the 24h window `/draft` can address** | **3** |
| applications, lifetime | **2** |
| `deliver_artifact` calls in the last 30 days | **0** |

`APPLY_QUEUE_MAX_AGE_HOURS` is 24 (`src/db/job-queries.ts:32`). `/draft N` resolves
through `brief_rank`, and only rows the brief printed carry one. The last brief
pinned three rows — Putnam, Experian, DevRev, all India — while **52 NL
recognised-sponsor salary-pass roles**, 11 of them confirmed still open, sat in the
table with no command that could reach them.

### The supply funnel

One sweep, 08:00 UTC, from `agents.job_ingest_runs`:

```
38,169 seen from 623 boards
   -23 undated
-25,394 stale (>720h)
-11,167 off-track
 -1,252 off-market
   -320 already known
    -12 bodyless
──────
     1 screened
```

The IND recognised-sponsor register holds **12,883** companies. The board registry
covers **831** of them — **6.4%**.

### What is NOT broken (checked, so nobody re-opens it)

- **PDF rendering.** Chromium 1228 is installed on the VPS and matches Playwright
  1.61's expected revision. Workwize rendered successfully 2026-08-22.
- **Body hydration.** Live probe with real registry tokens: Greenhouse returns
  6.9–10.3 KB bodies, SmartRecruiters returns full `jobDescription` +
  `qualifications`, both HTTP 200. The 12 `bodyless` are a fixed set of specific
  postings whose list payload is genuinely empty (~1% of Lever's), not a leak.
- **Crawling the sponsor tail.** Probed 40 of the 12,052 uncovered sponsors: naive
  name→domain resolution succeeded for 13 (33%), and **zero** of those 13 exposed
  an ATS link or `JobPosting` JSON-LD on any standard careers path. The tail is
  20-person B.V.s posting 1–2 roles a year. It is not the lever.

### The binding constraint

**Reach, then friction — not supply.** 464 roles are screened and 3 are reachable.
A real Greenhouse application form, measured live (Workwize, 4938710101), has **48
inputs**: 8 mechanisable (name, email, country, phone, LinkedIn, résumé, cover
letter) and 40 spread across 7 custom questions.

---

## 2. Design

### Phase 1 — Reach

**1.1 Widen the window.** `APPLY_QUEUE_MAX_AGE_HOURS` 24 → 168, overridable by env.
Fresh rows still sort first, so the speed advantage is kept; nothing screened is
invisible.

**1.2 Decouple rank assignment from display cap.** Today `persistBriefRanks` pins
ranks only over the *capped* selection, so `/draft` can address at most
`DO_TODAY_CAP + STRETCH_CAP` = 10 rows. Change: `selectDoToday`/`selectStretch`
return the **full ordered allocation**; the renderer prints a prefix
(`.slice(0, CAP)`) and states the overflow, which it already does via
`overflowNote`. Because display is a prefix of the ranked order, the printed
number and the pinned rank still agree by construction — the property
`brief-select.ts` exists to guarantee.

**1.3 `/csv` gains a `rank` column.** The spreadsheet becomes the working surface:
he picks any number off it and `/apply 34` resolves, even though the Telegram
message showed six rows.

**1.4 The answer profile.** `/opt/founderos-data/apply-profile.json`, read through
`ARTIFACT_ROOT`-style config, with a `/profile` command to print it and a
`/profile set <field> <value>` to edit one field. Seeded from `cv-master.md` and
personal-rag, then corrected by the founder.

Recorded from the founder, 2026-08-24: **requires visa sponsorship today** — the
partner permit is applied-for and pending, so the working route is HSM + MVV and
the €52,284 salary floor stays a hard gate. If the permit is granted this is one
field, and the sponsor gate relaxes.

**1.5 Two defects.**
- `src/gateway/jobhunt-commands.ts:184` advertises a "Mac Client" that exists
  nowhere in the repository. Replaced with what actually exists.
- `recordLiveness` writes `notes: opts.reason` (`src/db/job-queries.ts:365`),
  clobbering the failure reason `recordTailoringResult` wrote. 14 of 16 failed
  tailorings have lost their reason. Fix: a dedicated `tailor_note` column.

### Phase 2 — The autofill core, and the bookmarklet driver

**2.1 One pure function is the brain for all three drivers.**

```
buildFillPlan(fields: FormField[], profile: ApplyProfile, row: RowFacts)
    → FillAction[]
```

```ts
type FillAction =
  | { selector: string; kind: "value";  value: string;   confidence: number; why: string }
  | { selector: string; kind: "choose"; option: string;  confidence: number; why: string }
  | { selector: string; kind: "file";   path: string;    confidence: number; why: string }
  | { selector: string; kind: "ask";    question: string;                    why: string };
```

Pure, no DOM, no network, no model. Unit-tested against real form schemas captured
from Greenhouse, Lever, Ashby, Workable and Recruitee and committed as fixtures.
Target on the measured Workwize form: **41 of 48 filled, 7 `ask`**.

**2.2 The eligibility rule is a mechanism, not a guideline.** On any field whose
label matches the work-authorisation / visa / right-to-work family, an option is
chosen only on a high-confidence match; anything else emits `ask` and fills
nothing. A wrong answer there is not a typo, it is a false statement on an
application. Enforced by the type — the eligibility matcher returns
`FillAction & {kind:"choose"|"ask"}` and has no path to a low-confidence choose.

**2.3 The bookmarklet needs no new infrastructure.** `/apply N` returns a link
whose **fragment** carries the payload (profile + row facts, ~1–2 KB, base64).
Fragments are never sent to a server, so nothing lands in an access log. The
matching logic ships as a browser bundle built from the same TypeScript core, so
there is one source of truth and the unit tests cover the browser path.

**v1 does not attach files.** Setting `input[type=file]` programmatically requires
constructing a `File` from fetched bytes, which needs a reachable CV URL and CORS.
The founder drags the PDF and the cover letter in from Telegram: 2 drags instead
of 48 fields. Revisited only if the drags turn out to be the friction.

### Phase 3 — Supply

**3.1 Workable platform-wide source.** Measured live, 2026-08-24:

```
https://jobs.workable.com/api/v1/jobs?location=Netherlands&day_range=1&limit=20
```

| | NL | India |
|---|---|---|
| open now | 1,458 | 4,000 |
| **posted in last 24h** | **20** | **55** |

Free, key-less, cross-customer — every Workable customer, not the 94 boards we
poll. Returns the **full description inline**, an exact `created` timestamp, the
company, `company.website`, and a direct apply URL. `limit` caps at 20; cursor
paging via `nextPageToken` (verified: 106 rows over 6 pages for `day_range=7`).
Cost per sweep: ~6 requests per market.

New concept alongside boards: a `PlatformSource` with
`fetchRecent(market, sinceHours) → NormalizedJob[]`, whose output joins
`sweep.candidates` before `filterCandidates`. Dedupe is already
`dedupeKey(company, title)`, so a role reachable both ways collapses naturally.

Against a lane currently producing 1–5 screened rows a day, this is the supply
answer. SmartRecruiters (401), Greenhouse, Lever, Ashby and Recruitee have **no**
cross-customer endpoint and stay per-board.

**3.2 Company harvest.** The feed names every company and its website. Feed that
into board discovery so the registry grows from traffic we are already paying for
in requests.

### Phase 4 — The other two drivers

**4.1 Mac client.** Playwright on the laptop. Opens each row's form, applies the
fill plan, **stops at Submit**. Batches several rows in one run.

**4.2 VPS headless + Telegram confirm.** Fills headlessly, screenshots, sends a
HITL card; on approve, clicks Submit and writes the audit row.

**ADR-018 reading, stated rather than assumed:** ADR-018 says the machine never
submits an application. 4.2's Submit click follows an explicit founder tap in
Telegram. That tap is the human approval ADR-018 requires. Flagged to the founder
2026-08-24 and not contradicted.

---

## 3. What would make this wrong

**"Giving him 73 roles won't help — he applied twice with 3 available, so the
friction is the 48 fields."** Partly right, and it decides the *ordering*, not the
content. Autofill without reach fills forms for three India roles he does not
want. Reach without autofill is 73 roles at 48 fields each. He needs both; reach
is a one-line change and autofill is a day's work, so reach goes first.

**"The bookmarklet needs a desktop browser and he lives on Telegram on his
phone."** True, and it is why all three drivers were approved. 4.2 is the phone
answer. It is also the riskiest, so it ships last, on a fill-plan core the other
two drivers have already proven.

**"Phase 3 duplicates `feat/job-intelligence-phase-2-3`."** That branch is
unmerged and carries a `sitemap-poller.ts` plus a `company_sources` migration
aimed at the same problem, along with a stray `test_vertex.py`. Fold what is good
into 3.2 rather than merging it as-is.

---

## 4. Success criteria

1. `/jobs` reaches ≥ 20 rows, `/draft`/`/apply` resolve any of them. *(Measured
   against prod: 3 → 73.)*
2. `/apply N` on a live Greenhouse posting fills ≥ 35 of 48 fields, and fills
   **zero** eligibility fields on a low-confidence match.
3. One sweep after Phase 3 records Workable platform-source candidates in
   `job_ingest_runs`, and the screened count rises above the current 1–5/day.
4. At least one real application submitted, with an `action_log` row for it.

Criterion 4 is the only one that matters. The others are how it becomes possible.
