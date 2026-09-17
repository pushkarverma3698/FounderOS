# AG-018 — tailor_cv slop-check failure degrades to plain text silently

**Milestone:** issue #687 item 5
**Branch:** `task/issue-<N>-tailor-cv-slop-check` — cut from fresh `origin/beta`. PR base: `beta`.
**Status:** ready to dispatch pending founder go-ahead (not yet filed as a GitHub issue)

**Read [STANDARDS.md](STANDARDS.md) in full before writing any code. It is binding.**

---

## This is a fail-open instance, not just a formatting bug

`src/tools/jobhunt/tailor-cv.ts` (confirmed real path — the one file issue #687 named correctly) has
a slop-check assertion that, on failure, degrades output to unformatted plain text **instead of
surfacing that the check failed**. This is a direct instance of
[[docs/plans/2026-09-16-recurring-failure-patterns-and-behavior-audit.md]] Theme 1 (fail-open /
fail-silent paths) — treat the "why does it silently degrade instead of erroring loudly" question as
equally important as "why does the slop check fail in the first place."

## Goal

Two things, in this priority order:

1. **Stop the silent degrade.** When the slop-check assertion fails, the founder (or whoever's
   reading the output) needs to know the CV didn't meet formatting/slop requirements — not receive
   an unformatted draft with no indication anything went wrong. Surface the failure explicitly (a
   flagged/marked output, a Telegram note, or a hard failure with a clear reason — pick based on
   what `tailor-cv.ts`'s caller can actually act on).
2. **Fix the root cause** of the slop-check failing in the first place, if it's fixable — refine the
   prompt constraints or post-processing so the common case passes cleanly.

Do not do only #2 and leave the silent-degrade path in place for the next time a different input
trips the same assertion — that's the part of this bug that will recur.

## Measured starting state — verify before you begin

```bash
grep -n "slop" src/tools/jobhunt/tailor-cv.ts
grep -rn "slop" tests/unit/jobhunt/ 2>/dev/null
```

Find the actual assertion, what triggers it, and what "plain-text fallback" currently looks like in
code before changing anything.

## Files in scope

| Path | Change |
|---|---|
| `src/tools/jobhunt/tailor-cv.ts` | replace the silent plain-text fallback with an explicit failure signal; fix the slop-check root cause if identifiable |
| `tests/unit/jobhunt/` (matching existing test location for this tool) | regression test: a slop-check failure is now visible in the tool's result/receipt, not silently downgraded |

## Explicitly forbidden

- Do not remove the slop check to make the failure go away — it exists for a reason (this repo's
  `no-ai-slop` discipline). The fix is to surface the failure, not delete the guard.
- Do not touch the CV base-file loading logic or `read_cv` (that's B12, a separate defect, out of
  scope here).
- No `any`, no `console.log` — `pnpm verify:arch` enforces both.

## Verify

```bash
pnpm gate
```

Per rule #36: trigger the slop-check failure path with a real or synthetic bad draft and show the
new behavior (explicit failure, not silent plain text) in the PR body, or say
**NOT VERIFIED — reason**.
