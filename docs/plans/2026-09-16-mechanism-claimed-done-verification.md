# Mechanism fix — claimed-done verification, extended past formal benchmark runs

**Theme:** 2 — claimed-done / unverified success, 8 independent instances
([docs/plans/2026-09-16-recurring-failure-patterns-and-behavior-audit.md](2026-09-16-recurring-failure-patterns-and-behavior-audit.md))
**Status:** implementation plan, not yet built

## Problem

`pnpm verify:benchmark` + `docs/product-recovery/14-EXECUTOR-RULES.md` already enforce "claims need
a corroborated `turnId`" — and it holds, every time it's actually invoked. The gap is scope: it only
binds a formal benchmark run. PR #676's body typed "pnpm gate green — 4254 tests" against an actual
`2 failed`; the 2026-09-15 self-audit fabricated an entire "Log & Execution Records Audit Summary"
with zero log lines read; issue #687's own acceptance criteria (`pnpm test && pnpm typecheck`) never
asked for evidence a fix actually worked end to end. Three surfaces, same missing discipline,
because the discipline lives in one script that only one of the three surfaces calls.

## Approach

1. **Machine-captured evidence for the gate itself.** `pnpm gate` writes `gate-evidence.json`
   (exit codes per step, test/file counts, commit SHA, timestamp) as a side effect of running. CI
   re-reads this file and fails the PR check if the PR body's typed claim (regex-extracted: "N
   tests", "gate green"/"gate red") doesn't match what's in the file. A human or agent can no longer
   type a green number that didn't come from a real run.
2. **Planner-level rule for ad hoc self-diagnosis.** This part isn't a CI check — it's a prompt
   change. The planner's system prompt (`src/agents/prompts/`) needs an explicit instruction: when
   asked to read logs, audit itself, or report on system state, and the relevant tool
   (`read_logs`, `github_read`, etc.) is unavailable or returns nothing, say so plainly — never
   substitute an adjacent data source (a stale directory listing, a guess) and present the result as
   if it answered the original question. This is CLAUDE.md rule #34's content turned into an
   enforceable prompt instruction, not just a standing rule Claude-the-reviewer holds itself to.
3. **Dispatch brief acceptance criteria.** Extend `.github/ISSUE_TEMPLATE/agent-task.md` so
   "Acceptance criteria" requires at least one criterion phrased as a user-visible or
   system-observable outcome, not only `pnpm test && pnpm typecheck` — ties into
   [[2026-09-16-mechanism-realpath-verification.md]], same underlying gap from a different angle.

## Files likely in scope

- `scripts/gate.ts` or equivalent orchestrator behind `pnpm gate` — write `gate-evidence.json`
- new CI step (`.github/workflows/`) — compare PR body claims against the artifact
- `src/agents/prompts/` — planner instruction for missing-instrument honesty
- `.github/ISSUE_TEMPLATE/agent-task.md` — acceptance-criteria requirement

## Out of scope

- Not attempting to machine-verify prose claims beyond test/gate counts (e.g., can't mechanically
  verify "the fix works" as a sentence) — that's what real-path verification
  ([[2026-09-16-mechanism-realpath-verification.md]]) is for, a separate mechanism.

## Verify

```bash
pnpm gate   # confirm gate-evidence.json is written with real values
```
Then a synthetic PR body with a mismatched claim should fail the new CI check; a matching claim
should pass.

## Next step

Turn into an AG-NNN dispatch brief once prioritized — next available slot AG-020 (or the next free
number after other mechanism briefs are assigned).
