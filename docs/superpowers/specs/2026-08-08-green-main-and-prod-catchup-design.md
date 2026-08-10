# Spec A — Green main, catch prod up, live-verify (2026-08-08)

## Problem

`main` is red. CI run [31239271804](https://github.com/pushkarverma3698/FounderOS/actions/runs/31239271804)
failed on `957ac81` (the PR #423 merge, 2026-08-08). Deploy was skipped as a
result — the VPS is still on `001b832`, one commit behind `main`. Everything
downstream (branch cleanup, live E2E, "going live") is blocked on this.

Two unrelated CI bugs, both introduced by the same "parallelize CI" commit
(`c465b35`):

1. `ci.yml` runs `pnpm verify:runtime-assets` before `pnpm build:all`.
   `verify:runtime-assets` requires `dist/` to exist. Local `pnpm gate` runs
   these in the correct order; CI now describes a different, wrong order in a
   second place.
2. `tests/unit/tools/project-workflow.test.ts` calls
   `mkdtempSync(join(homedir(), "Projects/founderos-test-"))` and assumes
   `~/Projects` already exists on the runner. It doesn't. Identical bug class
   to the one `473e1a7` already fixed in `deploy-static-site.test.ts`.

Separately: a prior session left work uncommitted (Claude session ingestion
into the brain) and referenced a script (`pnpm ingest:claude`) in memory that
was never wired into `package.json`. And of 28 branches, only one carries
content not already on `main` (a `randomUUID()` fix in `free-ingest.ts`,
PR #424) — the rest are stale refs that would revert ~5,600 lines if merged
literally as asked.

## Goal

`main` green, prod running `main`'s SHA, live E2E proof regenerated, repo
branch list reduced to active work only — inside a €0.50 live-spend cap.

## Non-goals

- No new features. No refactors beyond the two CI bugs.
- Not merging any of the 26 already-merged branches — they are archived
  (tag) and deleted, never merged again.
- Not touching `beta` semantics beyond retiring the workflow that promotes
  through it (separate call after this ships — see open question).

## Changes

### Phase 0 — Unbreak main
- `ci.yml`: replace the ad-hoc step list in the `quality` job with a single
  `pnpm ci:quality` script (new, in `package.json`) that runs lint → arch →
  wiring → **build** → runtime-assets, in that order. This makes the ordering
  a single source of truth shared with local `pnpm gate`, so the two cannot
  drift again — which is exactly how this outage happened.
- `project-workflow.test.ts`: `mkdirSync(join(homedir(), "Projects"), { recursive: true })`
  before the two `mkdtempSync` calls (lines 209, 224).

### Phase 1 — Land the uncommitted work
- Wire `ingest:claude` into `package.json` pointing at
  `scripts/ingest-claude-sessions.ts` (script exists, entry point doesn't).
- Commit: `src/lib/claude-transcript.ts`, `scripts/ingest-claude-sessions.ts`,
  `scripts/tui-dashboard.ts`, their three test files, and the market-intel
  block already staged in `scripts/sync-turicks-brain.ts`.
- Do not commit: `.agents/scratchpad/*.log`, `mac-client/*.pdf`,
  `mac-client/tests/test_apply.py` (scratch/test-fixture artifacts, not
  reviewed source) — flagged to the founder, not deleted silently.

### Phase 2 — Branch cleanup (cherry-pick, not merge)
- Cherry-pick `a706b97` (`randomUUID()` sweepId fix) from
  `cursor/fix-free-ingest-uuid-d523` onto the working branch. Close PR #424
  as superseded.
- For the 26 branches with 0 commits ahead of `main`: `git tag archive/<name> <sha>`
  then delete the branch (local + remote). Reversible — the tag preserves the
  commit.
- Retire `beta` from the promotion flow (see Open Questions) — not deleted
  this pass, just no longer the required path.

### Phase 3 — Deploy, verify prod moved
- Push, let CI run, let `deploy.yml` fire on green CI.
- Verify via `ssh founderos-vps 'cd /opt/founderos && git log -1 --format=%H'`
  matches the pushed SHA. "Merged" is not "deployed" — this step is the
  actual completion criterion for "prod caught up."

### Phase 4 — Live E2E, capped at €0.50
- Set `RUN_BUDGET_USD` as a hard stop for this run.
- Sequence: `pnpm eval` → `scripts/live-e2e-proof.ts` → one real Telegram
  round-trip against prod (gateway → kernel → tool → reply → `action_log`
  row, read back from Postgres) → `pnpm proof:scoreboard` → `pnpm proof:costs`.
- Actual spend is read from the `ai_call_costs` delta on the VPS
  (`select sum(cost_usd) where created_at > <run-start>`), not estimated.
  Historical heaviest day (2026-07-13) was $0.15, so €0.50 is not expected to
  bind — if it does, stop and report, don't extend it.

## Testing

- `pnpm gate` green locally before push (evidence, not assumption).
- CI green on the pushed branch (both jobs, not just one).
- `git log -1` SHA match between `origin/main` and the VPS.
- `docs/PROOF.md` / `docs/COSTS.md` regenerated with a fresh timestamp and
  the current test count (currently 2797, not the stale 1213 in the existing
  file).

## Open questions (state, don't guess)

- Retiring `beta` as the required promotion path contradicts
  `CONTRIBUTING.md:69` ("cut branches from beta"). CLAUDE.md already says
  Claude may merge to `main` directly. Flagging the doc conflict; resolving
  it is part of Spec B2 (rulebook consolidation), not this spec.
