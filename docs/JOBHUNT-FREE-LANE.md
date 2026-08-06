# The free board lane

## What it is

A second job-supply lane that polls company job boards directly — Greenhouse,
Lever and Ashby — through their public, unauthenticated JSON endpoints. No API
key, no quota, no per-job price. It runs every 30 minutes alongside the metered
Apify feed, which continues to run every third day.

It does not replace the metered feed. That feed reaches companies whose boards are
not in this registry, and it returns description text Greenhouse withholds. This
lane front-runs it.

## Why it exists

The metered feed is billed per job returned. That single fact drives every
limitation it has: it must decide what it wants before it asks, so it sends narrow
title queries capped at ten results each, on a three-day cadence chosen to control
spend.

Measured against production on 2026-08-06, its median lag from a posting going
live to us holding it was **19.6 hours** (n=22; 14 of 22 rows landed inside 24
hours). Polling a board directly closes that to the polling interval.

That head start is the entire product. The founder applies while the posting is
hours old, before it propagates to the aggregators every other applicant is
refreshing.

## What it actually yields

**Measured, 12-board live probe, 2026-08-06:**

| Metric | Value |
|---|---|
| Boards sampled | 12 of 238 |
| Postings returned | 741 |
| Sweep wall time | 4.5s (→ ~90s for all 238) |
| Postings with a parseable publication date | 741 / 741 |
| Published within 7 days | 54 (~1.1 per board per day) |
| Dead tokens (HTTP 404) | 3 of 12 |

Extrapolated to the full registry: roughly **260 new postings a day**, narrowing
to an estimated **15–25 relevant** NL/India/remote engineering roles after the
track and country filters.

### Registry maintenance, 2026-08-06 (`scripts/jobhunt-board-registry.ts`)

`prune` polled all 238 and dropped 36 tokens that answered a definitive 404/410
(0 `unknown` — no timeout or 429 was ever read as absence). `grow` probed 12,760
tokens derived from the IND recognised-sponsor register and found 144 live
boards, of which **83 were kept and 61 dropped**.

The 61 were dropped because only Greenhouse exposes an endpoint that declares
which company a board belongs to. For Lever and Ashby the run could not confirm
ownership, and writing the *register's* name onto an unconfirmed board asserts
exactly the fact the sponsor gate exists to establish: `matchSponsor()` returned
a confident `sponsor` PASS for all 61 — "Focus B.V.", "Lemonade B.V.",
"SoSafe B.V." — when those tokens far more likely belong to the US, Belgian and
German companies of the same name. A false PASS on the permit gate costs an
application and teaches the founder to distrust the gate afterwards.

Boards whose declared name *disagrees* with the register were kept: the declared
name is still the truth about who owns the board, so the gate answers honestly
(`General Assembly Remote Jobs` → uncertain, `Wellhub` → not-sponsor).

**Registry: 238 → 202 (prune) → 285 (grow).** 207 Greenhouse, 62 Lever,
16 Ashby.

**A correction is recorded here deliberately.** An earlier estimate in this
project put the figure at 1,739 new postings a day and ~137 relevant ones. That
count almost certainly read Greenhouse's `updated_at`, which changes every time
anyone edits any field, rather than `first_published`. The mapper uses
`first_published` for exactly this reason, and the corrected figure is roughly an
order of magnitude lower. The lane is still worth running — 15–25 roles a day
caught hours early is a real advantage — but it is not the number originally
claimed, and planning against the inflated one would have been planning against
nothing.

## Design

```
registry (CSV, 238 boards)
   ↓  sweepBoards        bounded concurrency, per-board failures COUNTED
raw candidates
   ↓  filterCandidates   freshness · engineering track · NL/IN/unknown market
   ↓  keepUnseen         first-seen check against the tracker
   ↓  hydrateDescriptions  Greenhouse bodies only, only for survivors
   ↓  screenBatch        the SAME gates the metered feed uses, unchanged
job_applications + job_ingest_runs (cost recorded as 0, never omitted)
```

### Why each filter runs before screening

The standing rule in this codebase is that a posting must be rejected *inside* the
pipeline, where the reason is stored and shown, never dropped outside it — because
a filtered-out row and an empty market look identical from the far end.

That rule is about **verdicts** — about roles we could have applied to. It is not
a requirement to run the sponsor register and the salary parser over every
warehouse vacancy and concept-artist role on 238 boards, forty-eight times a day.
So three cheap local filters run first, and **each one reports its count** as a
note on the run: "687 postings older than 168h", "53 postings were not an
engineering track". The drop is never silent.

### The decisions worth knowing

| Decision | Why |
|---|---|
| Greenhouse bodies fetched per-posting, not inline | `?content=true` returned **742 KB for one 52-job board**. Across 142 boards every 30 minutes that is not a payload. The cheap list endpoint carries `first_published`, so freshness is decided before any body is fetched. |
| `first_published`, never `updated_at` | `updated_at` moves on every edit, which would re-date a year-old posting as new on a typo fix. |
| Undated postings are dropped, not kept | All three platforms state a publication date, so a missing one means a malformed row. Treating unknown age as fresh is how a three-year-old listing reaches the top of a brief that promised new roles. |
| Country from the posting's location, never the board's `markets` column | A board is a company, and a company hires wherever it likes. `markets` is provenance — which market list we sourced the board from — not a claim about any posting. |
| `unknown` country is KEPT, `other` is dropped | Remote postings frequently state no country. Dropping those would discard the most reachable roles on the board. |
| Bodiless postings are skipped, with a count | An empty description reads to the gates as "this employer stated no requirements", and every one of them would wave it through on that basis. |
| Cold start handled by the freshness window | The first sweep of the registry sees ~16,000 live postings. Only those inside the window are candidates, so run one behaves exactly like run two hundred. |
| 6-hour window against a 30-minute interval | The window is the lane's tolerance for its own downtime. A deploy or an outage lasting most of a morning costs nothing. Matching the window to the interval would make every missed sweep a permanent, invisible hole. |
| Concurrency bounded at 8 | The registry is 238 boards but only **three hosts** — all 142 Greenhouse boards resolve to one origin. An unbounded sweep is a 142-request burst at a single host every half hour, which is indistinguishable from a scraper. |
| Ledger row written at $0 | A free lane that logs nothing is indistinguishable from a free lane that stopped running — and this one runs unattended 48 times a day. |

### Alerting

The lane does **not** message on every sweep. Forty-eight notifications a day
trains the founder to ignore the channel, which is the failure this pipeline
already has on record.

It sends exactly two kinds of message:

1. **A new role cleared every gate.** At most one message per sweep, naming up to
   five roles as `company — title`. It deliberately does **not** print `/draft N`
   numbers: those are pinned when the brief renders, so a number invented here
   would resolve to the wrong row or to nothing. It points at the brief instead.
2. **The lane is broken.** Every board failed and nothing was screened. A lane
   that goes quiet is indistinguishable from a market with no jobs in it.

Nothing here submits an application. ADR-009 stands: `/draft` still stops at the
human approval card.

## Known limitations

- **Registry skew.** The board list came from a dataset dominated by gaming
  companies, and holds only 24 NL-sourced boards against 177 India-sourced. It is
  not a neutral sample of either market.
- **Dead tokens.** 3 of 12 sampled Greenhouse tokens returned 404. These cost a
  wasted request every sweep and inflate the failure count, which masks real
  outages. A pruning pass is outstanding.
- **Greenhouse descriptions cost a request each.** Bounded by the freshness and
  first-seen filters to a handful per sweep, but it is the one place this lane
  spends anything at all — time, not money.

## Verification

- `pnpm gate` — `scripts/verify-runtime-assets.ts` loads the registry **through
  the built output in `dist/`** and asserts it parses to at least 200 boards. That
  check exists because the sponsor register silently stopped resolving in
  production for four days while every unit test passed, and nothing in the gate
  had ever executed the built artefact.
- `getFreeBoards()` throws below `MIN_EXPECTED_BOARDS`. It is deliberately not
  fail-open: a lane polling zero boards reports "no new roles" in exactly the same
  words as a lane that polled 238 and found none.
