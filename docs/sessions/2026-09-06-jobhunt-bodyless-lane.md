# 2026-09-06 — the sweep ran perfectly and produced nothing for thirty hours

The founder's report: *"the 30 min sweep is not running and no new job is being
found for her [Tashi], and also audit for Pushkar."*

The sweep **was** running. Every thirty minutes, both profiles, 1,297 boards, no
errors. That was the problem: a lane that runs, logs success, writes a ledger row
and delivers nothing looks healthy from every angle except the only one that
matters.

This session resumed an earlier one that died on a usage limit at the
diagnostics stage (worktree `job-pipeline-audit-d5ea3d`, clean tree, zero
commits). Its stopping point was recovered from the raw transcript.

## What we did

Read the funnel out of production rather than guessing at it —
`agents.job_ingest_runs` has carried per-stage counts since 2026-08-21:

| | seen | undated | stale | offTrack | offMarket | known | **bodyless** | screened |
|---|---|---|---|---|---|---|---|---|
| pushkar-nl-tech | 46,991 | 1,476 | 25,147 | 18,193 | 1,687 | 481 | **7** | **0** |
| wife-nl-finance | 46,991 | 1,476 | 25,139 | 20,005 | 312 | 58 | **1** | **0** |

Those two rows are not a snapshot. They are **every sweep, unchanged, for thirty
hours** — 60 consecutive runs, `returned = 0` on all of them. The last new row in
`job_applications` was 2026-09-05 11:31 UTC for Pushkar and 08:01 UTC for Tashi.

Exactly the postings that survived freshness, track, market and the tracker were
the ones being destroyed, 100% of them, at the last gate.

## What we fixed

**1. Lever states a body in three fields; we read one.**

`scripts/diagnose-free-funnel.ts` stopped at "KEPT to dedupe" — one stage short
of where the lane was dying. Extended to the body stage, it named the platform
in a single run: 6 Lever, 1 Personio. Confirmed against the live API:

| board | `descriptionPlain` | `description` | `lists` |
|---|---|---|---|
| extremenetworks (×5) | `""` | full HTML | 0 |
| brillio-2 | `""` | `""` | 2 blocks |
| macaw (personio) | — | `<jobDescriptions></jobDescriptions>` | — |

`leverAdapter.listJobs` read `descriptionPlain` and nothing else. A posting with
an empty plain field arrived with `description: null`, and `runFreeIngest` drops
a bodyless posting before screening — so it was never stored, therefore never
`known`, therefore came back to die again thirty minutes later, forever.

`leverBody()` now reads `descriptionPlain` → `description` (HTML) → `lists`, and
still returns null when the employer genuinely posted nothing. Live
re-verification over all 1,297 boards:

```
before   lever/ok 44   lever/inlined-empty 6
after    lever/ok 48   lever/inlined-empty 0
```

Only the Personio posting remains, and its `<jobDescriptions>` is empty at the
source — the one case the gate is actually for.

**2. `bodyless` was a number with no cause.** It conflates four situations —
no adapter for the platform, the adapter inlines bodies and the list payload had
none, the detail fetch failed, the employer posted nothing — and only the last is
the market's doing. `summariseBodyless` now splits the count per platform and
cause in the sweep notes and as a `log.warn`. "7 postings had no readable
description" reads like the employer's fault; `lever inlined-empty ×6` reads like
ours, which it was.

**3. The alert built to catch this would have blamed the wrong stage.**
`topDropReason` returned the stage with the largest count. On every real sweep
this lane has ever run that is `stale` — it is the first filter and 53% of a
47,000-posting sweep is older than the window on a healthy day too. A statistic
that reads identically during a total outage and during a normal Tuesday carries
no information about either.

Replaced by `funnelClosingStage`, which walks the gates in pipeline order and
names the one that took the survivors to zero. On the production funnel above it
returns `no body description ×1`. The old rule would have returned `stale age
cutoff ×25,139` and sent the founder to inspect a freshness window that was
working correctly.

## Why

This is the 2026-08-07 shadow-table failure and yesterday's `Search failed at
stage embed:` wearing a third mask: a subsystem that is dead but reads as merely
unlucky. The repo's own rule says a failure must name its real component. Three
separate places in this lane — the drop counter, the alert, and the diagnostic
script — each stopped one step short of the component that was actually failing.

No test could have caught it. 3,747 tests were green throughout; the fixtures all
carried `descriptionPlain`, because that is the field Lever documents. Only
running the real thing against the real boards showed it.

## Metrics

| | |
|---|---|
| `pnpm gate` | **exit 0** — 342 files · **3,756 tests** |
| Baseline (#620 head) | exit 0 — 342 files · 3,747 tests |
| Tests added | 9 (4 Lever body fallbacks, 3 bodyless attribution, 3 closing-stage, −1 rewritten) |
| RED verified before each fix | yes |
| Postings recovered per sweep | 6 of 7 (Pushkar), 1 of 1 (Tashi) |
| Outage duration before detection | ~30h, 60 sweeps, 0 alerts |
| Live re-verification | full 1,297-board sweep, twice |

## Outstanding

1. **Not yet deployed.** The fix is on `claude/fix-jobhunt-bodyless-lane`; prod
   still runs `8985078` and is still dropping these postings every 30 minutes.
2. **Personio's structured metadata is thrown away.** The Macaw posting has an
   empty body but states `keywords`, `department`, `seniority`,
   `yearsOfExperience` and an explicit `salaryInformation` (€4,500–6,000/mo,
   Hoofddorp NL) — a role Pushkar should see. Screening a synthesised body would
   change what a gate's "the employer stated no requirements" means, so this is a
   founder decision, not a silent improvement.
3. **The zero-pass alert fires once, at exactly 6 consecutive sweeps, and a
   restart resets the counter.** Prod restarted 18 times in three days. The
   30-hour outage produced no repeat warning. Left alone deliberately — the
   cadence is a noise trade-off the founder should set.
4. **The apply half was not exercised this session.** CVs are present on prod for
   both profiles (`cv-master.md`, `cv-wife-base.md`), but `/draft` → tailor →
   `deliver_artifact` was not driven end to end.
5. **`job_ingest_runs` has no `profile_id`.** Both profiles write a row per sweep
   and they are told apart only by their funnel numbers — which is how this
   session had to do it.
