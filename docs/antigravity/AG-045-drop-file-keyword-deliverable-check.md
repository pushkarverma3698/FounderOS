# AG-045 — A file deliverable is a typed plan field, not the word "file"

**Source:** [docs/plans/2026-10-08-root-fix-task-list.md](../plans/2026-10-08-root-fix-task-list.md) task 1.
**Depends on:** nothing.
**Branch:** `task/issue-<N>-typed-deliverable`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Lite. Escalate to Full if the change reaches HITL or receipts.
**Moves:** A. Needs the founder's yes on the root-fix list and the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) before writing code.

## Goal

"What does the plan state?" gets a summary of the plan. Today it gets a failure because the step objective contains the
word "file".

## Problem / observed behavior

- `src/kernel/verify.ts:19`: `FILE_DELIVERY_KEYWORDS = /\b(csv|spreadsheet|export|file|attachment|download)\b/i`.
- `verify.ts:49` runs it on `envelope.objective` for admin (`:126`) and jobhunt (`:142`). Any objective like "Read the
  contents of the file docs/plans/…" fails with "Objective requested a file deliverable (CSV/export/spreadsheet)".
- Prod 10-07 21:34–21:36: the plan was read (266 lines) three times and no summary reached the founder. On 21:25 the same
  check added a false "Delivery requested" notice to a list of PRs.
- No typed field exists. `EXPECTED_KINDS` (`src/kernel/envelope-repair.ts:6`) is `data | draft | action_receipt`.

## Expected behavior

1. Add `deliverable: z.enum(["none", "file"]).default("none")` to `TaskEnvelopeSchema` (`contracts.ts`, 391 lines: keep
   it within the 400-line limit by putting helpers elsewhere).
2. The planner prompt tells the model to set `deliverable: "file"` only when the founder asks for a file sent to him
   (CSV, export, attachment).
3. `verifyDeliverableIfRequested` checks `envelope.deliverable === "file"` and nothing else. Delete
   `FILE_DELIVERY_KEYWORDS`.
4. The receipts logic (`deliver_artifact` / `write_artifact`) stays exactly as it is.

## Constraints

- Fix the schema, not the code (repo rule): no new regex.
- Existing jobhunt CSV golden cases must still require `deliver_artifact`.

## Explicitly forbidden

- Narrowing the regex instead of removing it.
- Touching the receipt checks.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/kernel
```

## Acceptance criteria

- Failing test first: an admin envelope with the objective "Read the contents of the file docs/plans/x.md and summarise it"
  and `deliverable` omitted passes verification with no artifact receipt. It fails on `beta` today.
- A jobhunt envelope with `deliverable: "file"` and no `deliver_artifact` receipt still fails with `NOT_DELIVERED_ERROR`.
- Real path: in Telegram ask "what does docs/plans/2026-10-07-understanding-plan.md state?". The reply summarises it, and
  the trace shows no `verify` failure.
