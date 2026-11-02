# AG-057 — Delete the old turn path

**Source:** [docs/plans/2026-10-08-simplify-founderos.md](../plans/2026-10-08-simplify-founderos.md) task AG-057.
**Depends on:** AG-054 running with `LOOP_MODE=on` for 2 days, with the morning journeys green on both days.
**Branch:** `task/issue-<N>-delete-old-turn-path`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: the turn path, CI fitness rules.
**Moves:** A.

Read [STANDARDS.md](STANDARDS.md) and `~/.claude/skills/production-ready/SKILL.md` before writing code.

## Goal

Only one turn path exists. Code that no turn runs any more is gone, and CI stops it from coming back.

## Problem

After AG-054 switches on, the planner, supervisor, worker envelopes, synthesizer, departments and 7 of the 8 guard
modules no longer run on any turn. They still cost reading time, test time and drift: every rule in
`docs/rules/` refers to them.

## Expected behavior

1. **Prove nothing runs them.** Grep for every import, and check 2 days of prod traces: no `plan`, `dispatch` or
   `synthesize` spans after the switch. Paste both in the PR.
2. **Delete:**
   - `src/kernel/` planner, supervisor, worker, synthesizer and graph.
   - The kernel's contracts that only these used.
   - The guards: envelope-repair, output-coercion, mission-satisfaction, promise-guard, number-check, progress-guard
     and tool-output-guard.
   - `DEPARTMENT_TOOLS` and the sub-role maps in `capabilities.ts`.
   - `LOOP_MODE`, together with its `off` and `shadow` branches.
3. **Keep:** `claim-check.ts`, `src/infra/hitl.ts`, receipts, budget, the checkpointer (paused approvals only),
   `screen.ts`/`recent-activity.ts`/in-flight if AG-054 uses them.
4. **Tombstones.** Each deleted module is added to the tombstone list in `scripts/verify-architecture.ts`, so CI fails
   if it is re-created. Lower the debt numbers in `governance/architecture-baseline.json`.
5. **Tests.** Delete tests of deleted code. Port `tests/unit/kernel/kernel-e2e.test.ts`'s HITL and receipt cases to
   the loop's e2e if they are not already there.
6. **Line count.** Measure `src/kernel` + `src/agents` + `src/gateway` before and after, and paste both numbers. The
   plan's exit target is under 12,000, down from 25,187.

## Files in scope

`src/kernel/`, `src/agents/capabilities.ts`, `src/agents/` worker prompts, `src/gateway/kernel-run.ts`,
`src/gateway/kernel-boot.ts`, `src/eval/` (point it at the loop), `scripts/verify-architecture.ts`,
`governance/architecture-baseline.json`, and the tests.

## Constraints

- One PR per deletion group if the diff passes 3,000 lines, merged in order: guards, then departments, then the
  planner/supervisor/synthesizer.
- The golden set and the journeys run after each group.

## Explicitly forbidden

- Deleting HITL, receipts, claim-check, budget caps or the checkpointer.
- Rewriting any tool implementation.

## Verification commands

```bash
pnpm gate
pnpm vitest run
pnpm eval   # paid, once after the last group
```

## Acceptance criteria

- `pnpm gate` is green, and the tombstone test fails when a deleted file is re-created (show it).
- The `pnpm eval` score is no lower than AG-054's loop score.
- The morning journeys after deploy are as green as the day before.
