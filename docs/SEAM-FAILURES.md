# FounderOS — Seam Failures Log

A seam is a boundary the gateway run-loop crosses (`turn.in`, `route.decided`,
`tool.call/result/error`, `hitl.*`, `halt.blocked`, `wedge.recovered`, `turn.out`).
The most damaging bugs this project hit all **passed the unit/eval suite while
failing in production**, because the suite exercised the office invoker directly and
never touched the real Telegram gateway run-loop (CLAUDE.md rule #19).

This file records each seam-level failure with its **signature → evidence → fix →
prevention**, so the class of bug can never silently return. Add a new entry every
time a bug is traced to a seam.

---

## SF-1 · False "⚠️ Tool issue" leak on a *successful* tool result

- **Seam:** `tool.result` → `turn.out`
- **Signature:** a successful tool result whose first line happened to contain a
  keyword like "error"/"failed" was classified as a failure; the founder saw a
  spurious "⚠️ Tool issue" banner on a reply that actually worked.
- **Evidence:** live founder-sim QA (2026-06-12), reply text vs. `action_log` row
  showed success while the banner claimed failure.
- **Fix:** `isToolFailure()` now requires a structured failure flag OR a first-line
  keyword (not a substring anywhere) — `src/gateway/office-run.ts`
  (`isToolFailure`/`collectToolErrors`). PR #52.
- **Prevention:** pure predicate with unit tests; never infer failure from a free-text
  substring.

## SF-2 · Prompt-injection / introspection leaking tool names

- **Seam:** `route.decided` (supervisor)
- **Signature:** a crafted message could coax the supervisor into revealing internal
  tool names / routing internals.
- **Evidence:** adversarial battery in the live QA suite.
- **Fix:** CONFIDENTIALITY block added to the supervisor prompt — it declines
  introspection and injection. `src/agents/system-prompts.ts`. PR #52.
- **Prevention:** adversarial tasks are part of the e2e founder-sim suite
  (`scripts/e2e-telegram-qa.ts`).

## SF-3 · Wedged-thread infinite loop

- **Seam:** `turn.in` resuming a half-executed node
- **Signature:** a run aborted mid-graph (recursion/budget/crash) left the thread
  parked on a pending node with **0 interrupts**; every later message *resumed* the
  stuck node → looped to the recursion limit. Founder got nothing; only `/reset` fixed it.
- **Evidence:** `scripts/probe-real-task.ts` — a fresh thread always worked, the live
  thread looped.
- **Fix:** `isWedgedState` predicate + `recoverWedgedThread` guard clears the bad
  checkpoint before a fresh invoke. `src/infra/wedge.ts`, `src/gateway/office-run.ts`.
- **Prevention:** wedge guard runs at the top of every `runOfficeText`; regression
  tests in `tests/unit/`.

## SF-4 · Duplicate bot instance (EADDRINUSE / 409)

- **Seam:** process boot (pre-`turn.in`)
- **Signature:** a slow-draining old process held the health port → the new instance
  died on `EADDRINUSE` (uncaught) → stale code survived and Telegram threw `409`
  (two long-polls).
- **Evidence:** A→B restart repro; `409` in the log.
- **Fix:** `waitForProcessExit` (SIGKILL on timeout) + health-port bind made
  non-fatal. `src/infra/single-instance.ts`, `src/infra/health.ts`.
- **Prevention:** single-instance lock is mandatory at boot; restart is now safe.

## SF-5 · Stale reply (turn-boundary slicing)

- **Seam:** `turn.out`
- **Signature:** `finalReply`/`collectToolErrors` scanned the **whole** thread, so a
  reply could surface a previous turn's output or tool error.
- **Evidence:** multi-turn probe showed prior-turn content bleeding into a new reply.
- **Fix:** capture `baseLen` before invoke and slice to this turn's messages only
  (`sliceFreshMessages`). `src/gateway/office-run.ts`.
- **Prevention:** every reply is built from the post-`baseLen` slice; unit-tested.

## SF-6 · HITL reject-loop

- **Seam:** `hitl.resume` (decision = rejected)
- **Signature:** rejecting an approval card looped — the ReAct sub-agent treated the
  rejection tool-result as feedback and re-drafted forever, firing `interrupt()` again.
- **Evidence:** live MTProto repro 2026-06-12.
- **Fix:** the reject path clears the thread and confirms; it **never** resumes into
  the agent (`buildRejectionConfirmation` + early return in `resumeOffice`).
  `src/gateway/office-run.ts`.
- **Prevention:** 4 regression tests; reject is deterministic, side-effect-free.

---

## How to add an entry

When you trace a bug to a seam: capture the `turnId`, paste the seam line(s) from the
log as evidence, fix at the **seam level** (a pure predicate/guard with a unit test),
then record it here as `SF-N`. A green suite is necessary, not sufficient — verify the
fix on the real gateway path before closing it out.
