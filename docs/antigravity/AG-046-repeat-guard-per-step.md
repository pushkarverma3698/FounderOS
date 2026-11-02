# AG-046 — Repeat guards count calls inside one step, not across turns

**Source:** [docs/plans/2026-10-08-root-fix-task-list.md](../plans/2026-10-08-root-fix-task-list.md) task 2.
**Depends on:** nothing.
**Branch:** `task/issue-<N>-repeat-guard-per-step`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Lite.
**Moves:** A. Needs the founder's yes on the root-fix list and the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) before writing code.

## Goal

When the founder asks the same question twice in a minute, the second turn reads the data again and answers. Today it is
told the data is "in the conversation above", which isn't true, and it gives up.

## Problem / observed behavior

- `src/agents/agent-tools/engineering.ts:160` and `diagnostics.ts:32` build guards with `makeThreadScopedRegistry`.
  `repeat-guard.ts:55-56` blocks the fourth identical call inside 90 s for the whole Telegram thread.
- The header comment (`repeat-guard.ts:14-17`) assumes "the time window self-scopes to a turn". It doesn't: three asks at
  21:34, 21:35 and 21:36 on 10-07 fell inside one window.
- The block message (`engineering.ts:178` onward) says the result "is in the conversation above". A new turn's worker has
  an isolated envelope and has never seen it.

## Expected behavior

1. Key the registry by the step: turn id plus `step_id` of the envelope the worker runs, read from the tool's
   `config.configurable` (add them there in the worker if they are missing).
2. Keep the 3-repeat limit inside one step. Drop the time window.
3. Release a step's guard when the step ends, so the map does not grow without bound.

## Explicitly forbidden

- Raising the repeat limit as the fix.
- Removing the guard: inside one step it still stops a model that loops.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/agents
```

## Acceptance criteria

- Failing test first: two different turn ids on one thread, each calling `github_read` with the same arguments 3 times
  within 90 s. None of the 6 calls is blocked. It fails on `beta` today.
- One step calling it 4 times: the 4th is blocked.
- Real path: in Telegram ask "list my open PRs" four times within two minutes. All four replies list the PRs.
