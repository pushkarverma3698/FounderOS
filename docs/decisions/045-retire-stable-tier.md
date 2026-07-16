# ADR-045: Retire the `stable` tier — two-stage production promotion

**Status:** Accepted · 2026-07-16
**Supersedes (in part):** ADR-039 (weekly release train), the `stable` references in
CLAUDE.md and `.github/CODEOWNERS`.
**Builds on:** ADR-021 (main IS production), `docs/process/BRANCH-MODEL.md`,
`docs/process/RELEASE-PROCESS.md`, ARCHITECTURE_LEDGER Entry 11 (the v3 promotion that
already folded `stable` into the ladder).

## Context

The documented branch ladder was `feat/* → beta → stable → main`. In practice the
`stable` tier no longer exists:

- **No branch.** `git ls-remote --heads origin` has no `stable` ref. It was retired
  during the v3 promotion (ARCHITECTURE_LEDGER Entry 11: `git merge -s ours` recorded
  `origin/stable` as an ancestor of `beta`, then the branch stopped being maintained).
- **No CI.** `.github/workflows/branch-policy.yml`, `sync-beta.yml`, and `deploy.yml`
  reference only `beta` and `main`. `branch-policy.yml` literally enforces
  `feat/*|cursor/* → beta → main`. Nothing checks or promotes `stable`.
- **The canonical process docs already dropped it.** `RELEASE-PROCESS.md` opens with
  "`feat/* → beta → main`"; `BRANCH-MODEL.md`'s diagram shows only `main`/`beta`/`feat`.

So `stable` survived only as **stale prose** in the load-bearing instruction files
(CLAUDE.md, CODEOWNERS, ADR-039). That mismatch is what made "going to production" feel
like a difficult, multi-hop process: the map showed three promotion hops where the
territory has two.

A `stable` staging tier between `beta` and `main` earns its keep only when `beta` is too
noisy to promote directly and you need a soak branch. Here it is not: `beta` is already
the integration branch, it is gated by the same required `gate` CI check as `main`, and
`main` is protected (CODEOWNER review, no force-push, CD on merge). A third branch adds a
promotion hop and a sync burden (`sync-beta.yml` already fast-forwards `beta` after every
`main` push) without adding a protection guarantee `main`'s branch protection doesn't
already provide.

## Decision

**Make the ladder officially two-stage: `feat/* → beta → main`. Retire `stable`
entirely — no branch, no CI, no docs.**

- Production truth is `main`; integration is `beta`; work happens on short-lived branches
  cut from `beta`. Only the founder merges `beta → main` (CODEOWNERS + branch protection);
  CD deploys on that merge.
- Every doc references `feat/* → beta → main`. Any lingering `beta → stable → main` text
  is a bug to fix, not a process to follow.
- The weekly release train (ADR-039) is unchanged in cadence and quality gates; only the
  promotion target collapses from `beta → stable → main` to `beta → main`.

## Consequences

- **Simpler mental model.** One promotion PR (`beta → main`), one protected branch, one CD
  trigger. Nothing new to remove from CI — CI was already two-stage; this aligns the docs
  to it.
- **No protection lost.** `main` keeps CODEOWNER review + required `gate` + no force-push.
  `beta` keeps required `gate` + PR-required. The retired hop guarded nothing these don't.
- **If a soak stage is ever needed** (e.g. multi-tenant customers on prod), reintroduce it
  as a *tag/release* on `main` or a `staging` deploy target — not as a fourth branch to
  keep in sync.

## Founder production runbook (two-stage)

```
work branch ──PR──▶ beta ──PR (founder merges)──▶ main ──CD──▶ VPS
   (agents/CI open PRs to beta)      (only human hop)   (deploy.yml)
```

1. Confirm `beta` is green + live-verified (Friday checklist in RELEASE-PROCESS.md).
2. Open the promotion PR: `beta → main`. `branch-policy.yml` allows `main` PRs only from
   `beta`, so this is the single sanctioned path.
3. Founder merges in the GitHub UI. `deploy.yml` deploys; `sync-beta.yml` fast-forwards
   `beta` back to `main`.
4. Watch the deploy; confirm on-box `/health` is not degraded.

Emergency hotfix path (active prod outage only) is unchanged: `fix/* → beta → main`
fast-track, or a documented direct `fix/* → main` with branch-policy as the audit trail.
