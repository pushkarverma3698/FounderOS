# AG-036 — The live judge scores whether FounderOS understood the ask

**Source:** [docs/plans/2026-10-07-understanding-plan.md](../plans/2026-10-07-understanding-plan.md) task 7.
**Depends on:** AG-030 merged (calibration cases).
**Branch:** `task/issue-<N>-judge-understanding`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Lite: an observer only; it never changes a reply.
**Moves:** A. Needs the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) before writing code.

## Goal

When FounderOS misreads a follow-up, an alert fires the same day. Today the judge scores it 95.

## Problem / observed behavior

- `src/infra/judge.ts` (395 lines) scores groundedness, relevance and completeness against this turn's planned goal and
  step results (`AnswerJudgeInput`, line 232).
- The judge never sees the founder's earlier turns. A reply that answers the wrong PR is grounded and relevant to the wrong
  goal, so it passes. Over 108 turns in 14 days the average was groundedness 95 / relevance 98. #361, #382, #411 and #525
  all passed.
- `JUDGE_MODEL=google-genai:gemini-3.1-flash-lite` (prod `.env`), weaker than the model it judges.

## Expected behavior

1. `AnswerJudgeInput` gains `priorTurns`: the last 3 founder messages and reply excerpts, from the same history the planner
   saw, each capped at 300 chars.
2. A fourth score, `understood` (0–100): "Given the earlier turns, did the reply act on what the founder meant: the right
   entity, the right task, nothing re-run that was already done?" It is stored with the other scores.
3. `judge-alert.ts` alerts when `understood < 60` on any DM turn, with the turnId, the founder message and the reply excerpt.
   The alert goes to the founder DM, at most 3 a day; further ones are batched into a daily line.
4. **Calibration in the PR body:** run the judge over the AG-030 cases (the failing prod replies as fixtures) and over 10 OK
   turns. Report how many failures it flags and how many false alarms it raises. If the flash-lite judge flags fewer than
   8 of the 14 failures, report the same run with the AGENT_MODEL as judge and recommend one.

## Files or subsystem in scope

`src/infra/judge.ts` (split out a module; 395 lines), `src/infra/judge-alert.ts`, the call site that builds the judge
input, tests.

## Constraints

- The judge stays off the reply path (fire-and-forget). A judge failure never delays or changes a reply.
- Alert text names the turn and what to look at. No raw personal data beyond the founder's own message.

## Explicitly forbidden

- Using `understood` to rewrite or block replies.
- Switching `JUDGE_MODEL` in prod in this PR (founder decision).

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/infra
```

## Acceptance criteria

- Unit tests: prompt includes prior turns, parse of the new score, alert threshold and daily cap.
- Calibration table in the PR body (paid: one judge call per fixture, about 24 calls).
- NOT VERIFIED: the alert's first real firing, which needs a real misread turn after deploy.
