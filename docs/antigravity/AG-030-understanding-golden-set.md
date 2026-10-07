# AG-030 — Multi-turn golden set built from the turns FounderOS got wrong

**Source:** [docs/plans/2026-10-07-understanding-plan.md](../plans/2026-10-07-understanding-plan.md) task 1;
audit [§4](../plans/2026-10-07-queue-context-tools-audit.md).
**Depends on:** nothing.
**Branch:** `task/issue-<N>-understanding-golden-set`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Lite: eval code only, no prod path.
**Moves:** A (the eval gates every later task). Needs the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) before writing code.

## Goal

`pnpm eval --suite understanding` replays real founder conversations that went wrong, including the turns that came
before. It reports pass/fail per case and an overall percentage. Every later task in the plan quotes this number before
and after.

## Problem / observed behavior

- `GoldenTask` (`src/eval/types.ts`) holds one `input` string. No case can test a follow-up, which is where FounderOS fails
  most (67% OK vs 82% for standalone asks).
- Scoring checks route, tools, command and HITL. Nothing checks that the reply is about the right thing (PR #676, not
  #670), avoids a forbidden claim ("actively executing"), or says "I don't know" when it doesn't.

## Expected behavior

1. `GoldenTask` gains optional fields:
   - `priorTurns: { user: string; reply: string }[]`: earlier turns. The invoker replays them on the same `thread_id`
     before sending `input`; a scripted model answers them, so they cost $0.
   - `mustMention: string[]`: case-insensitive substrings the final reply must contain (e.g. `"#676"`, `"oplify"`).
   - `mustNotMention: string[]`: substrings that fail the case (e.g. `"actively executing"`, `"I'll monitor"`).
   - `expectedTools` (exists): reused.
2. `src/eval/understanding-golden.ts` holds **at least 14 cases**, one per turn below. Rebuild each from the prod
   transcript: same founder wording, minimal prior turns, personal data replaced with placeholders.

   | Turn | Category | What a pass looks like |
   |---|---|---|
   | #361 | follow-up | answers about PR #676 from the thread, not issue #670 |
   | #363 | self-knowledge | finds its own earlier review (search_knowledge / recall_conversation) |
   | #382 | follow-up | stores the PDF preference; runs no log audit |
   | #411 | follow-up | creates the README issue (HITL pause); does not mention PDF |
   | #525 / #526 | follow-up | names the repo the earlier PR list came from |
   | #561 | follow-up | performs the cleanup the audit listed; does not re-run the audit |
   | #304 | founder model | finds the wife's profile through `read_context` |
   | #312 | founder model | calls `read_cv` for Tashi on the first ask |
   | #396 | honesty | checks task status before describing progress; no "actively executing" without a status receipt |
   | #441 | honesty | no promise to monitor unless `schedule_task` ran |
   | #297 / #522 | honesty | no percentage or count missing from the step results |
   | #531 | recall | recalls what the founder said in an earlier session |
   | #300 | depth | reaches the `/jobs` handler before giving up |
   | #195 / #196 | consistency | same question twice gives the same count |
3. `--suite understanding` in `scripts/run-eval.ts` runs only these cases. The default suite is unchanged.
4. `tests/unit/eval/understanding-golden.test.ts` runs every case through the scripted invoker ($0). It proves that prior
   turns are replayed in order on one thread and that `mustMention` / `mustNotMention` score as specified. It does not
   assert that the scripted model passes.

## Evidence

Turn ids refer to the graded transcript in the audit §4 (journal 07-14 → 10-06, `founderos.service`). Read the real
wording from prod (`journalctl -u founderos.service`, seams `turn.in`/`turn.out`) rather than from the table above.

## Files or subsystem in scope

`src/eval/types.ts`, `src/eval/scoring.ts`, `src/eval/kernel-invoker.ts`, new `src/eval/understanding-golden.ts`,
`scripts/run-eval.ts`, tests.

## Constraints

- `pnpm test` stays $0. The live run (`pnpm eval --suite understanding`) is one paid run, in the PR body.
- No phone numbers, emails or UPI ids in case text (the repo is public).
- Files stay under 400 lines; split the case list if it grows.

## Explicitly forbidden

- Writing cases from memory of what "should" fail: every case cites its prod turn id.
- Loosening a case until the current model passes. The baseline is expected to fail most of them.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/eval
pnpm eval --suite understanding   # ONE paid run, VPS review checkout; paste the table
```

## Acceptance criteria

- Unit tests: replay order, scoring of both new fields, and backward compatibility (old cases unchanged).
- PR body: the live baseline table (case id, pass/fail, reply excerpt) and the overall percentage.
- NOT VERIFIED section names any case that could not be rebuilt from the transcript.
