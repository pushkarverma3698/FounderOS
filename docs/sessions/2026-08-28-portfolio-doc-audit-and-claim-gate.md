# 2026-08-28 — Portfolio doc audit, and a CI gate for documented numbers

## What we did

Audited every recruiter-facing document against the repository and production, on the founder's
instruction to make the product portfolio-ready before showing it for hiring.

- **Verified the portfolio plan was already complete.** All seven phases of
  `docs/plans/…-portfolio-audit` (evidence regeneration, the corrected architecture diagram,
  dead-weight deletion, the ADR index, unlinking `strategy/`, the jobhunt reframing, the
  follow-up punch list) had landed in PRs #586–#590. Nothing to redo.
- **Reconciled every measured claim** in README, `docs/EVAL.md`, `docs/LIMITATIONS.md`,
  `docs/ROADMAP.md` and `docs/study/*` against a fresh `pnpm gate` and a live prod query.
- **Built `scripts/verify-doc-claims.ts`** and wired it into `pnpm gate` — the docs now fail CI
  when a number in them stops being true.
- **Added Story 6** (the CV fabrication guard) to the interview brief, and rewrote the
  "what's broken right now" answer, which named two things that had been fixed the same day.

## What we fixed

**The same quantity was stated five different ways.** This is the finding that mattered, because
a reader who catches one stale number stops believing the other five:

| claim | measured today | what the docs said |
|---|---|---|
| offline tests | **3,649** | 3,611 · 3,499 |
| test files | **332** | 337 · 331 · 329 · 321 |
| source files / LOC | **335 · 58,141** | 316 · 55,510 |
| ATS board registry | **1,297 / 10 platforms** | 623 · 923/7 · 297 · 238 · 200 · 142 |
| ADRs | **50** | 51 |
| golden tasks | **41** | 46 (in two more places) |

Every one of those had been true when it was written. None were re-checked, because nothing
checked them.

- **The README overstated the architecture ratchet as "current: all zeros"** while
  `governance/architecture-baseline.json` carries `loc-budget: 6` and `fail-open-catch: 11`, and
  `LIMITATIONS.md` names those files individually. The honest doc and the headline doc disagreed,
  and the headline was the flattering one. README now states rules 1–5 at zero and 6–7 as pinned
  debt. It also undercounted the fitness rules as five when `verify-architecture.ts` implements
  seven.
- **The README told recruiters the eval report was "2026-06-11, pre-v3"** — 2.5 months stale and
  describing the tombstoned v2 graph. It had in fact been regenerated the same day at **85%**.
  That line was undermining the single strongest artifact in the repo.
- **`334 TypeScript source files` was wrong in a way worth recording.** It came from
  `git ls-files 'src/**/*.ts'`, and git's `**` pathspec skips `src/index.ts` because it requires
  an intervening directory. The real count is 335. The new checker found this, not a human.
- **`docs/LIMITATIONS.md` still said "46 golden tasks"** in §A4 — the exact miscount corrected
  elsewhere in the same file two days earlier, missed because the correction was applied by hand.
- **Four broken links on the recruiter path**, including an ADR cross-reference with a typo'd
  filename (`022-typed-inter-department-contracts.md` for `022-typed-interdept-contracts.md`) and
  three pointers to documents that had been deleted. The remaining 27 broken links live in
  `docs/antigravity/`, `docs/plans/` and `docs/strategy/` — deliberately off the recruiter path,
  recorded but not chased.
- **Recorded the CV re-tailoring outcome**, which had been run but never written down: 1 of 6
  clean, 5 correctly refused, and the reason the 5 are a screening problem rather than a
  tailoring one.

## Why

The founder is about to show this repository to employers. The audit's binding constraint was
never "is the architecture good" — the evidence map already answers that — it was **whether a
reader can trust the numbers**, because a portfolio is a set of claims and every one of them is
falsifiable in one command.

Fixing the numbers by hand would have been worth roughly a week. They had drifted five ways in
six days precisely because prose is a layer-4 convention in this repo's own precedence order and
nothing enforced it (CLAUDE.md rule #27: *a rule with no mechanism decays*). So the fix is a
mechanism, not a correction: `verify-doc-claims.ts` measures the repo and fails the build on
drift, with two sources of truth and no hand-maintained constant —

1. `docs/PROOF.md` is *generated* by `pnpm proof:scoreboard` from a real `vitest run`, so it
   cannot drift from reality; it is the truth for test counts.
2. Everything else is measured at check time (tracked source files, CSV rows, ADR files, the
   `GOLDEN_TASKS` array).

It ships with `--fix`, and that was a design decision rather than a convenience: exact-match
enforcement fires on **every test-adding PR**, and a gate that costs a manual edit each time gets
switched off — which is how the docs drifted in the first place. Adding four tests during this
session immediately proved the point, moving the count 3,645 → 3,649 and turning the gate red
against my own work.

Scope was held deliberately: historical documents (`docs/plans/`, `docs/sessions/`, ADRs) describe
a past state on purpose and are exempt by design. `MARKET-2026-AI-ENGINEER.md` still says
**623 boards** because that is the registry size *at collection time* for the 911-posting study —
methodology, not drift. Rewriting it to today's 1,297 would misdescribe the study's own sample.

## Metrics

- **`pnpm gate` green** — 332 files / 3,649 tests, lint + build + wiring + arch + doc-claims.
- **21 stale numbers rewritten** by the first `--fix` run, plus the URL-encoded README badge,
  which the first version of the checker missed because shields.io encodes the comma as `%2C`.
- **6 measured claims enforced** across 7 recruiter-path docs.
- **4 new tests**, including one that injects drift into README and asserts the script exits 1 —
  a fitness function that can only pass is decoration.
- Ratchet unchanged: `gateway-imports 0 · kernel-purity 0 · regex-routing 0 · orphan-subsystem 0
  · fail-open-catch 11 · loc-budget 6`.

## Outstanding

1. **Send the applications.** Still the binding constraint, and untouched by this session: 59 of
   61 qualified, sponsor-verified, salary-clearing Dutch roles have never been applied to. The
   GitLab CV is clean and ready.
2. **Decide on the 5 refused applications** — a matching decision, not a tailoring retry. Either
   accept them as out-of-profile or change what the screener admits.
3. **27 broken links off the recruiter path** in `docs/antigravity/`, `docs/plans/`,
   `docs/strategy/` and `docs/founderos-v2/`. Low value, recorded for completeness.
4. **The golden set still isn't in CI** (costs money). The weekly-schedule middle path is written
   down and unbuilt.
