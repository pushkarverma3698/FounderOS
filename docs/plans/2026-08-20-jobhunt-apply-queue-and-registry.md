# Jobhunt: a 24-hour apply queue, fed by a registry that compounds

Date: 2026-08-20

## Context

You asked to merge `ai-job-search` into FounderOS. Two directives shaped the final plan:

1. **The apply queue should hold only jobs under 24 hours old** — "think how it happens in the
   real world." A posting older than a day already has hundreds of applicants; showing it is noise.
2. **The free lane's company registry should grow by itself** — harvest tokens from the paid sweep
   and the IND sponsor register so coverage compounds instead of staying at 285 boards.

You also asked directly: *"this will help us find new jobs from new companies over time via the
free lane?"*

### The answer, measured

**Yes — but not with the three ATS platforms the free lane currently supports.**

I probed the IND sponsor register with a validated instrument (7/7 known-live tokens returned 200
with real job counts; a fake token returned 404):

| Platform set probed against 12,884 IND sponsors | Hit rate | Boards found |
|---|---|---|
| Greenhouse + Lever + Ashby (what we support today) | **0.36%** (1 of 280) | ~46 |
| Recruitee + Personio + Homerun (what Dutch firms use) | **2.50%** (5 of 200) | **~322** |

I had estimated 3–5% for the first row. The measured figure is **0.36%** — I was wrong by an order
of magnitude. The IND register is overwhelmingly non-tech Dutch SMEs that do not use US-centric ATS
platforms. Every strict-slug hit on the NL-native platforms was an exact, verifiable match:
`recruitee/dalsem` ← Dalsem B.V., `recruitee/netconomy` ← Netconomy Netherlands B.V.,
`recruitee/ravo` ← Ravo Holding B.V.

So the registry grows ~322 boards — **more than doubling 285** — and every one is an IND-recognised
sponsor, i.e. a company that can legally carry your HSM permit. That is a better pool than the
current registry, whose own header admits a gaming-company skew.

### On dropping Apify

Your rule was: if it finds the same companies, drop it. The measurement: **80 distinct ATS tokens
lifetime, 70 already in the registry — 12.5% novelty, ~10 new boards ever.** As a *company
discovery* engine it is marginal, because the actor is capped at 10 postings per query (560
requested, 228 returned, lifetime).

**But don't drop it yet.** The IND probe only covers the Netherlands. Apify is the only source that
finds companies in your India and EU-remote pools. Re-scope it to that, instrument it, and let the
data decide: if three consecutive sweeps discover **zero** new boards, it has stopped earning its
cost and we drop it then.

### Two live defects found while auditing

- **The metered lane has been dead for 198 hours.** Last `ats`/`indeed` run: 2026-08-12 01:30.
  Three scheduled windows (`30 1 */3 * *`) missed. Needs its own investigation — it is why token
  harvesting has had zero input for eight days.
- **Your apply queue has no fresh rows at all.** Age buckets of `stage='screened'`: **zero under
  24h**, 15 at 24–90h, 117 at 133–237h, 48 over 720h. Median ≈ 8 days. This is the graveyard that
  produced 2 applications from 334 postings.

---

## Audit of the Antigravity work

`aaf2280` committed **4 of 12 files**; the other 8 sit in `stash@{0}` on a different lineage
(`beta`@e2e0adc). Everything below is verified, not read.

| Finding | Evidence |
|---|---|
| **The daily sweep is never scheduled.** `JOBINDEX_SWEEP_CRON` is referenced by nothing; `runJobindexSweep` isn't committed at all | grep over `src/ scripts/ tests/` |
| `jobindex-source.ts` is committed and imported by nothing — dead code. `verify:arch` stays green because `orphan-subsystem` is directory-scoped | `pnpm verify:arch` → green |
| **`pnpm gate` FAILS** on the stash: `fail-open-catch: 13 (baseline 11)`, both new ones from `runIndSponsorUpdate` | gate run in an isolated worktree |
| **`extractBoardToken` misses 65% of real ATS URLs** — accepts only `boards.greenhouse.io`, prod is mostly `job-boards.greenhouse.io` | exact regex over 209 prod URLs: **74 matched, 135 missed** |
| **The detail scraper drops ~70% of postings silently.** `/jobannonce/<tid>` redirects off-site to recruitee/hibob/workday where its markers don't exist | live probe: **3 of 10** parsed, 5 off-site |
| **Its failure path cannot fire.** Detail errors only `log.warn`; null bodies `continue`. The alert needs `failures.length > 0 && seen === 0` — unreachable when search works and detail fails | code trace |
| **The harvester hook can break every lane.** It sits between `screenPosting` and the verdict push, inside the `try` — a throw turns a successful screening into `outcome: "error"` in *all* lanes | `ingest-batch.ts` ordering |
| It appends to `docs/strategy/data/free-ats-boards.csv` — git-tracked, inside the prod deploy tree | `FREE_BOARDS_PATH` |
| `postedAt: new Date()` fabricates the posting date, defeating any freshness filter | `jobindex-source.ts` |

**What was right and must be kept:** the search-page parser. `var Stash =` extraction and
`findSearchResponse` worked 20/20 against live HTML.

---

## Phase 1 — A real 24-hour apply queue

Branch: `feat/jobhunt-apply-loop` off `origin/beta`.

The queue and the sweep rate are one change. A 24h window with a daily midnight sweep would make a
job posted at 00:30 invisible until it is 23.5h old, then expire it 30 minutes later.

### 1.1 Restore the 30-minute free sweep
`sweep-runner.ts`: `FREE_SWEEP_CRON` back to `*/30 * * * *`. A job posted at 03:00 is in your queue
by 03:30 and stays ~23.5h. Also fix the docblocks — they still say "Every 30 minutes" and "48 times
a day" while the value has been daily since `ec8cbee`.

Restore the `*/30` assertion in `tests/unit/jobhunt/free-sweep.test.ts`.

### 1.2 The queue only shows jobs under 24h
`db/job-queries.ts` — `listActionableApplications` gains
`gte(jobApplications.posted_at, now - 24h)`. `posted_at` is populated on **334/334** prod rows, so
this works today with no migration.

Aged-out rows are **filtered, never deleted** — they stay as market evidence and for
`verifyLiveness`. Make the window an env-tunable constant (`APPLY_QUEUE_MAX_AGE_HOURS`, default 24)
so it can be widened without a deploy.

### 1.3 An empty brief must never be ambiguous
`brief-sections.ts` prints a standing line: `12 fresh roles · 319 older roles aged out of the
queue`. Without it, "no fresh jobs today" and "the lane is broken" look identical — the ambiguity
this repo has already lost weeks to. Expect the brief to look near-empty for the first few hours
after this ships; that is the graveyard clearing, not a fault.

### 1.4 `/draft N` produces a real tailored CV PDF
Everything needed already exists and is unwired. Verified present on prod: chromium-1228,
`STORAGE_BUCKET` + AWS creds, and your four per-track CVs at `/opt/founderos-data/cv`.

`src/gateway/jobhunt-commands.ts` — replace the `draftInstruction` → kernel path with:

1. Immediate ack (`Tailoring your CV for <company>…`) — this takes 20–40s.
2. `tailorCv({ jobDescription, companyName, jobTitle, track })` — `tailor-cv.ts`, already has the
   slop check and revision loop. It calls `readFullCvText(track)`, which resolves the right
   per-track CV from `PERSONAL_CV_DIR`.
3. `renderCvToPdf(markdown)` — `cv-renderer.ts`, ATS-safe single-column PDF.
4. `deliverArtifactFile(...)` — `tools/deliver-artifact.ts`, lands the PDF in Telegram.
5. `recordTailoringResult(row.id, { tailorStatus: "tailored", tailoredCvS3Key })`.
6. **On any failure, fall back to the existing kernel path** and say which one ran. A failed tailor
   must never mean no draft.

Tailor **on demand**, not in a batch. `processUntailoredApplications` would spend an LLM call per
screened row you may never open; with a 24h queue most rows expire unopened. The worker stays
available for a future batch mode.

### 1.5 `/applied N` — drain the queue
New handler using the same `handleRowCommand` row resolution, calling the existing
`updateApplicationStage(id, "applied")`. Delete the stale assertion at
`tests/unit/evolution/acceptance-rederive.test.ts:48` that expects it to be dead.

### 1.6 Make the commands visible
`brief-row.ts` prints `→ /draft N · /applied N` on every row; `commands.ts` adds `/applied <n>` to
help. A command nobody is told about is the same as no command.

---

## Phase 2 — Make the registry compound

Branch: `feat/jobhunt-supply` off `origin/beta` after Phase 1 merges.

### 2.1 Add Recruitee and Personio to the free lane
This is the unlock — without it the sponsor probe returns ~46 boards instead of ~322.

`free-boards.ts`: `FreeAts` += `"recruitee" | "personio"`.
`free-ats-source.ts`: extend `boardUrl()` — both serve public unauthenticated endpoints, same shape
as the existing three:
- recruitee: `https://<token>.recruitee.com/api/offers/` → `offers[]`
- personio: `https://<token>.jobs.personio.de/xml` → `<position>` elements

`free-ats-mappers.ts`: a mapper per platform into `RawPosting`, mirroring the Greenhouse one.
Prod already holds rows from both, so the fixtures come from real data.

### 2.2 Probe the IND register for boards
`scripts/probe-sponsor-boards.ts` — reuses `boardUrl()`/`fetchBoard()`:

- **Strict slugs only**: full name minus legal suffixes (`B.V.`, `N.V.`, `Holding`, `Nederland`),
  joined and dashed. **No first-word fallback** — it matched real boards belonging to *different*
  companies (`lever/blue` is not "Blue Ocean Engineering B.V."). A wrong board is worse than none.
- ~5 platforms × 2 slugs × 12,884 = ~129k free HTTP requests, rate-limited, run once over a few
  hours. Zero LLM.
- Writes hits to the discovered registry (2.3), never to the curated CSV.
- Re-runnable: the IND sync cron (2.5) refreshes the register on the 1st and 15th; new sponsors get
  probed, so **the registry keeps growing without Apify**. That is the compounding loop you asked
  for.

### 2.3 Discovered boards live outside the repo
`registerDiscoveredBoard` currently appends to a git-tracked file inside the prod deploy tree — the
next `git pull` conflicts or wipes it.

- New file at `FREE_ATS_DISCOVERED_PATH`, default `/opt/founderos-data/free-ats-discovered.csv`,
  same pattern as the CVs.
- `getFreeBoards()` returns curated **+** discovered, deduped on `(ats, token)`.
- `MIN_EXPECTED_BOARDS` keeps checking the curated file only, so a missing discovery file is
  harmless rather than fatal.
- Market column: write `NL`/`IN`/`DK` only when the country is *positively* that. Today
  `country === "IN" ? "IN" : "NL"` files every `other`/`unknown` company as Dutch.

### 2.4 Harvest at the fetch boundary, not after screening
This is your correction and it is right: a posting we reject is still evidence that its company has
a board worth polling forever.

- Move the hook out of `screenBatch` to the raw fetch in `ingest.ts` (`runPooledIngest`, after
  `fetchAtsPostings`, before `dedupePostings`). Sees **228** postings instead of 83.
- Harvest **after** the verdict is recorded, in its own try/catch that only logs, so a filesystem
  error can never corrupt a screening result.
- Collect tokens across the batch and write **once** at the end — the current per-posting
  read + append + cache-reset cycle re-parses the whole registry on every discovery.
- Also mine Indeed's `urls.external` / `applyUrl` — `indeed-mappers.ts` already reads them, and
  they frequently point at an ATS.
- Fix the extractor regexes (measured 74/209 → 209/209):
  `(?:job-)?boards(?:\.eu)?\.greenhouse\.io`, `jobs(?:\.eu)?\.lever\.co`, `jobs\.ashbyhq\.com`.
  **Delete `ExtractedFreeAts`** — it duplicates `FreeAts` and will drift.

### 2.5 Instrument Apify so the drop decision is data, not a guess
- `job_ingest_runs` gains `new_boards_discovered`.
- The sweep alert carries one extra line: `+3 new companies now polled: Speechify, IMC, Roadie` —
  inside the existing message, never its own. `publishSheet` already documents why: two
  notifications for one event is how a channel becomes noise. (This answers the open question in
  your plan doc.)
- **Drop rule:** three consecutive metered sweeps with `new_boards_discovered = 0` and the paid
  lane is only buying jobs, not companies. Revisit then.
- Keep `runIndSponsorUpdate` (1st & 15th) — it feeds 2.2. Tag both
  `sendToChat(...).catch(() => {})` calls with `// allow-failopen: <reason>` or the arch ratchet
  blocks the merge, and add a timeout to the spawned child; today it can hang forever under
  `stdio: "ignore"`.

### 2.6 Fetch window
`free-ingest.ts`: `FREE_LANE_MAX_AGE_HOURS` **24 → 72**. With a 30-minute sweep the extra 48h costs
nothing (the tracker drops known postings before any body fetch) and it means a restart or deploy
can't punch an unrecoverable hole. The display window stays 24h — fetch wide, show fresh. Rewrite
the comment above it; it still describes 720 and a 30-minute interval.

---

## Phase 3 — Denmark and Jobindex

Only after Phase 1 proves you are actually applying. Jobindex's realistic yield is a fraction of
~322 new Dutch sponsor boards, and a Danish role is worth nothing until the apply loop works.

### 3.1 Denmark as a real market
Mirror the Dutch model; do not special-case.

- `country.ts`: `PostingCountry` += `"DK"`; `DK_NAMES`/`DK_CITIES`; `countryName("DK")`;
  `toPostingCountry` accepts it.
- `route.ts`: `PostingRoute` += `"denmark"`, returned when `country === "DK"`.
- `permit-routes.ts`: `PermitBasis` += `"denmark-paylimit"`, added to `LIVE_PERMIT_BASES`.
  Profile: `sponsorRequired: **false**` — **Denmark has no employer register equivalent to IND's**,
  so a sponsor lookup would fail every Danish company. `salaryFloorApplies: true`,
  `payReference: "dkk"`, `dutchLanguageApplies: false`.
  `basesForPosting("denmark")` → `["denmark-paylimit"]` only, mirroring `india` → `["india-local"]`.
- `criteria.ts`: a DK window table mirroring the NL one.
  ⚠️ **Read the threshold off nyidanmark.dk / SIRI at implementation time and record it with its
  source and date.** Published 2026 figures disagree — the Pay Limit Scheme is cited as both
  **DKK 552,000** and **DKK 514,000** (supplementary: 446,000 vs 415,000). `permit-routes.ts`
  already states why this is not a tunable: a wrong floor manufactures applications that cannot
  lawfully succeed and fail weeks later as silence. Do not take it from a blog.
- `pay-denmark.ts`: DKK parsing, mirroring `pay-india.ts`.
- `screen-gates.ts`: `locationGate` returns `null` for `"DK"`. Without this every Danish row is a
  permanent `flag` and `combineVerdict` can never return `pass` — the alert would never fire.

### 3.2 Fix the Jobindex scraper — every fix is measured
- **Use `share_url` (`/vis-job/<tid>`), not `/jobannonce/<tid>`** — probe: 6/6 stayed on jobindex
  with 5.3–6.0 KB of body; `/jobannonce/` redirected off-site 5/10.
- **Never drop a posting.** `r.html` carries a ~600-char teaser on **10/10** results — use it as the
  floor when detail extraction is thin, and push every drop into `failures`.
- **`postedAt` from `r.firstdate`**, not `new Date()`.
- **Set `country: "DK"` on every `RawPosting`** — a fetched fact, which by `route.ts`'s own
  precedence rule beats prose inference.
- **Fix the alert predicate:** also alert when `seen > 0 && screened === 0`.
- **Wire the cron.** `cron.schedule(JOBINDEX_SWEEP_CRON, …)` in `startScheduler`, moved off
  `0 2 * * *` (that slot is `runBrainSync`) to `0 5 * * *`.

---

## Dropped, with reasons

| Item | Why |
|---|---|
| **`.data/profile.md`** (your Component 2) | Prod already has four per-track CVs plus a master at `/opt/founderos-data/cv` with `PERSONAL_CV_DIR` set. This file is **869 chars** against a `MIN_PLAUSIBLE_CV_CHARS` guard of **800** — one edit from failing — and repointing `readFullCvText` at it would replace four real CVs with one thin stub, making every tailored CV worse. **Revert it from `aaf2280` and add `.data/` to `.gitignore`** — it is your CV, currently committed to the repo. |
| **`scripts/add-portal.ts`** (Component 5) | Writes unreviewed LLM-generated TypeScript straight into `src/tools/jobhunt/`, shebangs `bun` (not the repo runtime), and makes a paid model call in the dev loop. Delete. |
| **LLM critique pass** (Component 1) | Deferred, not dropped. `tailor-cv.ts` already has slop-check + revision. A third call before a single draft has shipped optimises draft *quality* while the constraint is draft *volume*. Revisit once you're applying daily and can judge the output. |

---

## Branch strategy

`feature/migration-ai-job-search` is not a usable base: `aaf2280` commits four files (two being
reverted) and orphans `jobindex-source.ts`, while the other eight sit in `stash@{0}` on a different
lineage. Local `beta` is four commits behind origin.

```bash
git branch archive/antigravity-jobindex-2026-08-20 e2e0adc
git fetch origin && git checkout -b feat/jobhunt-apply-loop origin/beta
```

Salvage by hand — only `extractBoardToken`, `registerDiscoveredBoard` and the Jobindex search
parser survive review, and all three are being rewritten.

---

## Verification

Nothing is done without the command run fresh and its output shown (rule #24).

**Phase 1 — the loop closes.**
1. `pnpm gate` green; `fail-open-catch` must read `11 (= baseline)`.
2. Live: `/brief` → `/draft 1` → **a PDF arrives in Telegram**. Open it; confirm ATS-plain and
   tailored to that JD.
3. `/applied 1` → `/brief` → **row 1 is gone**. Confirm:
   ```sql
   SELECT stage, count(*) FROM agents.job_applications GROUP BY 1;
   ```
4. Queue freshness — every row must be under 24h:
   ```sql
   SELECT max(round(extract(epoch from (now()-posted_at))/3600)) AS oldest_hours
   FROM agents.job_applications WHERE stage='screened'
     AND posted_at > now() - interval '24 hours';
   ```
5. Failure path: unset `STORAGE_BUCKET`, confirm `/draft` still returns a text draft with an
   explicit note rather than silence.
6. After 24h of `*/30` sweeps, the brief is non-empty and the aged-out counter is non-zero.

**Phase 2 — the registry compounds.**
7. Extractor unit test over the real prod corpus — must match **209/209**:
   ```sql
   SELECT url FROM agents.job_applications WHERE url ~ 'greenhouse\.io|lever\.co|ashbyhq\.com';
   ```
8. Run `scripts/probe-sponsor-boards.ts`; report boards found per platform. Expect **~322**. If it
   comes in under 100, stop and re-measure the slug strategy before merging.
9. `getFreeBoards()` returns curated + discovered; `docs/strategy/data/free-ats-boards.csv` is
   **byte-identical** after a sweep (`git status` clean).
10. Fault injection: make the discovery file unwritable, run a free sweep, confirm every posting
    still gets its real verdict and **zero** rows come back `outcome: "error"`.
11. One metered sweep logs `new_boards_discovered` and the alert carries the new-companies line.

**Phase 3.** One real Jobindex run with `seen`, `screened`, `failures` mutually consistent, and at
least one Danish row reaching `pass` under `denmark-paylimit`. If `screened === 0`, the alert fires.

**All phases:** copy this plan to `docs/plans/2026-08-20-jobhunt-apply-queue-and-registry.md` and
run `pnpm brain:sync` before the final PR.

---

## Immediate, outside this plan

**The metered sweep has not run since 2026-08-12 (198h, three missed windows).** Diagnose before
Phase 2 — the token harvester has no input while it is down.

```bash
ssh founderos-vps 'journalctl -u founderos --since "2026-08-13" | grep -i "job ingest\|sweep\|spend-gate"'
```

Likely candidates: the `spend-gate` refusing on a budget cap, or the scheduler not registering the
cron after a restart.

---

## Sources

- [Denmark Work Permit Changes 2026 — Sirva](https://www.sirva.com/learning-center/blog/2026/06/02/denmark-work-permit-changes-2026)
- [Foreign labour: new salary thresholds and positive lists — Bird & Bird](https://www.twobirds.com/en/insights/2026/denmark/udenlandsk-arbejdskraft---nye-bel%C3%B8bsgr%C3%A6nser-under-bel%C3%B8bsordningerne-og-opdateret-positivlister)
- [Denmark immigration rules change in 2026 — Business Standard](https://www.business-standard.com/immigration/denmark-immigration-rules-change-in-2026-higher-fees-tighter-work-permits-125121900771_1.html)

Both figures must be re-confirmed against nyidanmark.dk before the DK floor is written to code.

---

## Verification notes (2026-08-20, pre-execution)

Checked before starting Phase 1. Two corrections to the narrative above:

- **Branch strategy target is valid.** `e2e0adc` resolves locally (PR #502 merge), `stash@{0}` exists
  ("On beta: epitaxy: pre-switch from beta"). Local `beta` is **10 commits behind** `origin/beta`,
  not 4 — doesn't change the recommended commands, `origin/beta` was always the real base.
- **The metered-lane diagnosis is sharper than "silent since Aug 12."** Prod journalctl
  (`--since 2026-08-13`) shows the daily 1:30am UTC `job ingest` cron actually fired on **Aug 18**
  and was explicitly refused by the spend-gate: `$1.07 already spent this cycle of $2.00, this
  sweep projects $1.56, only $0.93 left`. On **Aug 19 and Aug 20 it did not fire at all** — no
  success line, no refusal line, nothing, unlike Aug 18. The free lane (every 30 min, boards=285)
  ran cleanly through the same window with no gaps, so the process itself is not down. Next
  diagnostic step, not yet run: pull `agents.job_ingest_runs` directly and/or check
  `JOBHUNT_MONTHLY_CAP_USD` cycle state, rather than re-deriving from grep.

---

## Implementation outcome, 2026-08-20 (`feat/jobhunt-apply-loop`)

Phase 1 and Phase 2 shipped in this session, `pnpm gate` green throughout (300 files / 3258
tests). Phase 3 (Denmark, Jobindex) stayed deferred as planned. Three deltas from the plan above,
each because the plan's premise didn't survive contact with the live system or the real API:

- **Personio dropped, not shipped.** Its public XML feed (`<token>.jobs.personio.de/xml`) is real
  and live-verified, but carries no per-posting URL field, and every human-facing path under that
  subdomain — `/job/<id>`, the bare board root — redirects to `personio.com`'s marketing page
  rather than the posting or even the board listing (checked against two real customer boards,
  `personio.jobs.personio.de` itself and a genuine third-party customer `urbansportsclub`). A
  posting whose "apply" link dead-ends at a generic page is worse than not having it. Recruitee
  alone (3 of the plan's 5 measured hits) shipped and is fully verified end-to-end, including a
  real working `careers_url`.
- **2.6 (widen `FREE_LANE_MAX_AGE_HOURS` 24→72) turned out to be a non-issue.** The live value was
  already 720h when checked, not 24h as this plan assumed — the fetch window was never the
  constraint. Phase 1.2's new `APPLY_QUEUE_MAX_AGE_HOURS` (24h, on the query, not the fetch) is
  what actually delivers "fetch wide, show fresh." No code changed for 2.6.
- **2.5 shipped lighter than planned.** `job_ingest_runs.new_boards_discovered` (a DB column) and
  the automated 3-consecutive-zero drop rule were scoped out — a schema migration for a nice-to-
  have observability layer, not the mechanism itself. What shipped: `runPooledIngest` returns the
  full `newBoards: DiscoveredBoard[]` (name + ats + token, not just a count), and the metered
  sweep's existing Telegram message carries `+N new companies now polled: <names>` as one more
  line, never a separate notification.

**New files:** `board-token.ts` (pure `extractBoardToken`/`harvestNewBoardTokens`, regexes
measured against 209 real prod URLs, plus Recruitee's `<token>.recruitee.com`), `board-harvest.ts`
(stateful per-sweep orchestration — split out purely to keep `ingest.ts` under the 400-line CI
budget), `scripts/probe-sponsor-boards.ts` (the IND-register probe, strict slugs, run in the
background — see its own header for CLI usage).

**Live-verified, not just unit-tested:** ran `probe-sponsor-boards.ts --limit 100` against the
real IND register (98 companies after dedup, dry-run and non-dry-run) and it found a genuine new
board on the FIRST 100 sponsors checked — `greenhouse/5ca` (5CA B.V.) — confirming the harvest
loop is already productive, not just structurally correct. The three companies this plan's
Recruitee measurement was based on (`dalsem`, `netconomy`, `ravo`) were independently re-confirmed
live end-to-end (slug → URL → real parsed candidates) in the same pass.

**Outstanding, deliberately not done in this session:**
1. The full `probe-sponsor-boards.ts` run over all ~12,900 sponsors — minutes-to-hours against
   real third-party hosts, meant to run in the background/on the VPS, not inline in a chat turn.
   Command: `node --import tsx/esm scripts/probe-sponsor-boards.ts` (add `--limit N` to sample).
2. The metered-lane diagnostic above (why Aug 19/20 fired zero times) — not re-investigated this
   session; the immediate 2026-08-18 finding (spend-gate refusal, cycle resets 2026-09-11) still
   stands as the best current explanation for the *scheduled* refusals, but the *unscheduled*
   silence on 19th/20th was never root-caused.
3. `.data/profile.md` revert and `.gitignore` addition (dropped-items table above) — not touched
   this session.

---

# QA audit, 2026-08-20 (second session)

A full adversarial pass over both flows, driven by live production data and live
board sweeps rather than by reading the code. Six defects found, all fixed.
`pnpm gate` green at 300 files / 3,281 tests, every architecture ratchet at
baseline.

## What the production funnel actually looked like

From `journalctl` on the box, 2026-08-20:

```
seen 20,607 · undated 18 · stale 14,037 · offTrack 5,866 · offMarket 538
           · known 140 · bodyless 3 · SCREENED 5
```

Of the 6,552 postings that survived the freshness window, **89.5% were dropped
by `classifyTrack` returning null** — and dropped as a bare COUNT, with the
titles never stored. "We are missing engineering roles" and "those really were
all concept artists" were the same number from outside. `scripts/audit-track-
coverage.ts` was written to answer it: it polls the real registry, runs the real
classifier over the real titles, and ranks what came back null.

Measured over 4,412 live postings from 90 boards: **629 of the 3,840
unclassified titles contained engineer/developer/architect/scientist.**

## Defects found and fixed

| # | Flow | Defect | Evidence |
|---|---|---|---|
| 1 | apply | **A manually screened job could never appear in its own queue.** `screen_job` records `posted_at` as NULL by design; the new 24h filter is `posted_at >= cutoff`, and Postgres reads `NULL >= x` as unknown, not true. Every job the founder pasted himself vanished the moment he screened it, and was counted as "aged out" while he was still reading it. | code trace + `screen.ts:274` |
| 2 | supply | **Generic "Software Engineer" outranked every specific track.** It sat in the BACKEND phrase list, and backend is checked before frontend, so "Frontend Software Engineer" and "Senior Software Engineer, Frontend" both filed as backend. Production: **228 backend rows against 10 frontend** — on the track that is the deepest three years of the CV, and the track decides which of the four CVs `/draft` tailors. | prod `SELECT track, count(*)` |
| 3 | supply | **Language/seniority/AI title families were invisible.** `python engineer` (only `python developer` existed), `rust developer`, `c#`/`.NET`, `staff engineer` (23 in one sample, all software), `principal engineer`, `forward deployed engineer` (38), `data scientist` (25), the singular `system engineer`, Dutch `ontwikkelaar`. | live corpus |
| 4 | supply | **`\b` cannot see a term whose own edge is punctuation.** `\bc#\b` never matches "C# Developer"; `\b\.net\b` never matches ".NET Developer". Half the language qualifiers were unmatchable in principle. | regex trace |
| 5 | supply | **Real Indian cities were being filed as "a country outside both your markets" and dropped before screening** — Lucknow, Varanasi, Bareilly, Mysore, Nashik, Tirupati, Vadodara, Surat (15 rows in one 90-board sample). Plus Schiphol-Rijk on the Dutch side. | live corpus |
| 6 | supply | **The same fact got opposite treatment on decoration alone.** Bare "Remote" read as `unknown` (kept, screened); "Remote - Europe", "Remote-EMEA", "EU (Remote)" fell through to `other` (dropped). `NON_PLACE` was an exact match on the whole string. One board emits a location of exactly `"IN"`, which also read as `other`. | live corpus |
| 7 | apply | `/applied N` left `brief_rank` pinned, so `/draft N` still resolved the applied row and would tailor a second CV for a company already written to. | code trace |

## Measured result, same 4,412 postings, before vs after

```
classified          572  →  802     (+230, +40%)
reaching screening  232  →  323     (+39%)
regressions                   0
```

Newly reaching screening includes: Python Engineer (Bengaluru), Senior Data
Scientist Gen AI (Bengaluru), Forward Deployed Engineer (Bangalore), Staff
Engineer Backend (Bengaluru), Tech Lead Front-End. Real, applicable roles that
were previously fetched and thrown away.

**Precision was tightened, not just recall.** Five false positives produced by
an earlier draft of the qualifier list were measured and designed out, each now
pinned by a regression test: "Lead Product Designer (UI & Design Systems)" →
backend (via a bare `systems` qualifier), "Principal Architect: Amazon Web
Services" → frontend (via a bare `web` qualifier), "Staff UX Researcher",
"AI Deployment Lead, Hedge Funds", "AI Business Consulting Lead". The 42
"Solutions Architect" postings in that sample are pre-sales roles and stay
`null` — which is why cloud-vendor names are deliberately absent from the
qualifier list.

## Does this pipeline produce benefit? The honest number

Measured, not projected. During the 30-minute-sweep era (Aug 13–17, prod):

- **24 of 31 free-lane rows (77%) were discovered inside 24h of publication**
- **median lag from publication to ingest: 0.4 hours (24 minutes)**

So the 24-hour apply queue is achievable — but ONLY at `*/30`. Prod has been on
a daily cron since Aug 18, where the median lag across all history is 155h and
the 24h queue is provably empty (`fresh_new_rule = 0` of 324 screened rows).

With `*/30` restored plus the classifier and country fixes:
**~8–9 new rows/day, ~7 of them fresh, and at the last 7 days' verdict mix
(68% pass) roughly 5–6 PASS roles a day in the queue, arriving ~25 minutes
after going live.** For a 1–2 hr/day search that head start is the product.
Supply discovery is no longer the binding constraint; whether he applies is.

## Still outstanding

1. `/draft N`'s live Telegram round-trip (ack → PDF → HITL approval tap) is
   unit-tested but never exercised against the real bot.
2. The metered ATS lane has not written a row since 2026-08-14, so the
   fetch-boundary token harvest has had no input for six days.
3. Brief ranks are reassigned on every render, so a sweep landing between the
   founder reading a brief and typing `/draft N` can move what N means.
   `/draft` names the company in its acknowledgement BEFORE doing any work, so
   this surfaces loudly rather than silently — but `/applied N` names it only
   after the write. Not fixed: a durable fix is a per-render snapshot, which is
   a design change rather than a defect fix.
