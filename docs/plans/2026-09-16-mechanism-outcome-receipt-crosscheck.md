# Mechanism fix — synthesizer cross-checks outcome-claiming language against real receipts

**Theme:** 9 — pipeline completes, terminal action never fires, 6 independent instances,
self-flagged as recurring in the founder's own history
([docs/plans/2026-09-16-recurring-failure-patterns-and-behavior-audit.md](2026-09-16-recurring-failure-patterns-and-behavior-audit.md))
**Status:** implementation plan, not yet built

## Problem

The kernel's `validateStepResult`/`FailureReport` contract (`src/kernel/contracts.ts`) is designed
so the synthesizer only sees validated tool results — this stops the model from inventing new facts.
It does not stop the model from **narrating** an outcome in natural language ("the submit button was
clicked," "submission packages prepared") when no tool call matching that claim happened in the turn
at all. B13 and B10 are both this exact shape: a confident sentence, zero corresponding receipt.

## Approach

A lightweight cross-check in the synthesizer stage, after the natural-language reply is generated,
before it's sent:

1. Maintain a small, explicit map of outcome-claim keywords → the tool(s) that would produce a
   matching receipt (e.g. "submitted"/"applied" → `submit_application`/`deliver_artifact`;
   "sent"/"emailed" → the relevant send tool; "delivered" → `deliver_artifact`). Scope this to the
   handful of high-stakes action words that have burned this repo before — not a general NLP claim
   detector, which would be unreliable and noisy.
2. If the generated reply contains one of these keywords and the turn's actual `StepResult`/
   `ToolReceipt` list has no matching tool call, do not send the reply as-is: either strip the
   claim and replace it with what's actually known ("attempted; no confirmation recorded"), or
   route the turn to `FailureReport` instead of a normal reply.
3. This is intentionally narrow and keyword-based, not a general solution — false negatives (a claim
   phrased in a way the keyword list misses) are expected and acceptable; the goal is closing the
   specific, repeatedly-observed failure shape, not building a general truthfulness classifier.

## Files likely in scope

- `src/kernel/` synthesizer step (confirm exact file — likely near where `validateStepResult` is
  called, given the existing "Zero-hallucination is a mechanism" design this extends)
- `src/kernel/contracts.ts` — if a new check type is needed alongside `FailureReport`
- `tests/unit/kernel/` — regression tests: a reply claiming "submitted" with no matching receipt is
  caught; a reply claiming it with a real matching receipt passes through unchanged

## Out of scope

- Not building a general hallucination/faithfulness classifier — explicitly scoped to the known
  outcome-word list from this repo's own incident history (submit/apply/send/deliver/confirm), not
  every possible claim a reply could make.
- Not changing `validateStepResult`'s existing behavior for tool-level result validation — this is
  an additional, later check on the synthesized reply text, not a replacement.

## Verify

```bash
pnpm test -- kernel/synthesize   # or wherever the new test file lands
```
Regression test using the exact 2026-08-21 shape (reply claims "submission packages prepared," no
`deliver_artifact`/`submit_application` receipt in the turn) should now be caught.

## Next step

Turn into an AG-NNN dispatch brief once prioritized. This one touches core kernel logic — matches
this repo's "Claude writes code only to fix a defect found in review" posture less than a
straightforward addition would; recommend Antigravity implement against this spec with the kernel's
existing test suite as the primary safety net, and extra scrutiny on the PR review given the blast
radius (every synthesized reply passes through this check).
