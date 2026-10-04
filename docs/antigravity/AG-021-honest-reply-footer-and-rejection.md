# AG-021 — Replies: no ✓ under a failure, and a rejected card says "Dropped"

**Plan:** [2026-10-04 Telegram UX audit](../plans/2026-10-04-telegram-ux-audit.md), tasks P0-3 and P0-4.
**Branch:** `task/issue-<N>-honest-reply-footer`, cut from a fresh `origin/beta`. PR base: `beta`.
**Moves:** A. These paths are not frozen.
**Status:** draft, not dispatched.

**Read [STANDARDS.md](STANDARDS.md) in full before writing any code. It is binding.**

---

## Goal

The founder can trust the tick. "✓ … verified" appears only when a side-effecting action really
succeeded, and choosing ❌ on an approval card reads as his own choice, not as a crash.

## Problem (observed in prod, 2026-09-29 → 10-03)

1. **A green tick under a red outcome.** In 7 days, a reply ended with "✓ 1 action completed and
   verified" on 5 failed missions. Examples:
   - "The dispatch failed because the required repository paths were not found… ✓ 1 action
     completed and verified"
   - "The mission was not completed… ✓ 1 action completed and verified"

   `founderReceiptsBlock` (`src/kernel/synthesizer.ts:113`) counts every `ok` receipt, including
   read-only ones (`github_read`, `antigravity_task_status`). The call site is `synthesizer.ts:185`.
   The same footer appears on plain research answers, where it means nothing.
2. **A rejection looks like a failure.** Tapping ❌ sends
   `⚠️ Task stopped at step "s1" — hitl_rejected failure in engineering`, plus two more lines
   (`src/kernel/supervisor.ts:73`, sent through `src/gateway/failure-card.ts`). This happened 6
   times in 7 days. Every time, the founder had chosen it.

## Expected behaviour

1. The footer counts only receipts from **side-effecting** tools, the gated set in
   `HITL_GATED_TOOLS` or its equivalent. Measure which list is authoritative before choosing.
   It prints nothing when that count is 0. It also prints nothing when any step in the mission
   failed.
2. When `failure.stage === "hitl_rejected"`, the founder sees exactly
   `👍 Dropped. Nothing was sent.`. There is no ⚠️, no step id and no component. The kernel's
   stored reply (`formatFailureReply`) stays unchanged, because the planner reads it as history
   (see the header comment in `failure-card.ts`).

## Measured starting state — check before you begin

- Run `grep -rn "founderReceiptsBlock(" src` and expect 1 call site outside the definition.
- Find which tool-name list is the gated set: `grep -rn "HITL_GATED_TOOLS" src`. CLAUDE.md says it
  is "a rendering declaration, not a gate". Confirm it lists every tool that calls `hitlGate()`
  (`grep -rln "hitlGate(" src/agents/agent-tools`). If the two disagree, report the difference
  instead of guessing.

## Files in scope

`src/kernel/synthesizer.ts`, `src/gateway/failure-card.ts`, and tests under `tests/unit/kernel/`
and `tests/unit/gateway/`.

## Explicitly forbidden

- Don't change `validateStepResult`, receipt recording or `isFailureResult`. The receipt itself must
  stay honest; this task changes only the founder-facing line.
- Don't change the golden set's expected replies without listing each one in the PR body.

## Verification commands

```bash
pnpm test
pnpm lint && pnpm verify:arch
```

## Acceptance criteria

1. A failing-first unit test: a mission with one ok `github_read` receipt and one failed step
   produces a reply with no `✓`.
2. A unit test: a mission with one ok gated `send_email` receipt still prints
   `✓ 1 action completed and verified`.
3. A unit test: `hitl_rejected` renders exactly `👍 Dropped. Nothing was sent.`.
4. `tests/unit/kernel/kernel-e2e.test.ts` passes unchanged, or the PR explains each diff.
5. Real path, after deploy: send `/task repo:founderos add a line to README`, tap ❌, and read the
   reply over MTProto.
