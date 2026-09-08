# 2026-09-09 — Apply-link verification, the log CSV, NL scope, and the cron audit

## What we did

Audited four surfaces against **live prod data** before changing anything, then fixed
what the measurement found.

### The audit (measured, not inferred)

**Link data is clean; link *verification* was not.**

```
profile           total  no_url  not_http  short_url  ranked
pushkar-nl-tech    1696       0         0          0     431
wife-nl-finance     118       0         0          0      96

pushkar-nl-tech  unknown 856 | live 785 | unverifiable 36 | expired 19
wife-nl-finance  unknown  38 | live  78 | unverifiable  1 | expired  1
```

Every row carries a real http URL. But `verifyLiveness` had exactly one caller —
`buildDailyBrief`, on the top `VERIFY_TOP_N` (60) rows. **Every CSV path read the stored
column and rendered it.** 894 of 1,814 rows said "not checked" in a file presented as the
one you apply from.

**The log CSV could not be decided from.** Eight columns: no rank, no permit basis, no pay,
no sponsor verdict, no liveness. The only file reaching past the ranked queue was the one
you could not act on.

**Natural language dropped half of every scoped question.** `jobBriefTool` declared `verb`,
`range` and `axis`; the LangChain wrapper the planner actually sees
(`capabilities.ts` registers `jobBrief`, never `jobBriefTool`) declared two fields. So
"tashi's last 2 days jobs found" arrived as `{profile: "tashi"}`.

**The grower cron's crash is fixed; the job is useless.** Run on prod exactly as the
scheduler spawns it:

```
code= 0
companies found 12 · tokens probed 12 · boards discovered 0 (0.00% hit rate)
registry 3223 → 3223
personio probed 12, unknown 12 — ABORTED (HTTP 429)
```

The nightly `code:1` (2026-09-03 → 09-08) was env plumbing, resolved by the current deploy.
Free sweeps are healthy: 3,223 boards every 30 min, 14 board failures (0.43%).

## What we fixed

1. **`liveness-refresh.ts`** — re-checks stale rows freshest-first inside an explicit
   budget (`CSV_VERIFY_MAX`, `LIVENESS_STALE_HOURS`), persists each verdict, and returns
   `verified`/`skipped`/`alreadyFresh` so the caption can name what it could not reach.
   Never throws: a verification outage costs the check, never the file.

2. **`verificationTargets` takes the visible predicate.** The budget was spent over the
   whole ranked queue while the scope filter that decides what prints ran afterwards — so
   `/today` could verify sixty roles from last week and print six from this morning
   unchecked. Printed rows are now bought first, leftovers spent as before.

3. **The log CSV carries the queue's decision columns** and sorts by pinned rank.

4. **`job_brief` and `export_jobs_csv` forward `verb`/`range`/`axis`**, through the same
   `brief-resolver.ts` primitives the slash commands parse with.

5. **`/csv` learns `today`, `fresh` and a range** — the file is what you want precisely
   when the screen cannot hold the answer.

## Why the `#` column prints a command

Verification against prod found **every `brief_rank` 1–12 for `pushkar-nl-tech` held by
exactly two rows, one `ask` and one `do_today`.**

That is correct upstream, not a bug: `DRAFT_SECTIONS` is `do_today, stretch, standing`
(`apply-packet.ts:67`) and `/ask` resolves against `ask` alone
(`jobhunt-commands.ts:353`). Rank 3 legitimately names two roles. A bare `3` in one column
is what would have been wrong, so the cell prints `/draft 3` or `/ask 3` — copyable, and
impossible to misread — and the sort groups the namespaces instead of interleaving them.

## Metrics

| | |
|---|---|
| `pnpm gate` | exit 0 — **4,156 tests, 380 files** |
| New tests | 48 across 5 files |
| Prod CSV render (read-only, 40 real rows) | 16 columns, **40/40 links http**, `#` monotonic per namespace |
| Live link check (6 real ATS hosts) | 5 `live`, 1 `unverifiable` (HTTP 403 — correctly not called dead) |

## Outstanding

- **Not driven through Telegram.** `TELEGRAM_TESTER_API_ID`/`_API_HASH`/`_SESSION` are
  still unset, so grammy routing and planner extraction are unproven. Everything above was
  verified against the real database and real ATS hosts, never through the real transport.
- **The grower discovers nothing.** 12 companies a night from tech-startup funding news;
  it structurally cannot find finance employers. That is the supply work in
  `docs/plans/2026-09-08-fresh-first-jobhunt.md` § C1, not a cron fix.
- **`personio` returns 429 on every probe** and aborts the host each run — 12 of 12
  unknown. Wasted probes, no signal.
- **Auto-attaching a CSV when `/jobs <range>` overflows the message** was scoped out of
  this change deliberately; it was not asked for in this round.
