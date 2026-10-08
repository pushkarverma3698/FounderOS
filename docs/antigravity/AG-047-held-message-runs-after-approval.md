# AG-047 — A message sent while a card waits runs after the card, not "send it again"

**Source:** [docs/plans/2026-10-08-root-fix-task-list.md](../plans/2026-10-08-root-fix-task-list.md) task 3.
**Depends on:** nothing.
**Branch:** `task/issue-<N>-held-message-runs`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: HITL ordering and the per-chat turn lock.
**Moves:** A. Needs the founder's yes on the root-fix list and the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) and `~/.claude/skills/production-ready/SKILL.md` before writing code.

## Goal

The founder never has to retype a question. A message that arrives while an approval card is waiting is answered right
after he taps Approve or Reject.

## Problem / observed behavior

- `src/gateway/turn-gates.ts:35-50` (`holdForPendingApproval`) replies "⏸ Not started: an approval is still waiting…
  then send your message again" and drops the text.
- Prod 10-07: "Where are we stuck and failing?" arrived at 21:38:48.746 (turn `c30ffa58`, `turn.ack` and no `turn.out`).
  He approved the issue card at 21:38:51.933 (`hitl.resume`, turn `83756e9d`). The question was never answered.

## Expected behavior

1. `holdForPendingApproval` stores the held text: one per chat, newest wins. It goes in a DB row next to the pending
   interrupt so a deploy restart does not lose it. Reply: "⏸ Holding this until you answer the card above."
2. When the interrupt resolves (approved, rejected or expired) and the resume turn has replied, the gateway runs the held
   text as a normal turn through `runKernelText`, then clears the row.
3. A held message older than `HITL_RESTORE_MAX_AGE_MS` is dropped with one line saying which message was dropped and why.

## Constraints

- The resume turn finishes first. The held turn takes the chat lock after it (`withChatTurnLock`), never alongside it.
- No change to what the card does or to `hitlGate()`.

## Explicitly forbidden

- Running the held message before the card resolves.
- Treating the held text as an answer to the card.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/gateway tests/unit/kernel/kernel-e2e.test.ts
```

## Acceptance criteria

- Failing test first: pending interrupt → text arrives → approve. The held text produces a `turn.out` after the resume's
  `turn.out`. It fails on `beta` today.
- A restart between hold and approve still runs the held text.
- Real path (`scripts/telegram-probe.ts`): ask for something that raises a card, send "what time is it in Amsterdam?",
  approve. The answer arrives without resending.
