# 2026-09-08 — why Tashi's lane produces so few roles in 24 hours, measured

Founder's question: *"audit hard why are we not getting enough job roles for tashi in 24 hours
(Measure)?"*

Everything below is a number read off production or off the registry files, not an estimate. Where
a number is approximate the method and its direction of error are stated.

---

## The answer in one line

**Her market produces ~9 fresh Netherlands-finance postings a day inside what we poll, and 75% of
the employers who actually hire her profile in the Netherlands are not in the registry at all.** The
filters are working; the corpus is a software-employer corpus.

---

## What 24 hours actually looks like

Measured on prod, 2026-09-08, over the trailing 24 hours (`agents.job_ingest_runs`,
`agents.job_applications`):

| | Pushkar | Tashi | ratio |
|---|---:|---:|---:|
| sweeps run | 46 | 46 | — |
| postings **screened** in 24h | 324 | **22** | 14.7× |
| postings **published** in the last 24h | 149 | **9** | 16.6× |
| rows that **passed** every gate | — | **4** | — |
| distinct companies that have EVER produced a row | 448 | **63** | 7.1× |
| lifetime rows | 1,667 | 102 | 16.3× |

Two sweeps of the expected 48 were lost to deploy restarts. Not a defect — worth knowing.

**63 of 3,223 boards (2.0%) have ever produced a single finance-track row for her.** For Pushkar the
figure is 448 (13.9%).

### Where the 82,672 postings go, for her

One representative sweep (13:33 UTC), her funnel, in pipeline order:

```
seen            82,672
 − undated       2,666   →  80,006
 − stale        41,847   →  38,159      (>30 days old)
 − off-track    37,407   →     752      ← 98.0% of survivors die here
 − off-market      714   →      38      ← 95% of the finance supply is not NL
 − known            38   →       0
 = screened          0
```

Read the last two lines together, because they are the whole finding:

- **752 finance-titled postings exist per sweep**, across the entire 3,223-board registry — 2.0% of
  everything we fetch.
- **38 of those 752 are in the Netherlands.** Ninety-five percent of the finance supply we can see
  is somewhere she is not looking.
- All 38 were already in her tracker, so the sweep adds nothing. That is the correct behaviour of a
  first-seen detector on a stable pool — **the funnel closes at `known`, not at a broken gate.**

The steady-state new-arrival rate is what matters, and it is the 9/day figure above.

### Is `off_track` over-rejecting? No — that was already measured

The 2026-09-07 track-coverage audit classified 4,511 real postings against her profile. Of the 174
Dutch postings the classifier dropped, **exactly one** was both finance-shaped and inside her 0–4
year range ("Finance Operations Specialist", Utrecht) — and it was added the same day. Her
vocabulary is not the constraint, and adding terms to it would be
[no-unrequested-filters](../rules/SHARED-DIRECTIVES.md) in reverse: widening a filter that is not
what is narrow.

---

## The real constraint: the registry does not contain her employers

`docs/strategy/data/nl-finance-employers.csv` is the curated list of Dutch employers who hire FP&A /
audit / KYC / accounting at 0–4 years. Matched against the live 3,223-board registry:

| | count | share |
|---|---:|---:|
| curated NL finance employers | 126 | |
| **already in the registry** | 32 | 25% |
| **NOT in the registry** | **94** | **75%** |

Method: exact normalised-name equality (legal suffixes stripped). It **under-counts** matches — it
will miss a "Grant Thornton Netherlands" row against a "Grant Thornton" employer — so the true gap
is somewhere between 63% and 75%. It never invents a match, which is the error direction that
matters when the output reorders a roadmap.

> A looser substring matcher was tried first and produced **false positives that would have sent the
> work in the wrong direction**: "Crowe" matched *Crowell & Moring* (a US law firm), "Hays" matched
> *Haystack News*, "CZ" matched *SecZetta*, and "Grant Thornton" matched *Grant Thornton New
> Zealand*. Every number in this section is from the strict matcher, spot-checked against the raw
> corpus rows.

### Where the 94 missing employers actually are

Checked against all eleven published ATS corpora — the ten we already poll, plus SuccessFactors:

| where they are | count | what it costs to reach them |
|---|---:|---|
| **on a platform we already poll** | **10** | a CSV row each. **$0, no new code.** |
| need a SuccessFactors adapter | 7 | AG-013: 4–8h, new protocol (DWR), real per-tenant risk |
| **on none of the eleven corpora** | **77 (82%)** | own career site, or a Dutch-market ATS with no public corpus |

The ten already reachable: **Grant Thornton, Crowe, NN Group, Shell, RELX** (Workday) · **KLM,
Fenergo** (Workable) · **MN** (Teamtailor) · **All Options** (BambooHR) · **ComplyAdvantage**
(Greenhouse).

The 77 unreachable ones are the Dutch finance establishment: PwC, EY, Moore, Flynth, Alvarez &
Marsal, Accon avm, Visser & Visser, ABN AMRO, NIBC, de Volksbank, SNS, Triodos, Van Lanschot Kempen,
Knab. Dutch accountancy and retail banking run their own career sites, or ATS platforms
(Connexys, Otys, Carerix, Tangram) that publish no company→token corpus at all.

### This materially corrects AG-013

[`AG-013`](../antigravity/AG-013-successfactors-adapter.md) states: *"85 of 126 NL finance employers
are on an ATS platform this repo cannot poll — SuccessFactors."*

Measured against the same 1,393-row corpus the brief cites, the figure is **7** (Vistra, Heineken,
AkzoNobel, DSM-Firmenich, SBM Offshore — two of the nine raw hits are duplicate spellings). The
loose matcher put it at 13. Either way it is not 85.

**The adapter is therefore not the biggest remaining lever, and the brief should not be dispatched
as written.** It buys ~7 employers for 4–8 hours of new-protocol work, while ten employers are
reachable today for the cost of ten CSV rows.

---

## Ranked fixes — what to do about the supply

| # | Fix | Effort | What it buys |
|---|---|---|---|
| **S-1** | Import the 10 already-reachable employers into the board registry | **~1h, $0** | Grant Thornton, Crowe, NN Group, Shell, RELX, KLM, Fenergo, MN, All Options, ComplyAdvantage — the biggest Dutch audit and insurance names in the gap |
| **S-2** | Re-run the employer↔corpus join with the strict matcher and a **variant pass** ("X Netherlands", "X Nederland", "X B.V.") | ~2h | The gap is 63–75%; this closes the uncertainty and probably finds more S-1 rows |
| **S-3** | Widen `nl-finance-employers.csv` itself — 126 employers is a hand-list, not the market | ~2h | Unknown, but the denominator is currently a guess |
| **S-4** | Decide AG-013 on the corrected number (7 employers, not 85) | founder call | Deprioritise, or accept 4–8h for Heineken/AkzoNobel/Ahold-class employers |
| **S-5** | For the 77 with no corpus: harvest tokens from real posting URLs seen in the wild rather than guessing slugs | ~4h | The only mechanism that reaches PwC/EY/ABN AMRO class employers. Now viable — the harvest path was dead until today (QA-7) |

**S-1 and S-2 first.** They are hours of work with no new code and no protocol risk, and they act on
the largest measured slice of the gap.

---

## Leftover fixes from the QA pass — the full list

Everything found across the audit and QA passes that is **not yet fixed**. Shipped items are in
[#650](https://github.com/pushkarverma3698/FounderOS/pull/650) and
[#652](https://github.com/pushkarverma3698/FounderOS/pull/652).

### Legal / correctness — do these first

| # | Finding | Why it matters | Blocked on |
|---|---|---|---|
| **L-1** | The IND **reduced salary criterion has no expiry**. `screen.ts` selects €3,122 over €4,357 from `permitBases.includes("zoekjaar")` — a permanent profile fact standing in for a rule that lapses three years after the orientation year or qualifying degree. | Fails **silent-permissive**: it will keep clearing roles at a floor 28% below the lawful one and say nothing. `permit-routes.ts` names this as the failure mode it exists to prevent. | **A date.** When did her three-year window open? |
| **L-2** | Her tracker holds **two different legal floors for the same route** — 9 `hsm` rows judged at €52,284/yr, 6 at €37,464/yr, depending only on when they were screened. Nothing rescreens. | `/jobs` renders both as if comparable. | Nothing — needs a rescreen pass once L-1 lands |

### Delivery — the founder does not see what the pipeline found

| # | Finding | Why it matters |
|---|---|---|
| **D-1** | **Flagged rows never interrupt.** The free lane's only alert fires on `outcome === "pass"`. For Tashi almost everything lands in `ask` — her employers are non-sponsors and Dutch postings state no salary — so her lane can rank roles and stay completely silent. Thales and Michael Kors were ranked on 2026-09-07 and never announced; the 3-hourly ping said "nothing new that cleared screening" while two ranked roles sat in her brief. | This is the whole outcome rule: a log of what happened is not an outcome. **Needs a founder decision on notification volume** — alert on newly-ranked `ask` rows, or a once-daily "N roles waiting a question" digest per profile? |
| **D-2** | Ranking a row out-of-band (a manual `buildDailyBrief`) writes the DB and sends nothing, and by the next sweep the row is `known` so it can never be announced. | Any hand-ranked row is permanently invisible to Telegram. Recovery is `/jobs <name>` only. |
| **D-3** | No live Telegram end-to-end run has ever been done. `TELEGRAM_TESTER_API_ID` / `_API_HASH` / `_SESSION` are still unset. | Every delivery claim in these audits is read from prod state and prod logs — stronger than a unit test, weaker than watching the message land. |

### Data quality

| # | Finding | Why it matters |
|---|---|---|
| **Q-1** | **16 India-located rows** entered her tracker before the 2026-09-07 market-scoping fix and are still there, plus 3 Michael Kors French retail rows from the `"cdd"` defect. | They pollute her `known` count and her `/csv`. One `DELETE`, but it touches prod data — founder call. |
| **Q-2** | `cv_signals` and `countPassingApplications` are partitioned by `track` only, with **no `profile_id`**. Correct today purely because the two profiles' track ids do not collide. `unclassified` already collides (10 terms in the table). | A future shared track id silently merges two candidates' CV vocabulary — the exact class PR #634 was written to stop. |
| **Q-3** | `todaysSpend` is tenant-wide, so one candidate's brief prints every lane's spend. $0 everywhere today. | Becomes a wrong number the day the metered cron returns. |

### Documentation drift found while auditing

| # | Finding |
|---|---|
| **X-1** | `AG-013`'s central number (85 of 126 on SuccessFactors) does not survive measurement — it is ~7. The brief is marked "ready to dispatch" and should not be. |
| **X-2** | `free-ats-source.ts` still says "238 third-party hosts" and "623 boards" in its header; `free-boards.ts` says "the real file holds 858 boards". All three predate 3,223. |
| **X-3** | `free-ingest.ts` and `sweep-runner.ts` comments still cite "1,297 boards" and "238 boards" in their reasoning. The reasoning holds; the numbers are stale. |

---

## Metrics

- Prod reads: `job_ingest_runs` (46 sweeps / 24h), `job_applications` (1,769 rows across 2 profiles),
  `job_lane_heartbeats`.
- Registry: 3,223 boards, 10 platforms. Corpora fetched and matched: 11 (~27k company rows).
- Employer coverage measured twice, with a loose and a strict matcher; the loose one was discarded
  after spot-checking showed four false positives.
- `pnpm gate` on the permit-correction branch: exit 0.

## Outstanding

1. **L-1 needs a date** — when her three-year zoekjaar window opened. It decides a legal floor.
2. **D-1 needs a decision** — how loud should flagged-but-ranked roles be?
3. **S-4 needs a call** — AG-013 at 7 employers rather than 85: build, defer, or drop?
4. **Q-1 needs approval** — delete 19 stale rows from her tracker on prod.
