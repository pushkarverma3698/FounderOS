# AG-055 — An "in flight" block the model reads every turn

**Source:** [docs/plans/2026-10-08-simplify-founderos.md](../plans/2026-10-08-simplify-founderos.md) task AG-055.
Supersedes AG-032 (draft #1006; close it once this merges).
**Depends on:** nothing.
**Branch:** `task/issue-<N>-in-flight-block`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Lite: read-only context, no writes.
**Moves:** A.

Read [STANDARDS.md](STANDARDS.md) before writing code.

## Goal

The model knows what is already happening before it answers: open coding jobs, approval cards waiting, reminders due
today, and the PRs it talked about last. "Is the agent working on it?" and "that PR" then resolve without a tool hunt.

## Problem (measured)

- On 10-08 the bot said "the spec is being drafted" after the spec stage had died on the Claude weekly limit. Nothing
  in its context said the job had failed.
- Follow-ups such as "the oldest one" and "is it done?" lose their referent, because each turn starts from history
  text cut to 2,000 and 1,500 characters.
- `src/kernel/screen.ts` and `src/kernel/recent-activity.ts` already read parts of this. Reuse them; do not add a
  third reader.

## Expected behavior

1. **`buildInFlight(tenantId, now)`**, a pure formatter over one DB read per source. It returns at most 25 lines, each
   with its source id:
   - Coding jobs not in a final state: the job row id, issue or PR number, engine, stage, and its last error if any.
   - Approval cards still pending, from the HITL table.
   - Reminders due in the next 24 h.
   - The last 5 PR or issue numbers mentioned in the last 20 turns, with repo.
   - Each Google account's login state (ok, or expired since <date>).
2. Both paths read it. The current planner gets it as one extra context section. AG-054's loop puts it after the turn
   history.
3. Each line comes from a row. The block holds no generated text and no guesses.

## Files in scope

`src/kernel/in-flight.ts` (new, or extend `screen.ts` if that keeps it under 400 lines), `src/kernel/planner.ts`
(context section only), `src/db/queries/`, tests in `tests/unit/kernel/`.

## Constraints

- One query per source, a 300 ms total budget, and on timeout the block says `in-flight: unavailable`. Never stall a
  turn.
- No secrets or tokens in the block. Accounts show the address domain only.

## Explicitly forbidden

- Prompt rules telling the model how to use the block. The block is data.
- Writing to any table.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/kernel
```

## Acceptance criteria

- A failing test first: given a failed spec job row, the block shows `failed: claude weekly limit` (or the row's real
  error), and the planner's context contains it.
- After deploy, in Telegram: dispatch a job, then ask "is the agent working on it?". The reply matches the job row's
  stage. Paste the reply and the row.
