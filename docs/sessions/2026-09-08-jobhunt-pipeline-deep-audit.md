# 2026-09-08 — deep audit of the whole job pipeline, post board expansion

Audit only. **No source file was changed in this session** — everything below is read from the
production box (`journalctl`, `agents.*` tables) and from the tree at `main` (`da219474`), plus one
reproduction run of the real classifier. Fixes are specified but not applied; see Outstanding.

---

## What we did

1. Measured the free lane end-to-end on prod across the 07:31 (pre-expansion build) and 08:03 /
   08:33 (post-expansion build) sweeps, per profile.
2. Traced Tashi's two ranked roles from posting → screen → rank → Telegram, and found why the
   founder never saw them.
3. Reproduced one screening defect locally against the real `classifyTrack` and the real profile.
4. Checked concurrency, rate limits, sweep wall-time, cache health and board-failure rates at
   3,223 boards.
5. Compared `main` and `beta` at tree level, not commit level.

---

## Answers to the seven questions

### Q1 — Does this work for both Tashi and Pushkar? Are we polling for both?

**Yes, and the design is right: polled once, screened twice.** `runFreeSweep`
(`src/tools/jobhunt/sweep-runner.ts:230`) polls the 3,223-board registry **one time**, then loops
`listProfiles()` and runs `runFreeIngest({ profile, sweep })` per candidate. A second candidate
costs only her own body fetches, not a second pass over the registry.

Prod, sweep starting 08:30 UTC today:

| | boards polled | postings seen | screened | passed |
|---|---|---|---|---|
| `pushkar-nl-tech` | 3,223 | 84,416 | 5 | 2 |
| `wife-nl-finance` | 3,223 | 84,416 | 1 | 0 |

Both lanes have their own funnel, their own tracker dedupe scope (`findApplicationByDedupeKey` is
scoped by `profile.id`), their own heartbeat row, and their own named alert.

**Two asymmetries the founder should know about:**

- **The metered ATS/Indeed sweep is Pushkar-only *and* is not running at all.**
  `runJobIngestSweep` takes no profile (defaults to Pushkar), and its `cron.schedule()` was removed
  on 2026-08-21 by founder directive (`src/infra/scheduler.ts:15-23`). The free board sweep is the
  entire live pipeline. Nothing is lost for Tashi — she was never on the metered lane — but "the
  30-minute free sweep" and "the pipeline" are now the same thing.
- **The Google Sheet belongs to Pushkar only** (`sweep-runner.ts:376-379`), by design. Tashi's
  route to her rows is her Telegram alert and `/jobs tashi`.

### Q2 — Can a 30-minute sweep really handle 3,223 boards with rate limits?

**Yes, with ~8.5× headroom. Measured, not extrapolated.**

Sweep that started at 08:30:00 UTC:

```
08:32:48  board sweep complete   boards 3223, failed 13, candidates 82,699
08:33:13  aggregator sweep       +1,717 (arbeitnow 1300, remotive 17, himalayas 200, jobicy 200)
08:33:21  pushkar-nl-tech done
08:33:32  wife-nl-finance done
```

**Total 3 min 32 s — 11.8% of the 30-minute window.** The previous session extrapolated ~220 s; the
real figure is 212 s.

Rate limiting is holding, and improved:

| | boards | failures | of which 429 |
|---|---|---|---|
| 07:31 sweep (1,312 boards, old build) | 1,312 | 27 | 14 Recruitee |
| 08:33 sweep (3,223 boards, new build) | 3,223 | 13 (0.40%) | **0** |

Remaining 13: `greenhouse HTTP 404 ×8`, `bamboohr non-JSON ×2`, `lever 404 ×1`, `teamtailor 404 ×1`,
`bamboohr HTTP 401 ×1` — dead/rotated tokens and one auth-walled board, not throttling.

Why it holds: boards are grouped by platform and each group runs at its own concurrency
(`PLATFORM_CONCURRENCY`) **and** its own minimum dispatch interval (`PLATFORM_STAGGER_MS`, a global
leaky bucket in `mapWithConcurrencyLimit`). The stagger floors are all small at current volume:

| platform | boards | conc | stagger | dispatch floor |
|---|---|---|---|---|
| greenhouse | 562 | 8 | 100 ms | 56 s |
| workable | 463 | 8 | 100 ms | 46 s |
| bamboohr | 428 | 4 | 200 ms | 86 s |
| workday | 396 | 4 | 200 ms | 79 s |
| smartrecruiters | 367 | 8 | 100 ms | 37 s |
| ashby | 344 | 8 | 100 ms | 34 s |
| lever | 208 | 8 | 100 ms | 21 s |
| personio | 158 | 3 | 200 ms | 32 s |
| recruitee | 156 | 2 | 300 ms | 47 s |
| teamtailor | 141 | 8 | 100 ms | 14 s |

Groups run in parallel, so the floor is the max (86 s), not the sum. Retries are bounded at 3
attempts with full-jitter exponential backoff, and a board's real `Retry-After` is honoured up to
60 s (`free-ats-source.ts:224-238`).

The ETag cache is healthy, contrary to the previous session's open worry:
`agents.ats_board_cache` = 1,770 rows / 124 MB, **2 dead tuples**, autovacuum + autoanalyze running
on every sweep (last: 08:30:50). Row count is stable, not growing. The "no TTL/pruning" item can be
downgraded from risk to note.

**One real gap: `runFreeSweep` has no overlap guard.** At 212 s of 1,800 s that does not matter
today; it becomes a correctness problem only if the sweep ever exceeds 30 minutes. Worth a lock if
the registry grows another 8×.

### Q3 — How does the pipeline actually work now?

```
cron */30  ──► runFreeSweep()                                    [sweep-runner.ts]
               │
               ├─ sweepBoards(getFreeBoards())                   [free-ats-source.ts]
               │    3,223 boards, grouped by platform,
               │    per-platform concurrency + stagger,
               │    conditional GET via Postgres ETag cache,
               │    3 attempts w/ jitter + Retry-After,
               │    failures COUNTED never thrown           ──► ~82,700 candidates
               │
               ├─ sweepAggregators()                             [aggregator-source.ts]
               │    arbeitnow · remotive · himalayas · jobicy,
               │    sequential, fail-open                   ──► +1,717 candidates
               │
               └─ for each profile in listProfiles():            ── Pushkar, then Tashi
                    runFreeIngest({ profile, sweep })            [free-ingest.ts]
                      1. filterCandidates()   undated → stale(720h) → offTrack → offMarket
                      2. keepUnseen()         tracker dedupe, SCOPED to this profile
                      3. hydrateDescriptions() body fetch only for survivors
                      4. applyDeferredFreshness()  (BambooHR: date only exists in detail)
                      5. drop bodyless
                      6. screenBatch()        pure gates: Location · Sponsor · Salary ·
                                              Language · Experience → pass / flag / reject
                      7. recordQueryCost()    funnel written to agents.job_ingest_runs
                    ↓
                    newPasses = lines where outcome === "pass" AND isNew
                    ├─ none  → afterQuietSweep() → 3-hourly "job lane alive" ping only
                    └─ some  → buildDailyBrief({profile})   ranks into do_today / stretch / ask
                                 (fresh-only: rows < 24h; standing pool deliberately disabled)
                               → persistBriefRanks()  writes brief_section + brief_rank
                               → sendToChat(formatNewRowsAlert(..., candidateName))
```

Everything is **zero-LLM and $0** up to and including screening. The LLM only appears later, on
`/draft N` (tailor a CV) and `/apply`.

Real funnel for the 08:33 sweep, both profiles, from one shared poll of 84,416 postings:

| stage | Pushkar | Tashi |
|---|---|---|
| seen | 84,416 | 84,416 |
| − undated | 2,697 | 2,697 |
| − stale (>720 h) | 42,101 | 42,086 |
| − off-track | 35,679 | 38,844 |
| − off-market | 3,170 | 749 |
| − already known | 763 | 39 |
| − bodyless | 1 | 0 |
| **screened** | **5** | **1** |
| passed | 2 | 0 |

Two windows, deliberately different, and worth stating plainly because they are easy to confuse:
**ingest keeps 720 h (30 days)** (`FREE_LANE_MAX_AGE_HOURS`, unset in prod so running the default),
while **the brief only ever ranks rows younger than 24 h** (`listActionableApplications`). The
founder's 2026-09-07 "fresh-only" decision binds at the brief, not at ingest.

### Q4 — Why didn't Thales / Michael Kors reach Telegram?

**Because neither of them passed. The free lane's only interrupt is `outcome === "pass"`.**

Prod, `agents.job_ingest_runs`, the sweep that found them:

```
2026-09-07 16:01:38   wife-nl-finance   seen 46,918   screened 2   passed 0   flagged 2
```

`runFreeSweepForProfile` computes `newPasses = lines.filter(l => l.outcome === "pass" && l.isNew)`.
Two flags meant `newPasses.length === 0`, so the code took the **quiet** branch and sent nothing.
The rows were then ranked out-of-band last session (`buildDailyBrief` run directly against prod),
which writes `brief_section`/`brief_rank` and by design has **no Telegram side effect**. By the next
sweep both rows were `known`, so `isNew` was false and the alert could never fire retroactively.

Net: **the alert path is not broken, it is too narrow.** For Tashi it is close to always-silent,
because her employers are mostly not on the IND register and Dutch postings state no salary — so
her rows land in `ask` almost by construction. She has 99 tracker rows; 23 of them carry at least
one flag gate.

**Her lane is not dead any more, though — and this is new today.** After the board expansion
deployed at 07:59 UTC, the 08:00 sweep produced her **first automated passes ever**:

```
08:03:54  SFI Markets — Business Controller     route zoekjaar   verdict pass
08:03:54  ING — Financial Risk Officer          route zoekjaar   verdict pass
08:03:55  wife-nl-finance sweep complete: screened 7, passed 2
```

and `agents.job_lane_heartbeats` records `last_message_at = 2026-09-08 08:03:55` for
`wife-nl-finance` with `zero_pass_streak` reset to 0 — which is set **only** by
`afterSpokenSweep()`, i.e. only on the send path. **A "🆕 2 new roles passed screening for Tashi
Goyal" message went out at 08:03:55 UTC (13:33 IST).** ING is now ranked `do_today` #1 in her brief.

NOT VERIFIED: that the message rendered correctly in the founder's actual chat. The MTProto tester
(`TELEGRAM_TESTER_API_ID`/`_API_HASH`/`_SESSION`) is still unset, so this is prod DB + prod log
state, not a watched send. It is stronger than a unit test and weaker than seeing the message.

### Q5 — How does AG-013 (SuccessFactors) help Tashi?

Her funnel dies at `off-track`: 38,844 of the 39,633 postings that survive freshness are not finance
titles. That is not a vocabulary problem — the 2026-09-07 track-coverage audit classified 4,511 real
postings against her profile and found exactly **one** genuine NL miss inside her 0–4-year band. It
is a **supply** problem: the corpus we poll barely contains Dutch finance employers.

**85 of the 126 curated NL finance employers on her list run SuccessFactors**, which this repo
cannot poll — there is no adapter, so those boards are not in the registry and their postings never
enter the 84,416. Adding the adapter does not filter better; it adds an employer population that
currently contributes zero. That is why it is the biggest remaining lever, and why widening her
keyword list further would not move the number.

Cost/risk, from the scoping session: SuccessFactors speaks **DWR** (SAP Direct Web Remoting, a
legacy session-bound RPC), not REST like the other 10 adapters. AG-013 explicitly requires answering
"is the DWR call stateless?" and "is there a cheaper SEO sitemap path?" *before* writing the
adapter. Estimate 4–8 h with real per-company variance.

Caveat on the brief's own framing: AG-013 says her lane has produced "zero passes in 17 consecutive
checks." **That was true when written and is no longer true** — the expansion produced 2 passes this
morning. The constraint is eased, not removed.

### Q6 — Are `beta` and `main` synced?

**Yes at the level that matters, no at the level `git log` shows.**

```
git diff --stat origin/main origin/beta   →  (empty)
git rev-list --left-right --count origin/main...origin/beta   →  7  13
```

The trees are byte-identical. The 7/13 commit divergence is squash-merge history artefact from
`#646` (promotion) and `#649`/`#647` (sync-back) — the same content, different SHAs. Nothing is
missing from either branch.

This is not harmless bookkeeping, though: it is the exact state that produced last session's
five-file conflict, twice. Every future `sync-beta` PR will keep replaying it until one side is
reset to the other (`git branch -f beta origin/main` + force-push, or a merge commit instead of a
squash on the promotion).

### Q7 — How is board expansion done, and is supply airtight?

**Mechanism — a JOIN, never a guess.** `scripts/jobhunt-import-sponsor-boards.ts` +
`src/tools/jobhunt/board-import.ts` intersect two things we already have:

1. an employer list — the IND recognised-sponsor register (12.9k rows), or a curated market list
   (`nl-finance-employers.csv`, `in-tech-employers.csv`, `de-tech-employers.csv`, UK register);
2. published open-source ATS company→token corpora (`kalil0321/ats-scrapers`, one CSV per platform).

Matches are verified live before being written. The predecessor approach — deriving a slug and
probing four ATS domains — returned a 0.36% hit rate and never reached prod; the join finds 4.4×
more and costs nothing.

Two invariants that are load-bearing and currently held:

- **`name` carries the ATS corpus's company name, never the registered one.** `matchSponsor`
  screens against exactly this column, so writing "Deliveroo Netherlands B.V." here would
  manufacture a confident `sponsor` verdict out of our own CSV. With "Deliveroo" the row screens to
  `uncertain` and names the register entry, and a human decides.
- **`markets` is provenance, not a claim about postings.** A UK-sourced board is a UK-*registered*
  company; where it hires is decided per posting by `countryFromLocation`.

**Current registry: 3,223 rows, 10 platforms, 0 duplicate `(ats, token)` pairs, 0 blank tokens.**
By market: UK 1,799 · NL 1,133 · IN 185 · DE 73 · IN|NL 33.

The UK slice is not dead weight — last session sampled it live: 40 UK-sourced boards returned 723
postings, 15.1% of them resolving to NL/IN/unknown, ~0.13 screenable per board against 0.40 for the
NL control. Three times less efficient, but across 1,799 boards it is roughly 225 screenable
postings a sweep.

**It is not airtight. Three holes, all in the "silently smaller than it looks" direction:**

- `MIN_EXPECTED_BOARDS = 1100` was not raised when the registry went 1,297 → 3,223. That constant's
  own doc-comment states the rule it is now breaking: *"A floor that is not moved with the file
  stops being a floor."* Today it sits at 34% of the real file — two thirds of the registry could
  fail to parse and the guard would still pass.
- `parseBoardRegistry` skips a row with an unknown platform or an empty token via a bare
  `continue`, with **no counter and no log**. The rest of this pipeline counts every drop on
  principle; this one does not. (Verified clean right now: 3,223 CSV rows → prod logs
  `boards: 3223`, so zero rows are being lost today.)
- Board-token harvesting has produced **nothing**. `/opt/founderos-data/free-ats-discovered.csv`
  does not exist on the box and every aggregator sweep logs `tokens: 0`. The "one aggregator sweep
  discovers boards every future sweep polls forever" comment in `aggregator-source.ts` describes a
  mechanism that has never fired.

---

## Defects found

Ranked by what they cost the founder. None is fixed in this session.

### D1 — HIGH · a French retail job is ranked #2 in Tashi's brief · **reproduced**

`compliance-kyc.classifyTerms` contains the bare acronym `"cdd"`. In French postings **CDD =
contrat à durée déterminée**, the standard fixed-term contract, and it appears in the *title* of
every such vacancy. Reproduced against the real classifier and the real profile:

```
"Vendeur(se) avec expérience CDD 28h"          -> compliance-kyc
"Shop Manager Printemps Toulon - CDD 35h"      -> compliance-kyc
"Printemps Haussmann, CDD 8h/semaine (samedis)"-> compliance-kyc
"Conseiller de vente CDD 35h"                  -> compliance-kyc
```

Prod impact today: 3 Michael Kors rows (Paris, Toulon), and
`Vendeur(se) avec expérience CDD 28h` is **`brief_section = 'ask'`, `brief_rank = 2`** — one of the
only three ranked rows Tashi has. It compounds with two other weaknesses: the Workday list payload
gave no `locationsText`, so `country` resolved to `unknown` (kept by design, since remote roles
state no country), and `matchSponsor` reports `"Michael Kors" partially overlaps Michael Kors
(Europe) B.V.` — so a Paris shop-floor job reads as a plausible Dutch sponsor.

The same profile file already argues this exact case for `finance-ops`: *"Bare 3-letter acronyms
deliberately excluded from classifyTerms — 'OTC' collides with over-the-counter trading/pharma."*
`compliance-kyc` was not given the same treatment.

Fix (one line, `src/tools/jobhunt/profiles/wife-nl-finance.ts:242`): drop `"cdd"` from
`classifyTerms`. `"CDD Analyst:*"` and `"Customer Due Diligence Analyst:*"` stay in `titles`, which
is a substring match against the title and does not fire on a bare acronym. `"kyc"` and `"aml"` are
safe to keep — neither is a common word in a European job title. Then delete the 3 rows and rerun
her brief so `ask` #2 is freed.

### D2 — HIGH · Pushkar's lane can silently take Tashi's lane down · code read

`sweep-runner.ts:274-279`:

```ts
for (const profile of listProfiles()) {
  // ... "swallowing it at the loop keeps the second candidate's lane running
  //      when the first one breaks."
  await runFreeSweepForProfile(profile, sweep);
}
```

**There is no try/catch.** The comment describes behaviour the code does not have.
`runFreeSweepForProfile` guards `runFreeIngest` and `buildDailyBrief`, but **not** `publishSheet()`,
`sendToChat()` or `saveLaneHeartbeat()`, and `sendToChat` rethrows by design (unlike its sibling
`sendStatusText`, which logs and swallows). Pushkar is first in `listProfiles()`, so any throw on
his side — a Telegram 429 flood-control on an alert naming 119 new roles, a network reset, a
Postgres blip on the heartbeat write — propagates past the loop and **Tashi is never screened for
that sweep**. The cron's outer `.catch()` logs one line and the tick is gone.

The alert text itself is adequately escaped (`formatNewRowsAlert` runs company and title through
`esc()`), so this is not the HTML-parse failure mode `runJobIngestSweep` guards against — it is
every other reason a send or a DB write can fail. Not observed firing yet (zero Telegram errors in
prod logs since 2026-09-07). It is a latent single-point-of-failure whose blast radius is exactly
the second candidate.

Fix: wrap the loop body in `try/catch` and log, matching what the comment already claims.

### D3 — HIGH · flagged rows never interrupt, so most of Tashi's queue is silent

`newPasses` requires `outcome === "pass"`. A `flag` — which for Tashi means "no salary stated" or
"employer not on the IND register", i.e. the normal shape of a Dutch posting — produces **no
message of any kind**, forever. Worse, the quiet branch then sends a 3-hourly ping reading
*"nothing new that cleared screening"*, which is true and misleading at the same time: two ranked,
actionable `ask` rows were sitting in her brief when it said that.

This is the pipeline's own rule #26 failure mode — a deliverable that costs nothing to ignore and
emits no signal. Fix options, cheapest first:

1. Alert on `pass` **or** newly-ranked `ask`/`stretch`, with the section named in the message.
2. Or: send a once-daily "N roles are waiting a question" digest per profile when `ask` is
   non-empty, distinct from the alive-ping.

Founder call — it changes notification volume, which is why it is not applied here.

### D4 — MEDIUM · `MIN_EXPECTED_BOARDS` stale at 1100 vs a 3,223-row registry

See Q7. One-line fix in `free-boards.ts:251`, plus the comment line recording why. A sensible value
is ~2,700 (roughly 85%), consistent with how the floor was set at every previous raise.

### D5 — MEDIUM · silent row drops in `parseBoardRegistry`

See Q7. Return a `skipped` count alongside the boards and log it in `getFreeBoards`, so a corpus
import that writes a platform typo is visible before the 1100 floor is the only thing standing.

### D6 — LOW (latent) · aggregator jobs can trigger bogus Greenhouse fetches

`aggregator-source.ts:39-45` gives every aggregator candidate a synthetic board with
`ats: "greenhouse"`, justified by "they never need body hydration — they already carry their
description". But `toFreeCandidate` sets `description: null` when the aggregator returns an empty
body, and `hydrateDescriptions` then builds
`boards-api.greenhouse.io/v1/boards/aggregator-<source>/jobs/<id>` and fetches it. Result: a 404 at
a third party, a warn line, and a `greenhouse detail-empty` bodyless drop that names the wrong
platform. Not currently firing (today's bodyless breakdown is `personio inlined-empty ×1,
workday detail-empty ×1`), but the invariant the comment asserts is not enforced anywhere.

Fix: skip hydration for synthetic boards, or drop empty-description aggregator jobs at
`toFreeCandidate` with their own counted reason.

### D7 — LOW · board-token harvesting has never written a board

See Q7. Either it is unreachable or the aggregator URLs are not matching `extractBoardToken`'s
patterns; both look identical from outside because the file simply does not exist.

### D8 — informational · pre-fix India residue in Tashi's tracker

16 rows with `country = 'IN'` (Gurugram, Bengaluru, Pune…) sit in her tracker with
`source = 'free-ats-ingest'`. They date from 2026-09-04 → 2026-09-07 15:01 and were admitted by the
unscoped NL/IN fallback in `countryFromLocation`, **which was fixed on 2026-09-07**
(`country.ts:312-315` now gates the fallback on `profile.targetCountries`). No IN row has entered
her lane since. They are unranked and invisible to the fresh-only brief; they only inflate her
`known` count. Safe to delete, not urgent.

---

## Metrics

- Sweep wall-time, 3,223 boards + 4 aggregators + 2 profiles: **212 s (3 m 32 s)** — 11.8% of the
  30-minute window.
- Board failures: **13 / 3,223 (0.40%)**, **zero HTTP 429**. Pre-expansion build at 1,312 boards:
  27 failures, 14 of them Recruitee 429s.
- Corpus per sweep: **84,416 postings** (82,699 ATS + 1,717 aggregator), up from 47,674 pre-deploy
  (**+77%**).
- `agents.ats_board_cache`: 1,770 rows, 124 MB, 2 dead tuples, autovacuum current.
- Tracker: `pushkar-nl-tech` 1,596 rows / 83 ranked · `wife-nl-finance` 99 rows / 3 ranked.
- Passes per day, free lane (all profiles): 09-05 → 1, 09-06 → 5, 09-07 → 53,
  **09-08 → 136 by 08:33** (36 sweeps).
- Tashi's first-ever automated passes: 2, at 2026-09-08 08:03:54 UTC.
- `main` vs `beta`: `git diff --stat` empty; 7/13 commits divergent by squash artefact.

---

## Outstanding

1. **D1 — `"cdd"` classify term.** One line + 3 row deletes + rerun her brief. ~10 minutes.
   Highest value per minute of anything in this document.
2. **D2 — try/catch the profile loop.** One block. ~5 minutes. Removes a single point of failure
   between Pushkar's Telegram and Tashi's entire sweep.
3. **D3 — decide how flagged rows reach the founder.** Needs a product call on notification volume
   before it can be built.
4. **D4 / D5 — registry floor + silent drop counter.** ~15 minutes together.
5. **AG-013 (SuccessFactors) still not built.** Unchanged from last session, still the biggest
   supply lever for Tashi — but no longer the *only* thing standing between her and a Telegram
   message, since the expansion produced her first automated passes today.

Carried, unchanged: **no live Telegram end-to-end run** (MTProto tester unconfigured), and **the
stale `__drizzle_migrations` id=40 row's root cause is still unexplained** — worth checking whether
any local `.env` points at prod and had `db:migrate` run against it.
