# AG-034 — No progress claim without a status check, no number without a source

**Source:** [docs/plans/2026-10-07-understanding-plan.md](../plans/2026-10-07-understanding-plan.md) task 5.
**Depends on:** nothing.
**Branch:** `task/issue-<N>-unbacked-claims-guard`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Lite: pure checks on the outbound reply, with a deterministic fallback.
**Moves:** A. Needs the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) before writing code.

## Goal

FounderOS never describes an agent's progress it did not check this turn, and never states a statistic that no tool
returned.

## What already exists (do not rebuild)

`src/kernel/promise-guard.ts` (81 lines) strips "I'll monitor / keep you posted" promises unless a `schedule_task` or
`set_reminder` receipt succeeded. It is called from `planner.ts:38` and `synthesizer.ts:24`. It covers turn #441. Follow its
pattern: a pure function over the reply text and `StepResult[]`, sentence-level removal, and a fixed notice when nothing is
left.

## Problem / observed behavior

- 09-16 #396: "Antigravity is actively executing in its isolated workspace". No status tool ran; #400 showed the task had
  not started.
- 09-06 #297 "95% of candidates" and 10-04 #522 "11 automated commits in 72 hours": no step result contains either number.
- The live judge passed all three (groundedness ≥ 90).

## Expected behavior

1. **Progress guard.** Create `src/kernel/progress-guard.ts`, a sibling of the promise guard. A present-progress phrase
   about an external agent or task ("is working on", "actively executing", "in progress", "has started", "is building";
   a tested constant list) needs a successful receipt this turn from a status tool: `antigravity_task_status`,
   `github_read` with `get_pr`/`list_prs`, or `read_logs`. Grep agent-tools for any other status tool. Without one, the
   sentence is replaced by `I haven't checked its status this turn. Ask "status of <task>" and I'll look.`
2. **Number check.** `src/kernel/number-check.ts` flags a percentage, or a count above 10, that appears neither in any step
   result's serialized output nor in the founder's message.
   - **Log only** for one week: `claim_check.number` with turnId and the number. Enforcement is a later decision made on
     that data.
3. Both run where `stripFalsePromises` runs in `synthesizer.ts`. One trace line per turn,
   `seam: "claim.check"`, with counts per kind (promise/progress/number), so the plan's metrics can be read from the journal.

## Files or subsystem in scope

New `src/kernel/progress-guard.ts`, `src/kernel/number-check.ts`; `src/kernel/synthesizer.ts` (187 lines; one call
site); tests. `planner.ts` is 399 lines: add nothing to it in this task.

## Constraints

- Pure and deterministic: no LLM call. One unit test per phrase in each list.
- Lines without a match come back byte for byte (same promise as `stripFalsePromises`).

## Explicitly forbidden

- Blocking the whole reply.
- Enforcing the number rule in this PR.
- Changing `promise-guard.ts` behaviour.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/kernel
```

## Acceptance criteria

- Unit tests use the prod replies above as fixtures (turn ids in test names), plus negatives:
  - a progress sentence with an `antigravity_task_status` receipt passes;
  - a number present in a step result passes;
  - a number the founder typed passes.
- AG-030 cases #396, #297 and #522 pass on the next live eval, or are listed as NOT VERIFIED if it is not run.
- Real path: in Telegram ask "is Antigravity working on issue <n>?". The reply cites a status receipt, or says it has not
  checked. Trace line in the PR body.
