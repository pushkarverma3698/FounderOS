# 2026-09-01 — Jobhunt lead-audit and reach fix

## What we did

Founder asked for a deep audit of the job pipeline: is supply capturing good
leads, and are they matched against his real resume/experience. Audit found
the pipeline works but three things quietly cost reach and accuracy; founder
directed fixes for all three plus a fourth (paid-feed spend cap), then
delegated the design of one of them ("take the best decision yourself").

1. **Paid-feed spend cap (founder correction, no code change).** Flagged that
   `JOBHUNT_MONTHLY_CAP_USD=$2` had blocked every paid ATS/Indeed sweep since
   2026-08-12 (one full sweep costs ~$2.36, more than the cap). Proposed
   raising the cap; founder corrected this — the paid feed only exists to
   discover new company boards for the free lane (which does the real
   capture, every 30 min, $0), and the cap must stay under Apify's $5 free
   quota, not be raised toward it. No change made; cap resumes naturally at
   the next billing cycle (2026-09-11).
2. **CV Python gap.** Founder is currently learning Python; added
   "**Currently learning** — Python" to all 5 CV files (ai/backend/frontend/
   fullstack/master) on the VPS (`/opt/founderos-data/cv/`), worded as
   in-progress rather than a claimed production skill.
3. **Standing inventory section (founder delegated the design).** 64
   Netherlands recognised-sponsor salary-pass rows existed in the table, 18
   liveness-verified live, only 1 inside the 24h freshness window — the other
   63 were invisible to every command. Added a new brief section, `standing`:
   pass verdict + liveness re-confirmed live within 7 days + aged out of the
   24h window. Full stack: new query (`listStandingApplications`,
   job-queries.ts), new `BriefSection` value wired through
   brief-persist/brief-row/brief-select/brief.ts/apply-packet's
   `DRAFT_SECTIONS`, and — found only by grepping for the section list rather
   than trusting one call site — THREE more places that independently
   hardcoded `('do_today','stretch')` and would have silently kept standing
   rows unreachable even after the brief printed them:
   `apply-queries.ts`'s `APPLYABLE_SECTIONS` (feeds the Sheet Queue tab AND
   `/csv`), `mac-client/mac_client/sync.py`'s `QUEUE_SQL`, and a duplicate of
   that same query inline in `src/infra/health.ts`'s `/api/v1/jobhunt/queue`
   endpoint. All four fixed together.
4. **Ranking reweight (founder delegated the design).** `compareOverlap`
   ranked by raw matched-term count, so a Windows DevOps posting matching
   Azure/CI-CD/Linux/Mentoring (4/7) outranked an AI Engineer posting matching
   LangGraph/RAG/LLM/Prompt Engineering/AI Agents (10/18) whenever raw counts
   crossed. Added `SKILL_CATEGORY_WEIGHT` (skills-dictionary.ts): every
   category weighted 1, `practice` (Mentoring, Agile, Observability, Code
   Review, etc.) weighted 0.35. `compareOverlap` now sorts by weighted count,
   ratio unchanged as tiebreak. Deliberately not "AI beats backend" — every
   category but `practice` is untouched, so a track's CV still only wins
   against its own postings' vocabulary.

## What we fixed

- `daily-brief.ts` crossed the 400-line CI budget once the standing pool was
  added; extracted `toBriefRow`/`toLiveness`/`ageInDays` into a new
  `brief-assemble.ts` (same precedent as brief-cv.ts/brief-trends.ts before
  it), re-exported so `liveness-unknown.test.ts`'s import kept resolving.
- `pnpm verify:doc-claims` failed on the new file count (335→336 TS source
  files) in `docs/ROADMAP.md` and `docs/study/INTERVIEW-BRIEF.md`; fixed with
  the documented `--fix` flag, not by hand.

## Why

Founder's own words, and the project's rule #26: a screener that runs
flawlessly and produces zero applications never had screening as its
constraint. The audit showed screening/gating was solid; the constraint was
reach (63 of 64 qualified NL rows never shown) and ranking fidelity (the
displayed order didn't reflect the founder's actual specialization).

## Metrics

- `pnpm gate`: 332 test files, 3666 tests, lint/build/wiring/architecture/
  doc-claims all green.
- `mac-client/tests/test_sync.py`: 24/24 pass (isolated venv, playwright not
  installed for the rest of the suite — not exercised, unrelated to this
  change).
- Architecture ratchet unmoved: `loc-budget: 6 (= baseline)` — job-queries.ts
  was already one of the six grandfathered over-400-line files; it grew but
  did not add a new violation.
- New/changed tests: overlap.test.ts (+2), brief.test.ts (+7), brief-reach.
  test.ts (+4), untailored-priority.test.ts (+1 assertion),
  mac-client/tests/test_sync.py (1 assertion updated).

## Outstanding

- Standing rows are never re-verified after entering the pool — they decay
  out after 7 days without a fresh liveness check rather than cycling
  live→shown→re-verified. Deliberately not built this session (founder asked
  for a fix to the reach gap, not a new re-verification subsystem); worth
  revisiting if the 7-day cutoff turns out to hide roles that are still open.
- Not committed/pushed yet — this doc describes work still sitting in the
  worktree on `claude/job-pipeline-lead-audit-b8fcff`.
