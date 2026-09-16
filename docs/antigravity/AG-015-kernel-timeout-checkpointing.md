# AG-015 — Turn timeout no longer shorter than the tools it wraps (B5/B6/B7)

**Milestone:** issue #687 item 2, = **B5** in the morning stability audit (Tier-0, "do before
anything else") — also folds in the two sibling defects from the same incident, B6 and B7.
**Branch:** `task/issue-<N>-kernel-timeout-checkpointing` — cut from fresh `origin/beta`. PR base:
`beta`.
**Status:** ready to dispatch pending founder go-ahead (not yet filed as a GitHub issue)

**Read [STANDARDS.md](STANDARDS.md) in full before writing any code. It is binding.**
**Read [docs/plans/2026-09-16-founderos-stability-audit-and-plan.md](../plans/2026-09-16-founderos-stability-audit-and-plan.md) Part 2, B5–B7 — this brief is that finding turned into an executable spec.**

---

## Why this one is well-grounded (unlike AG-014/017/019)

Unlike the other #687 splits, this bug was root-caused with exact citations by a same-day audit
that read the real journalctl trace, not guessed. Issue #687 named `src/kernel/runner.ts`, which
**does not exist** — the real file is `src/gateway/kernel-run.ts`, confirmed:

```
$ grep -n "OFFICE_TURN_TIMEOUT_MS" src/gateway/kernel-run.ts
13:import { ... OFFICE_TURN_TIMEOUT_MS ... } from "../core/config.js";
198:        OFFICE_TURN_TIMEOUT_MS,
260:        OFFICE_TURN_TIMEOUT_MS,
```

## Goal — three defects, one incident, fix together

1. **B5 — the blanket turn timeout is shorter than a tool it wraps.** `OFFICE_TURN_TIMEOUT_MS` =
   300s wraps every turn (`src/gateway/kernel-run.ts:198,260`). But `claude_code`'s own tool budget
   is 15 minutes (`src/tools/claude-code.ts:68`, `TIMEOUT_MS = 15 * 60_000` — comment: "real coding
   tasks need it; the old 120s killed everything non-trivial"). The 15-minute budget is
   structurally unreachable — the outer 300s guard always fires first. Confirmed fired 2026-08-29
   and 2026-09-15 (both turns died silently, founder got nothing).
2. **B6 — the aborted child process is never actually killed.** `claudeCodeTool.execute()`
   (`src/tools/claude-code.ts:292-321`) accepts no `AbortSignal`. When the outer 300s guard aborts
   the turn, the underlying `claude` CLI child process keeps running — doing real repo/GitHub side
   effects — after the founder was told the turn stopped.
3. **B7 — an orphaned HITL approval row on the timeout path.** The resume path's cleanup
   (`src/gateway/kernel-run.ts:278-281`) runs *after* the awaited call, outside any `finally` block,
   so a timeout skips it. Its own comment promises "no phantom card can ever be restored" — a
   promise the code doesn't keep on this path. One confirmed stuck row,
   `created_at = 2026-09-15 09:39:56.663+00` (the incident second).

**Done means:** a turn cannot time out shorter than a tool it's actively running; an aborted tool
process is actually terminated, not orphaned; and the HITL cleanup runs unconditionally via
`finally`, not only on the happy path.

---

## Approach (pick one, or propose a third with reasoning — this is a real design choice)

**Option A — per-tool deadline.** The outer guard's timeout becomes `max(OFFICE_TURN_TIMEOUT_MS,
<active tool's own budget>)` rather than a fixed constant, read from the tool's declared timeout.
**Option B — keep-alive while streaming.** If a tool emits progress (per the 2026-09-09 progress-
streaming work), each progress event resets the outer guard's clock, so a genuinely-hung tool still
times out but an actively-working one doesn't.

Read `src/gateway/kernel-run.ts` in full before choosing — one of these may already be a closer fit
to the existing control flow than the other. State which you picked and why in the PR.

## Files in scope

| Path | Change |
|---|---|
| `src/gateway/kernel-run.ts` | timeout logic (B5) + move HITL cleanup into `finally` (B7) |
| `src/tools/claude-code.ts` | accept and honor an `AbortSignal` so the outer guard can actually kill the child process (B6) |
| `tests/unit/gateway/` (matching existing location) | regression tests: a tool with a longer declared budget doesn't get killed early; an aborted tool's child process receives a kill signal; a timed-out turn leaves no pending HITL row |

## Explicitly forbidden

- Do not simply raise `OFFICE_TURN_TIMEOUT_MS` to a bigger fixed number — that doesn't fix the
  relationship between the two budgets, it just moves where the same bug recurs next (see
  [[docs/plans/2026-09-16-recurring-failure-patterns-and-behavior-audit.md]] Theme 7's "no single
  constant was wrong, the defect was the relationship" — same shape here).
- Do not touch `claude_code`'s 15-minute budget itself — it's correct for its purpose.
- No `any`, no `console.log` — `pnpm verify:arch` enforces both.

## Verify

```bash
pnpm gate
```

Then reproduce the original failure mode if possible: a turn using `claude_code` for longer than
300s should no longer die at `turn.error @ 300012ms` (the fallback-chain-starvation session doc has
the exact log line shape to match against). Per rule #36, name one real-path assertion or say
**NOT VERIFIED — reason** in the PR body.
