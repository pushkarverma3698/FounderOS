# Turn progress streaming to Telegram

**Date:** 2026-07-12
**Branch:** `feat/turn-progress-streaming` (off `beta`)
**Status:** Approved, pending implementation

## Problem

`runKernelText` and `resumeKernel` (`src/gateway/kernel-run.ts`) call
`kernel.invoke(...)` and wait for the entire turn to finish before sending
anything to Telegram. A multi-step plan (e.g. research → draft → HITL gate)
can run silently for 10–60s with no signal the bot is alive. The founder
sees nothing until the final reply, the HITL card, or the timeout error.

This is the one item from the 2026-07-11 Cursor limitations research that
is genuinely self-imposed (no `stream`/`streamEvents`/`astream` anywhere in
`src/`) and has a low-risk, high-value fix — unlike the rest of that
research, it does not require any architecture change.

## Goal

Show step-level progress on the SAME Telegram message (edited in place, no
chat spam) while a turn runs, for both fresh turns and HITL resumes. Zero
change to the final reply, approval card, or error paths.

## Non-goals

- Token-level streaming (Telegram is not well suited to it; batch replies
  are the platform-native pattern per the research's own analysis).
- Parallel step execution, `Send` API, or any change to `graph.ts` /
  `state.ts` / `supervisor.ts`.
- Progress inside a single step (tool-call-level detail) — one message per
  PLAN STEP only, not per tool call. The supervisor's `dispatch` node
  already advances `mission.cursor` exactly once per step; that's the only
  transition worth surfacing.
- Streaming to the JARVIS web UI (out of scope; Telegram only).

## Design

### Data flow

1. LangGraph's default `stream()` mode ("values") yields the FULL graph
   state after every node runs. The last yielded chunk is identical to what
   `invoke()` returns today — so replacing `invoke` with a loop over
   `stream` that keeps the last chunk is a behavior-preserving swap for the
   existing reply/approval/error logic.
2. Before starting the stream, send one placeholder message:
   `🤔 Working on it…`
3. On each yielded state, compute `progressLabelFor(state)`:
   - `mission.status === "executing"` → look up
     `mission.plan.steps[mission.cursor]`, return
     `"🔧 {worker}: {objective, truncated to 60 chars}"`
   - `mission.status === "synthesizing"` → `"✍️ Writing your reply…"`
   - anything else (planning, failed, done) → `null` (no update)
4. If the label is non-null and differs from the last one sent, call
   `ctx.api.editMessageText(chatId, placeholderId, label)` — **plain text,
   no `parse_mode`** (avoids HTML-escaping model-authored objective text;
   this is display-only progress, not the founder-facing reply).
5. When the stream loop ends (normal completion, HITL pause detected after
   the loop, or a thrown error), delete the placeholder message
   best-effort, THEN run the existing unchanged code: approval-card check →
   `sendReply` / `sendApprovalCard` / `replyForError`.
6. The whole operation (placeholder send + stream loop + final handling)
   stays wrapped in the existing `withTurnTimeout`, same deadline, same
   "orphaned background work is acceptable" semantics as today.

### New code

- `progressLabelFor(state: KernelStateType): string | null` — pure
  function, exported from `kernel-run.ts` for direct unit testing. No I/O.
- A small helper that owns the placeholder lifecycle (send → edit-on-change
  → delete), used by both `runKernelText` and `resumeKernel`. Lives in
  `kernel-run.ts` (file stays well under the 400-LOC budget) — not a new
  module, since it has no reason to exist outside this file's two call
  sites.
- One new `Seam` literal in `src/infra/trace.ts`: `"turn.progress"`, logged
  each time the placeholder text changes (same pattern as the existing
  `hitl.interrupt` / `turn.out` events — keeps journalctl diagnosable for
  this new behavior, per repo rule #19).

### Failure handling

Every Telegram call for the placeholder (send/edit/delete) is wrapped in
try/catch, logged at `warn`, and never thrown — a progress ping failing
must not fail the turn. Tagged `// allow-failopen: progress ping is
cosmetic; the turn must not die on a Telegram blip` per the architecture
gate's fail-open-catch convention.

### Testing (TDD, per repo process)

1. `progressLabelFor` — pure unit tests covering: executing → step label
   with truncation, synthesizing → writing label, planning/failed/done →
   null, missing/out-of-range cursor → null (defensive, mirrors
   `dispatch`'s own bounds check).
2. `tests/unit/gateway/kernel-run.test.ts` — replace `fakeKernel.invoke`
   with a `fakeKernel.stream` async generator. Existing tests updated to a
   single-yield generator (preserves current behavior/assertions
   unchanged). New tests: multi-yield generator asserts the placeholder is
   edited with the expected sequence of labels and deleted before the final
   reply/approval-card/error is sent.
3. Full suite + `tsc --noEmit` + `verify:arch` must stay green — this
   change touches only `src/gateway/` and one `Seam` literal, so
   `kernel-purity`/`gateway-imports` gates are structurally unaffected.

### Out of scope for this change (explicitly deferred)

- Editing message formatting (HTML/markdown) for progress text — plain
  text keeps this simple and safe; revisit only if the founder asks for
  richer progress cards.
- Rate-limiting edits beyond natural step-boundary throttling (Telegram's
  edit rate limits are per-second; plan steps are seconds-to-minutes apart,
  so no additional debouncing is needed).

## Success criteria

- A multi-step plan run through the live Telegram bot shows the placeholder
  message's text change at least twice (e.g. `research: ...` →
  `writing your reply…`) before the final reply arrives.
- No regression in `tests/unit/gateway/kernel-run.test.ts` behavior for the
  existing three `runKernelText` cases and two `resumeKernel` cases.
- Full suite, `tsc --noEmit`, and `pnpm verify:arch` all green.
- Live-verified on the real Telegram bot (per repo rule #19), not just unit
  tests — screenshot or transcript of the edited progress message in the
  PR description.
