# Mechanism fix — fail-open ratchet doesn't see silent default values

**Theme:** 1 — fail-open / fail-silent paths, 12 independent instances
([docs/plans/2026-09-16-recurring-failure-patterns-and-behavior-audit.md](2026-09-16-recurring-failure-patterns-and-behavior-audit.md))
**Status:** implementation plan, not yet built

## Problem

The existing mechanism — the `// allow-failopen: <reason>` tag plus the architecture ratchet
(`docs/PROOF.md`: `fail-open-catch: 11`, frozen since 2026-08-28) — only sees `catch` blocks. Most
confirmed instances aren't caught exceptions at all: a shadow-table query returning an empty result
set (no exception, just the wrong table); a health check whose default return value looks identical
to a real "everything's fine" result; `tailor_cv`'s slop-check failure degrading to plain text with
no signal. Static detection of "this default return value is indistinguishable from a real success"
is genuinely hard in general — not every case is mechanizable the way a `catch` block is.

## Approach

Two mechanisms, different strength:

1. **Narrow static check (buildable now).** Extend `scripts/verify-architecture.ts`'s fail-open
   scan to also flag functions whose return type includes a "no data" or "healthy" shape (e.g.
   `coveragePercent`, `{ status: "ok" }`-style literals) where that value is hardcoded rather than
   computed from an actual check result in every code path. This catches the exact shape of the
   `inspectRagHealth` bug (a caught DB error returning a hardcoded `100`), not the general case.
2. **Convention + review discipline (the realistic majority case).** Any function that can mean
   both "checked, found nothing" and "didn't check" must return a discriminated union
   (`{ ok: true; data: T } | { ok: false; reason: string }`), never a bare default. Add this as an
   explicit item to the code-reviewer agent's rubric — full static detection of "this default masks
   an unchecked failure" isn't reliable enough to gate CI on alone; a human/agent review pass
   catches what the ratchet structurally can't.

## Files likely in scope

- `scripts/verify-architecture.ts` — new narrow check
- `~/.claude/agents/code-reviewer.md`-equivalent rubric addition (or this repo's own review
  checklist doc, if one exists) — add "does this default value look identical to a real success?"
- `docs/rules/ecc/common/code-review.md` (global) — candidate location for the convention, if the
  founder wants it globally, not just per-repo

## Out of scope

- Do not attempt full general-purpose static detection of every fail-open shape — not reliably
  buildable, and a false sense of CI coverage is worse than an honest "review catches this" answer.
- Do not retroactively fix all 11 currently-tagged `fail-open-catch` instances as part of this —
  that's separate cleanup work, not a mechanism change.

## Verify

```bash
pnpm verify:arch
```
New check should fail on a synthetic reproduction of the `inspectRagHealth` shape (hardcoded
"healthy" default on caught error) and pass on the same function once fixed to return a
discriminated union.

## Next step

Turn into an AG-NNN dispatch brief once prioritized — next available slot AG-020.
