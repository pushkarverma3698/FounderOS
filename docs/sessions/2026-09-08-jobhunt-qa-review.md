# 2026-09-08 — job pipeline QA review and systematic debugging

Second pass over the pipeline audited earlier today
([2026-09-08-jobhunt-pipeline-deep-audit.md](2026-09-08-jobhunt-pipeline-deep-audit.md)). That one
answered seven questions; this one hunts defects.

**Still audit-only — no source file changed.** Every HIGH below is *reproduced*, not inferred: one
by a failing test, one by rendering the real output, one by a live HTTP call, one by running the
real classifier. Each fix is specified and costed; none is applied.

Root-cause discipline per `superpowers:systematic-debugging`: evidence first, then hypothesis, then
the smallest fix. Where I could not reach evidence, the finding says so.

---

## HIGH — reproduced

### QA-1 · Pushkar's Telegram failure aborts the whole sweep, and the test that claims otherwise is a false green

**Evidence — failing probe, run this session** (temporary file, removed after):

```
× runFreeSweep > PROBE: keeps running the other profiles when the FIRST profile's Telegram send throws
  → Bad Request: message is too long
```

The probe never reached its assertion. `await runFreeSweep()` **itself rejected**.

Root cause, `src/tools/jobhunt/sweep-runner.ts:274-279`:

```ts
for (const profile of listProfiles()) {
  // ... "swallowing it at the loop keeps the second candidate's lane running
  //      when the first one breaks."
  await runFreeSweepForProfile(profile, sweep);
}
```

There is no try/catch. `runFreeSweepForProfile` guards `runFreeIngest` (line 288) and
`buildDailyBrief` (line 366), but **not** `publishSheet()`, `sendToChat()` or
`saveLaneHeartbeat()` — and `sendToChat` rethrows by design, unlike its sibling `sendStatusText`,
which logs and swallows.

Blast radius is wider than "Tashi is skipped":

1. Pushkar is first in `listProfiles()`, so **Tashi's lane never runs** for that tick.
2. `saveLaneHeartbeat(pushkar, afterSpokenSweep(now))` is *after* the send, so **his** heartbeat is
   not advanced either — the quiet-sweep counters and the alive-ping clock silently stall.
3. `runFreeSweep()` rejects into the cron's `.catch()`, which logs one line. The tick is gone.

**Why CI cannot see it.** `tests/unit/jobhunt/sweep-multi-profile.test.ts:108` —
*"keeps running the other profiles when one of them fails"* — injects the failure with
`runFreeIngest.mockRejectedValueOnce(...)`, which is the one site that *is* guarded. The test
asserts the property, exercises the only path that holds it, and passes. This is the same shape as
the 304-cache defect recorded last session: a test whose name describes an invariant it does not
reach.

**Fix (~5 min):** wrap the loop body in try/catch and log per profile — i.e. make the code do what
its comment already claims. Then change the existing test to inject at `sendToChat`, or add the
probe above as a second case, so the assertion covers all three unguarded calls.

### QA-2 · Tashi's brief legend states four things that are false about her

**Evidence — `renderLegend()` run against her real gate set** (from the `gate_json` of her ranked
Thales row), tags stripped:

```
📖 WHAT THE CHECKS MEAN
• Sponsor — Is this employer on the IND recognised-sponsor register? Only a recognised sponsor can
  hire you on a highly skilled migrant permit.
• Salary — Does the pay clear the permit's legal floor (€4,357/month base, under-30 band)? …
• Language — Does the posting require Dutch. If it does, you cannot be shortlisted.
• Experience — How many years the posting explicitly demands, versus your ~3.5 years shipped.
• Location — … neither the Netherlands nor India …
```

Every line except *Language* is wrong for her:

| line | printed | true for Tashi |
|---|---|---|
| Experience | "your ~3.5 years shipped" | **2.4 years** (`wife-nl-finance.ts:52`) |
| Salary | "€4,357/month, under-30 band" | **€3,122/month**, reduced criterion — the figure her rows are actually screened against (prod `gate_json`: `meet €37464`) |
| Sponsor | "Only a recognised sponsor can hire you on a HSM permit" | on **zoekjaar** no sponsor is needed at all — and the Sponsor gate is the top reason her rows land in `ask` |
| Location | "neither the Netherlands nor India" | she has **no India market** |

Root cause: `GATE_GLOSSARY` is a module-level `Record<string,string>` in `gates.ts:160`, and
`renderLegend(rows)` in `brief-row.ts:282` takes **no profile**. The glossary was written when there
was one candidate and never parameterised.

This is the founder's own rule #26 in reverse — the legend exists *because* he asked "what is this?
sponsor?", and for the second candidate it now answers with another person's CV and another
person's permit.

**Fix (~20 min):** make the glossary a function of the profile —
`gateGlossary(profile)` reading `experienceYears`, the criterion actually in force
(`criterionOn(now, profile.dob, …)`), whether any live basis has `sponsorRequired`, and
`targetCountries` — and thread `profile` through `renderLegend`. Same shape as the fix that made
`screenSalaryFacts` take a `dob` on 2026-09-04.

### QA-3 · Workday throws away a location that is already in a payload we downloaded

Michael Kors' Paris shop-floor vacancy is stored as `country='unknown', location=''`, which is what
let it survive an NL-only market filter and reach rank 2 of Tashi's `ask` section.

**Evidence — live call this session**, to the detail URL `hydrateDescriptions` already fetches for
every Workday posting:

```
GET https://capri.wd1.myworkdayjobs.com/wday/cxs/capri/michael_kors/job/Paris/Sales-Associate-CDD-28h_R_785876
  jobPostingInfo.title    = 'Vendeur(se) avec expérience CDD 28h'
  jobPostingInfo.location = 'Paris'
  jobPostingInfo.country  = {'descriptor': 'France', ...}
  jobPostingInfo.startDate= '2026-09-07'
```

Root cause: `adapters/workday.ts:177` reads location only from the **list** payload
(`asText(job["locationsText"])`), which this tenant leaves empty, and `extractBody` (line 191)
reads `jobDescription` out of the **detail** payload while ignoring `location` and `country`
sitting beside it.

Prod impact over the last 3 days: **44 `country='unknown'` rows for Pushkar, 5 for Tashi**;
lifetime she has 15 rows on route `hsm` with `country='unknown'`. `unknown` is kept by the market
filter on purpose (a genuinely remote role states no country), so every one of these is a posting
whose market we could have known and did not.

**Fix (~45 min):** add `countryFromDetail` / `locationFromDetail` to the `Adapter` interface
alongside the existing `postedAtFromDetail`, populate them in `hydrateDescriptions`, and add an
`applyDeferredMarket` step after hydration — exactly mirroring `applyDeferredFreshness`, which
already exists for the same reason (BambooHR's date only exists in the detail). `country.descriptor`
is authoritative; do not parse the URL path.

### QA-4 · A bare `"cdd"` classify term puts French retail jobs in a Dutch finance queue

Carried from this morning's audit, restated here because it is the only HIGH with a one-line fix.
Reproduced against the real `classifyTrack` and the real profile:

```
"Vendeur(se) avec expérience CDD 28h"           -> compliance-kyc
"Shop Manager Printemps Toulon - CDD 35h"       -> compliance-kyc
"Printemps Haussmann, CDD 8h/semaine (samedis)" -> compliance-kyc
"Conseiller de vente CDD 35h"                   -> compliance-kyc
```

In French postings **CDD = contrat à durée déterminée**. `wife-nl-finance.ts:242` lists `"cdd"` as a
bare `classifyTerm`; `matchesAsWholeWord` finds it flanked by spaces in every such title. The same
file already argues this exact case for `finance-ops` ("Bare 3-letter acronyms deliberately
excluded — 'OTC' collides with over-the-counter trading") and did not apply it here.

**Fix (~10 min):** drop `"cdd"` from `classifyTerms`. `"CDD Analyst:*"` and
`"Customer Due Diligence Analyst:*"` stay in `titles`, which is a substring match on the title and
does not fire on the bare acronym. `"kyc"` and `"aml"` are safe. Then delete the 3 rows and rerun
her brief to free `ask` #2.

---

## MEDIUM

### QA-5 · `review_screened` — the audit tool — reports the wrong criterion and cannot filter 94% of the rows

Two defects in the tool whose stated purpose is *"a gate that wrongly rejects is otherwise
invisible"*.

**(a) The health line ignores the profile.** `review.ts:38` calls `criterionOn(now)` with no `dob`
and no orientation flag, so it falls back to the module default `FOUNDER_DOB` (`criteria.ts:18`).
Running `review_screened profileId=wife-nl-finance` prints
`✓ Salary criterion in force: IND 2026 under-30 criterion, €4357/month` above a list of rows every
one of which was screened against €3,122/month. The tool contradicts its own data.

**(b) The route filter knows two of five routes.** `review.ts:25`:

```ts
const VALID_ROUTES = new Set(["hsm", "remote-contract"]);
```

`zoekjaar`, `partner-permit` and `india-local` are rejected with
*"route must be one of: hsm, remote-contract"*, and the input-schema description repeats the same
two. Prod distribution:

| route | pushkar | wife | filterable? |
|---|---|---|---|
| india-local | 1,144 | 56 | ✗ |
| partner-permit | 382 | — | ✗ |
| zoekjaar | — | 26 | ✗ |
| remote-contract | 54 | 2 | ✓ |
| hsm | 25 | 16 | ✓ |

**97 of 1,705 rows (5.7%) can be filtered.** Tashi's primary basis cannot be queried at all.

**Fix (~15 min):** derive `VALID_ROUTES` from `KNOWN_PERMIT_BASES` (`permit-routes.ts:32`) instead of
a literal, and pass `profile.dob` + the orientation flag into `pipelineHealth`.

### QA-6 · The reduced IND criterion is modelled as a permanent property of the person

`screen.ts:251` passes
`isOrientationYearSwitcher: profile.permitBases.includes("zoekjaar")` into every route's salary
gate, and `criteria.ts:78` then short-circuits the age band entirely:

```ts
const band = isOrientationYearSwitcher ? "reduced" : bandOn(date, dob);
```

Today this produces the right number: Tashi is on the orientation year, so the *verlaagd
salariscriterium* does apply to an HSM switch. But the real rule is **time-bounded** — it applies
within three years of the orientation year or Dutch degree — and nothing here models an expiry. The
flag is a string membership test on a profile constant, so it stays true forever. When it lapses,
the pipeline will keep clearing roles at a floor **28% below** the lawful one and say nothing.

That is the silent-permissive direction, which `permit-routes.ts:18-23` explicitly names as the
failure this module exists to prevent: *"Lowering it does not create opportunities; it manufactures
applications that cannot lawfully succeed, and their failure arrives weeks later as silence."*

Second-order effect, visible in prod today: the same route now carries two different legal floors
depending on when the row was screened, and nothing rescreens.

```
wife-nl-finance · route=hsm · 9 rows judged against €52,284/yr   (before 2026-09-07)
wife-nl-finance · route=hsm · 6 rows judged against €37,464/yr   (after)
```

`/jobs` renders both sets side by side as if comparable.

**Fix (~30 min):** carry the basis for the reduced criterion as a dated fact on the profile
(`zoekjaarEndsOn` / `reducedCriterionUntil`) and have `criterionOn` return the standard band once
the date passes — the same treatment `CRITERIA`'s own validity windows already get, and for the same
stated reason ("a bare `4357` literal … silently becomes a wrong legal floor").

### QA-7 · The registry's self-growth mechanism is structurally dead

`/opt/founderos-data/free-ats-discovered.csv` does not exist on the box, and every aggregator sweep
logs `tokens: 0`. Two independent causes, both confirmed by call graph:

1. **The only caller of the harvest lifecycle is the disabled lane.**
   `startBoardHarvest` / `collectBoardTokens` / `flushBoardHarvest` are called from `ingest.ts`
   (lines 238, 370) and nowhere else. `ingest.ts` is `runPooledIngest`, the metered sweep, whose
   `cron.schedule()` was removed on 2026-08-21. **Nothing has harvested a board since.**
2. **The free lane computes tokens and throws them away.** `sweep-runner.ts:263-268` receives
   `aggResult.harvestedTokens` and only `log.info`s the count — `registerDiscoveredBoard` is never
   called. It could not be called as written anyway: `harvestedTokens` is `ExtractedBoardToken[]`
   (`{ats, token}`), while `registerDiscoveredBoard` needs `name` and `markets`, which only
   `harvestNewBoardTokens` produces.

A third reason the count is zero even before that: three of the four aggregators map their **own**
landing URL (`arbeitnow.ts:50`, `remotive.ts:50`, `jobicy.ts:49` all read `raw.url`), which can
never match an ATS pattern. Only `himalayas.ts:59` reaches for `applicationLink`.

The module header's claim — *"one aggregator sweep discovers boards that every future ATS sweep
polls directly, forever"* — describes a mechanism that has never once fired.

**Compensating control exists but is undocumented as such:** `scheduler.ts:349` sends a monthly
Telegram reminder to run `pnpm jobhunt:import-boards` by hand. That is currently the *only* way the
registry grows.

**Fix (~30 min):** in `runFreeSweep`, replace the log with `collectBoardTokens` +
`flushBoardHarvest` over the aggregator candidates (which carry `company`, so `harvestNewBoardTokens`
works); and add a test asserting the discovered file is written. Separately, decide whether
`himalayas.applicationLink` is worth keeping as the only real token source.

### QA-8 · `MIN_EXPECTED_BOARDS` was not raised with the registry

`free-boards.ts:251` is still `1100` against a 3,223-row file — 34%. The constant's own comment
states the rule it is now breaking: *"A floor that is not moved with the file stops being a floor:
left at 200 it would have gone on passing while two thirds of the registry silently failed to
parse."* One-line fix; ~2,700 is consistent with every previous raise.

### QA-9 · `parseBoardRegistry` drops malformed rows silently

`free-boards.ts:287` — `if (platform === null || slug.length === 0) continue;` — no counter, no log.
Verified clean today (3,223 CSV rows → prod logs `boards: 3223`, 0 duplicate `(ats,token)`, 0 blank
tokens), so this is a guard gap rather than a live loss. Given QA-8, the 1100 floor is the only
thing standing behind it. Return a `skipped` count and log it in `getFreeBoards`.

---

## LOW / latent

### QA-10 · `setAtsCache` issues ~70,000 no-op DELETEs a day

`src/db/ats-board-cache-queries.ts:11` deletes the row whenever the response carries no ETag.
Prod cache composition:

```
greenhouse 554 · personio 158 · other 1,058 · (workday 0, bamboohr 0) — etag NULL on 0 rows
```

So ~1,450 of 3,223 boards never send an ETag and take a `DELETE` on every one of the 48 daily
sweeps. Semantically correct (invalidate a stale validator), operationally pointless for a platform
that has never sent one, and it is why autovacuum runs on this table every sweep. Skip the delete
when there was no prior row, or track which platforms are conditional-request capable.

*(The table itself is healthy — 1,770 rows, 124 MB, 2 dead tuples, autovacuum current. The
previously-flagged "no TTL" risk does not currently materialise, because the URL key set is fixed.)*

### QA-11 · Dead code that still makes claims

| what | where | note |
|---|---|---|
| `DEFAULT_MAX_ENTRIES`, `CacheEntry` | `free-ats-cache.ts:25,27` | zero references since the cache moved to Postgres; the file header still says *"bounded"*, which is no longer true of the Postgres cache |
| `LIVE_PERMIT_BASES` | `permit-routes.ts:53` | no `src` reference (the only hit is inside a comment) — but **two tests assert on it**, so CI pins a constant production never consults |
| `listRecentApplications` | `job-queries.ts:566` | zero callers |
| standing pool | `brief-select.ts`, `brief.ts`, `listStandingApplications` | deliberately dead per the 2026-09-07 fresh-only decision, and correctly documented as such — listed only for completeness |

The `LIVE_PERMIT_BASES` one is the harmful shape: a green test over an unread constant is negative
value, because it reads as coverage of a rule the runtime does not apply.

### QA-12 · Aggregator jobs can trigger bogus Greenhouse fetches

`aggregator-source.ts:39-45` gives every aggregator candidate a synthetic board with
`ats: "greenhouse"`, justified by *"they never need body hydration — they already carry their
description"*. But `toFreeCandidate` sets `description: null` when the aggregator returns an empty
body, so `hydrateDescriptions` builds
`boards-api.greenhouse.io/v1/boards/aggregator-<source>/jobs/<id>` and fetches it: a 404 at a third
party, and a `bodyless` drop labelled `greenhouse detail-empty` that names the wrong platform.

Not firing today (the 08:03 sweep's breakdown was `personio inlined-empty ×1, workday detail-empty
×1`), but nothing enforces the invariant the comment asserts. Skip hydration for synthetic boards,
or drop empty-description aggregator jobs at `toFreeCandidate` with their own counted reason.

### QA-13 · Cross-profile vocabulary is separated only by coincidence

`cv_signals` has `tenant_id, term, category, track` and **no `profile_id`**
(`schema.ts:1208`), and `recordSignals(...)` (`screen.ts:320`) passes only `{ track }`. Likewise
`countPassingApplications({ track })` — which feeds the trends block printed in *both* candidates'
briefs — is scoped by tenant and track only.

This is correct today purely because the two profiles' track ids happen not to collide
(`ai/fullstack/backend/frontend` vs `fpa/finance-ops/compliance-kyc/auditor/accountant`). One shared
id is already present in the table — `unclassified`, 10 terms — though no current
`job_applications` row carries that track, so nothing is being contaminated right now.

Given that PR #634 exists specifically to stop `tailor_cv` fabricating skills from the wrong
vocabulary, a `profile_id` column, or at minimum a cross-profile track-id uniqueness check in
`registerProfile`, is cheap insurance.

### QA-14 · Two verbatim copies of `resolveProfileFilter`

`src/tools/job-state.ts:112` and `src/tools/jobhunt/jobs-csv.ts:45` are the same nine lines,
character for character, and `src/gateway/jobhunt-profile-arg.ts` is a third profile-resolution
surface. Profile resolution is exactly the kind of rule that must not drift between the tool that
lists rows and the tool that exports them.

### QA-15 · `todaysSpend` is tenant-wide

`daily-brief.ts:294` calls `summariseSpend(since)` with no profile, so the cost line in Tashi's
brief reports the tenant's spend. Currently $0 everywhere (the metered lane is off and the free lane
records zero), so there is no live wrong number — it becomes one the day the metered lane is
re-enabled.

---

## What I checked and found sound

Recording these so the next pass does not re-derive them:

- **`combineVerdict` / `blockingGates`** (`gates.ts:49,67`) — reject absorbing, flag next, and the
  blocking set filtered on status rather than position. This is the fix for the original 2026-08-01
  defect and it holds.
- **`basesForPosting` + `isLiveBasis`** (`permit-routes.ts:283`) — a definite route that matches no
  live basis returns the non-live candidate so `screen.ts:237` can reject *honestly*. Verified in
  prod: all 56 of Tashi's `india-local` rows are `country='IN'` and were rejected, not carried under
  a Dutch permit.
- **`countryFromLocation`'s market-scoped fallback** (`country.ts:312`) — the 2026-09-07 fix holds;
  no India-located row has entered Tashi's lane since 2026-09-07 15:01.
- **`profileCondition`** (`job-queries.ts:36`) — defaults to `DEFAULT_PROFILE_ID`, not "all", so
  `/csv` and `job_state` without an argument return one queue rather than a mix.
- **`queryJobState`** — profile-scoped as of 2026-09-07; `total` is documented as a deliberate
  cross-profile denominator and the tool description says so.
- **`ja_brief_rank_uniq`** — `(tenant_id, profile_id, brief_section, brief_rank)`, so `/draft N`
  cannot collide across candidates.
- **Liveness's three outcomes** (`liveness.ts`) — `unverifiable` kept distinct from `expired`, with
  the asymmetry argued in the header. Prod: 60 checked, 57 live, 1 expired, 2 unverifiable.
- **The 304 re-ask** (`free-ats-transport.ts:84-98`) — last session's fix is in place and correct.

---

## Metrics

- Files read this pass: 24 source, 2 test, 3 data.
- Findings: **4 HIGH (all reproduced) · 5 MEDIUM · 6 LOW**.
- Reproductions run: 1 failing vitest probe, 1 legend render, 1 live Workday `GET`, 1 classifier
  run. Probe file deleted after use; **no source or test file was modified**.
- Gates on this branch: `verify:branch` 0 · `verify:arch` 0 · `verify:doc-claims` 0.

---

## Outstanding — ranked by value per minute

1. **QA-4** (`"cdd"`) — 10 min. Removes a French retail job from Tashi's `ask` #2.
2. **QA-1** (loop try/catch + fix the false-green test) — 15 min. Removes a single point of failure
   between Pushkar's Telegram and both candidates' sweeps.
3. **QA-5** (`VALID_ROUTES` + profile-aware health) — 15 min. Makes the audit tool able to see 94%
   of the table.
4. **QA-2** (profile-aware glossary) — 20 min. Stops printing another person's CV and permit in her
   brief.
5. **QA-3** (Workday detail location) — 45 min. Recovers a market signal on ~400 boards, and is the
   structural half of QA-4.

Then, in a second batch: QA-6 (dated reduced criterion — the only finding with a legal failure
mode), QA-7 (revive board harvesting), QA-8/QA-9 (registry guards).

**Nothing here is applied.** Say which numbers to take and I will do them as one PR to `beta`, each
with the failing test first per the repo's bug-fix rule.
