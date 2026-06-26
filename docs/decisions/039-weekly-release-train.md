# ADR-039: Weekly Release Train + Enforced Quality Gates

**Status:** Accepted · 2026-06-25
**Builds on:** ADR-021 (main IS production), BRANCH-MODEL.md (feat → beta → stable → main)

## Context

Work has been reaching production ad hoc. The recurring P0s in this project — wedged
threads, duplicate bot instances, stale replies, empty RAG store, and the 2026-06-25
deploy-script `unbound variable` bug — **all passed the unit suite while failing in
production**. A green `pnpm test` is necessary but not sufficient (rule #19). At the
same time, the founder builds ~4–5 features/week with Claude Code and needs a
predictable shipping rhythm rather than continuous risky merges to `main`.

The branch model (`feat → beta → stable → main`) already exists but defines only *how*
code flows, not *when* it ships or *what bar* it must clear before promotion.

## Decision

**Adopt a weekly release train: build Mon–Thu on `feat/*`, integrate continuously on
`beta`, freeze Thursday, and promote `beta → stable → main` every Friday — with an
explicit per-stage quality gate and a "complete + proven, not calendar-driven"
definition of done.** Full operational detail in `docs/process/RELEASE-PROCESS.md`.

Key points:
- **Friday is the only scheduled production deploy.** Emergency hotfixes for active
  prod outages may fast-track `beta → stable → main` (or, for downtime, `fix → main`
  with branch-policy as the audit trail) — the documented exception, not the norm.
- **Definition of Done gates every `beta` merge:** tests green + regression test for any
  fix, lint/tsc clean, code review, real-path evidence (rule #24), docs/memory updated.
- **The `beta` tier carries the missing layer:** a Thursday freeze + live MTProto
  verification before anything reaches `main`. This is precisely what the historical
  P0s slipped through.
- **Throughput target 4–5 features/week is a ceiling, not a quota** — an unfinished
  feature waits for the next train rather than shipping half-done.

## Consequences

- **+** Production changes become predictable, reviewable, and live-verified. The class
  of "passed tests, broke prod" bug is structurally caught at the beta freeze.
- **+** Claude-Code-built features get a clear, repeatable path to prod.
- **−** Median feature latency to prod rises to ≤1 week (acceptable; emergency path
  exists for true outages).
- **−** Requires discipline: the founder must run the Friday checklist (incl. one paid
  live MTProto QA pass) every release. This is the cost of the verification guarantee.

## Enforcement
- Branch protection on `main`/`stable` (founder-only merge), required CI on `beta`/`main`.
- `branch-policy.yml` flags PRs that bypass the ladder.
- The Friday checklist + rollback runbook live in `docs/process/RELEASE-PROCESS.md`.
