# 2026-09-08 — Fresh-first jobhunt: supply audit, command redesign, and the remaining plan

Supersedes the earlier draft of this file. Three parts:

1. **Why Pushkar gets 14× more roles than Tashi** — measured, with the founder's own hypothesis
   tested and corrected.
2. **The command surface** — `/jobs`, `/today`, `/fresh`, each for both candidates, plus natural
   language over the same resolver.
3. **Every task left**, sequenced.

---

## Part 1 — The supply asymmetry, measured

### The control that matters: her screening is not the problem

| lifetime | Pushkar | Tashi |
|---|---:|---:|
| rows ever stored | 1,693 | 118 |
| pass | 1,015 | 69 |
| flag | 444 | 28 |
| reject | 234 | 21 |
| **pass rate** | **60%** | **58%** |

Her gates are as permissive as his. **The entire 14× gap is upstream of screening.** Any fix aimed
at loosening her filters is aimed at the wrong thing.

### Where the gap is actually born

One sweep, 17:03 UTC 2026-09-08. **Both profiles saw the identical 82,751 postings** — the poll is
shared, so this is a clean comparison:

| stage | Pushkar | Tashi |
|---|---:|---:|
| seen | 82,751 | 82,751 |
| − undated | 2,599 | 2,599 |
| − stale (>30d) | 41,689 | 41,674 |
| **survive the title gate** | **3,701** | **681** ← 5.4× |
| − off-market | 2,958 | 592 |
| **survive the market gate** | **743** | **89** ← 8.3× |
| − already known | 741 | 89 |
| screened | 1 | 0 |

**4.5% of everything we fetch is tech-titled. 0.8% is finance-titled.** That single ratio is the
whole story; the market gate then widens 5.4× to 8.3×.

Confirmed by employer count: **452 companies have ever produced a role for Pushkar, 74 for Tashi.**

### Why: the registry is a software-employer corpus, by construction

Registry composition, 3,223 boards:

| platform | boards | who lives there |
|---|---:|---|
| greenhouse | 559 | startups / tech |
| workable | 463 | SMB, mixed |
| bamboohr | 428 | SMB, mixed |
| **workday** | **393** | **enterprise — where the big finance employers actually are** |
| smartrecruiters | 364 | enterprise/mixed |
| ashby | 339 | startups / tech |
| lever | 204 | startups / tech |
| personio, recruitee, teamtailor | 455 | EU SMB |

Greenhouse + Ashby + Lever alone = **1,102 boards (34%) on startup-favoured ATSs.** Workday, where
PwC/EY/ABN AMRO-class employers live, is 12%.

### The founder's hypothesis, tested

> *"we are fetching fresh jobs every 30 mins from too many companies… and the paid lane when it is
> run it adds new companies instead of jobs to us which then free lane use in it's 30 min run."*

**The shape is exactly right — companies are a separate, slower loop that feeds the 30-minute job
loop. Two corrections, and the second is the finding of this audit.**

1. **The paid lane is not the thing that adds companies, and it is not running.** `JOB_SWEEP_CRON`
   was disabled 2026-08-21 (`scheduler.ts:15`) and is exported but never `cron.schedule()`d. It
   fetched *jobs*, not companies, and it costs $0.46/run.

2. **The thing that adds companies is a nightly cron — and it is a tech-startup discovery pipeline
   that is also broken.** `runFundingGrowerSweep`, 02:00 daily, runs
   `scripts/jobhunt-funding-grow.ts`, whose header states its own sources:

   > *"1. Scrape funding news (YourStory, Inc42, Silicon Canals, EU-Startups) … 4. Probe 6 ATS
   > platforms (Greenhouse, Lever, Ashby, Recruitee, SmartRecruiters, Workable)"*

   Four tech-startup funding-news sites, six startup-favoured ATSs. **It cannot, by construction,
   ever discover PwC, EY, Deloitte, ABN AMRO, Rabobank or a Dutch accountancy** — they do not appear
   in funding headlines and they are not on Greenhouse or Lever.

   And it does not work. Prod, three nights running:

   ```
   2026-09-06 02:00  Funding registry grower sweep failed  code:1
   2026-09-07 02:00  Funding registry grower sweep failed  code:1
   2026-09-08 02:00  Funding registry grower sweep failed  code:1
   ```

   Run by hand today with the env loaded it exits 0 — and still discovers nothing:

   ```
   companies found 12 · tokens probed 12 · boards discovered 0 (0.00% hit rate)
   personio  probed 12, unknown 12 — ABORTED
   ```

**So: the one automated mechanism that grows the company registry yields zero companies per night,
fails in prod every night, and even at full health would only ever add more tech startups.** The
1,312 → 3,223 expansion was a manual import, not this cron. The registry is static, and its shape is
frozen tech-heavy.

That is the root cause of the asymmetry, and it is a compounding one: every improvement to company
discovery so far has made the tech lane better and left the finance lane where it was.

### The second-order reason: Dutch

**41 of her 118 rows (35%) hit the Dutch-language gate.** Finance and accounting in the Netherlands
are local-language, client-facing, regulator-facing functions; engineering is English-default. Even
where finance supply exists, a third of it is unreachable for her. This is a real market property,
not a bug — but it means her effective NL supply is ~65% of what the funnel suggests, and it raises
the value of the non-NL EU work (C3).

### Data quality found in passing

15 rows in `free-ats-boards.csv` are malformed by a CSV-quoting bug — company names containing
`, Inc.` split across columns (`Inc."`, `Inc"` appear as platform values). Small, but they are 15
boards that can never resolve.

---

## Part 2 — The command surface

### The founder's specification

- `/jobs` and `/jobs wife` — **the entire information** (this revises the earlier "24h" instruction)
- `/fresh` — fresh roles
- `/today` — the fresh 24-hour jobs
- Separate clean commands per candidate, **and** natural language must work
- *"when i want to see let's say tashi's last 2 days jobs founded it should be able to execute this
  and same for pushkar"*

### One resolver, three verbs, two axes

```
/<verb> [who] [range]

  verb  : jobs   → full brief, every section, all evidence   (no age limit by default)
          today  → posted in the last 24h                    (fixed window; that is its identity)
          fresh  → discovered since you last ran it          (a delta, not a window)

  who   : (omitted) = Pushkar · wife | tashi = Tashi · me | pushkar = Pushkar
  range : (omitted) = the verb's default · "2 days" · "48h" · "this week"
```

The two axes must stay distinct, because conflating them is defect **T-1** from the truth audit:

| axis | means | used by |
|---|---|---|
| **posted** | when the employer published | `/today`, "roles posted this week" |
| **found** | when we first stored it | `/fresh`, *"last 2 days jobs **founded**"* |

`"tashi's last 2 days jobs founded"` → `{ who: wife, range: 48h, axis: found, verb: jobs }`.

### Natural language shares the implementation, not just the intent

NL routes through the planner to the **same `job_brief` tool** with `{ profileId, windowHours, axis,
mode }`. Slash commands parse to the identical argument object. One code path, so the two can never
drift — a slash command and its English equivalent must return the same rows or one of them is
lying.

### UX rules

1. **Rank numbers are stable across all three verbs** — they come from the persisted `brief_rank`
   column. `/draft 3` means the same role whether you last ran `/fresh`, `/today` or `/jobs`.
   Diverging numbering between lists is a new way to waste an application.
2. **Every list names its own scope in its first line** — "posted in the last 24h", "found since
   16:30", "everything on file". A list that does not say what it excluded is the T-2 defect again.
3. **`/fresh` is one message.** Company · title · one-line why · `/draft N`. No evidence blocks.
   It is the 20-second view you act on from a ping.
4. **The alert carries the action** — `/draft N` and the apply link inline, so ping → draft needs no
   `/jobs` in between.

---

## Part 3 — Every task left

### Block A — Make the brief say what it means · ~3h

From the truth audit. Nothing is hallucinated; five things are mislabelled.

| id | Defect | Fix | File |
|---|---|---|---|
| **A1** | `seen today` renders `created_at`; rows posted 13 days ago read as today's. Publish date appears nowhere on a row. | Show both: `posted 2h ago · found 14 min later`. | `brief-row.ts:253`, `brief-assemble.ts:88` |
| **A2** | Brief silently capped at 100 rows. Pushkar has **166** qualifying and **118 passes**, header says "60 to apply to today". 66 fresh roles invisible. | Explicit limit; print `showing 100 of 166` whenever anything is cut. | `job-queries.ts:420`, `daily-brief.ts` |
| **A3** | `N screened` is the queue size, printed twice in different words. | Rename to `N in your queue`; feed the real screening count where one exists. | `daily-brief.ts:274`, `brief.ts:385` |
| **A4** | `💰 WHAT TODAY COST` reports a **3-day** window (verified: 280/459 match 3-day SQL exactly). `failed` means "had a partial board error". `"the rest already in your list"` when `fresh == returned`. Tenant-wide, so her brief prints his lane. | Retitle to 3 days; rename `failed`; drop the dead branch; label tenant-wide until Q-3. | `daily-brief.ts:314`, `brief-sections.ts:250` |
| **A5** | The 🆕 alert fires on first-seen, so backfill is announced as new. | Fire on publish-freshness; backfill gets a quieter `+ 12 older roles added`. | `free-sweep-profile.ts` |

### Block B — The command surface · ~5h

| id | Task |
|---|---|
| **B1** | Argument resolver: `{ who, range, axis }` from slash args **and** from planner NL, one parser, unit-tested on both surfaces. |
| **B2** | `/jobs [who] [range]` — full brief, no default age limit. |
| **B3** | `/today [who]` — posted < 24h. |
| **B4** | `/fresh [who]` — discovered since last run, one message, `/draft N` per row. Needs a per-profile `last_fresh_seen_at` marker. |
| **B5** | `/draft N` resolves against persisted `brief_rank` so numbering is stable across verbs. |
| **B6** | Alert carries `/draft N` + apply link inline. |
| **B7** | Command help: `/help jobs` and an updated command list, since the surface is now three verbs × two people. |

### Block C — Supply · ~10h

| id | Task | Why it is ranked here |
|---|---|---|
| **C1** | **Fix + repoint the company grower.** Full diagnosis below — the constraint is the 12,000 IND recognised-sponsor employers we cannot reach because we have no ATS coordinates for them. The current grower looks at tech-startup funding news + six startup ATSs, so it structurally cannot discover finance employers. It also fails nightly with `code:1` — stderr capture is now deployed (`child-run.ts`), so tomorrow's 02:00 run will name the cause. Then: repoint it at finance sources (IND register lookup, accountancy/audit directories, SuccessFactors tenant discovery) instead of funding news. | **The single highest-value item in this plan.** It is the only compounding lever: it adds employers every night, forever, and today it adds zero. |

#### C1 — The full diagnosis

**Why Tashi's lane is thin: a 12,000-employer gap.**

The IND recognised-sponsor register lists ~12,000 employers legally allowed to sponsor visa-based hiring in the Netherlands. We have zero of their board URLs. Here's the flow:

```
IND pool                                12,000+ employers
  ↓
Published ATS corpora (10 platforms)    2,700+ unique companies
  ↓
Overlap (matched by name)                ~300 employers
  ↓
GAP — no ATS coordinates                11,700 employers unreachable
```

We cannot poll an employer if we don't know which ATS platform they use or what their tenant slug is. For Workday, that's the difference between knowing `capri.wd1.myworkdayjobs.com` and seeing "Capri" in a company list with no idea where to probe.

**The grower's job is to discover those coordinates.** Every night it should:
1. Look up IND employer names against published ATS corpora
2. Guess missing ones from professional registers (Dutch accountancy and audit directories; EU finance job boards where employers post)
3. Probe for their ATS endpoints
4. Add any hits to the registry

**What it actually does:**
- Scrapes four tech-startup funding news sources (YourStory, Inc42, Silicon Canals, EU-Startups)
- Probes six startup-favoured ATSs (Greenhouse, Lever, Ashby, Recruitee, SmartRecruiters, Workable)
- Discovers zero companies per night (measured 09-06, 09-07, 09-08)

It structurally cannot reach PwC, EY, Deloitte, ABN AMRO, Rabobank or any Dutch accountancy — they don't appear in startup funding news and they aren't on Greenhouse.

**The nightly failure (code:1, every night):**
- `runMaintenanceChild` in `scheduler.ts` spawns the grower
- It used to swallow stderr, so three days of `code:1` said nothing about the cause
- `child-run.ts` now captures stderr tail — tomorrow's 02:00 UTC run will name it
- When hand-run with env loaded, it exits 0 but discovers 0 boards (personio platform aborts after 12 unknown responses)

**The fix sequence:**
1. Tomorrow 02:00, read the stderr from prod logs
2. Fix the immediate cause (likely a failing import or a misconfigured API key)
3. Repoint the sources: instead of funding news, query the IND register + accountancy directories + SuccessFactors tenant list
4. Verify it discovers ≥1 new boards per night from non-tech employers (measured)
5. Validate that Tashi's brief includes roles from newly-added employers within 24h
| **C2** | Import the 10 already-reachable employers (Grant Thornton, Crowe, NN Group, Shell, RELX, KLM, Fenergo, MN, All Options, ComplyAdvantage) + variant-pass re-join. | ~1h, $0, no new code. |
| **C3** | Adaptive paging — page while postings are inside the freshness window. Recovers backlog on 763 truncated boards (ING cuts at 6 days, AECOM at 2). | Helps both lanes; helps a *new* board most, which is what C1 produces. |
| **C4** | Measure EU finance supply per country. Deliverable is a number, not code. | The Dutch-language finding (35%) raises its value. |
| **C5** | Close AG-013 with the 51-boards evidence. | Decision record only. |
| **C6** | Fix the 15 malformed CSV rows (`, Inc.` quoting). | 15 dead boards. |

### Block D — Nothing ever re-screens · ~2h

`keepUnseen` (`free-ingest.ts:134`) drops every already-stored row forever. Its comment says
re-screening "is already the metered sweep's job" — **that cron was deleted 2026-08-21 and nothing
replaced it.** A verdict is frozen at first sight. That is why 56 India roles sat rejected until a
manual rescreen today, and why **54 of her 118 rows have `liveness = unknown`.**

Fix: periodic re-screen from stored descriptions (no network, no LLM, $0) triggered when a profile's
rules change, plus liveness for never-checked rows.

### Block E — Carried backlog

| id | What |
|---|---|
| **Q-2** | `cv_signals` / `countPassingApplications` partitioned by `track` only, no `profile_id` |
| **Q-3** | `todaysSpend` tenant-wide (visible today — A4) |
| **D-2** | A row ranked out-of-band is `known` next sweep and can never be announced |
| **D-3** | No live Telegram E2E — `TELEGRAM_TESTER_API_ID`/`_API_HASH`/`_SESSION` unset |
| **S-3** | `nl-finance-employers.csv` is a 126-name hand-list, not the market |
| **S-5** | Harvest board tokens from real posting URLs for the 77 employers on no public corpus |
| **X-2/X-3** | Stale board counts in comments (238 / 623 / 858 / 1,297 — all predate 3,223) |

---

## Part 4 — Sequence

1. **A + B as one PR** (~8h) — same surface, and B is meaningless while A's labels lie.
2. **C1** (~4h) — the compounding lever, and it is currently dead. Everything else in C is linear;
   this one is not.
3. **C2, C3, C6** (~5h) — supply, own gate run.
4. **D** (~2h).
5. **C4, C5, E** — measurement and decision records.

### Verification

- **A1** — a row posted 6 days ago and found today reads as both, on prod.
- **A2** — Pushkar's brief accounts for all 166 rows, or states what it cut.
- **A4** — the cost line's numbers match a 3-day SQL window under a 3-day heading.
- **A5** — a backfilled 13-day-old posting does not appear under 🆕.
- **B1–B4** — `/jobs wife`, `/today`, `/fresh wife` and "tashi's last 2 days jobs found" return
  row sets that match direct SQL for the same window and axis.
- **B5** — `/draft 3` resolves to the same role after `/fresh` and after `/jobs`.
- **C1** — the 02:00 cron exits 0 and `boards discovered > 0`, with at least one non-tech employer.
- **D** — `liveness = unknown` falls from 54.

`pnpm gate` exits 0 on each. Every fix starts with a failing test.

---

## Open question

**One.** `/today` (posted < 24h) and `/fresh` (found since you last looked) will return nearly the
same rows on a healthy day, because median discovery lag is 12 minutes. They diverge exactly when
backfill arrives — a newly added board, or a new market. If that distinction does not earn its
keep in use, `/fresh` should absorb `/today` and the surface drops to two verbs.
