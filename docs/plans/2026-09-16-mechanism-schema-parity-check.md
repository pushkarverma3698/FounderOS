# Mechanism fix — CI check for UnifiedTool ↔ LangChain wrapper schema parity

**Theme:** 6 — schema/wiring mismatches, 5 independent instances
([docs/plans/2026-09-16-recurring-failure-patterns-and-behavior-audit.md](2026-09-16-recurring-failure-patterns-and-behavior-audit.md))
**Status:** implementation plan, not yet built

## Problem

A `UnifiedTool`'s declared zod schema is not always what the planner actually sees, because the
LangChain wrapper that registers it (`capabilities.ts`/`agent-tools.ts`) can declare a narrower
schema of its own, silently dropping fields — confirmed for `jobBriefTool`'s `verb`/`range`/`axis`
(2026-09-09). No mechanism catches this today; every fix has been a local patch to the one field
that happened to get noticed missing.

## Approach

Both `UnifiedTool` definitions and their LangChain wrapper registrations use zod schemas, which are
introspectable at their `.shape` (or `.shape()` depending on zod version) property. A CI script can:

1. Enumerate every `UnifiedTool` in `src/tools/` and its declared input schema.
2. Find its corresponding wrapper registration (by tool name) in `src/agents/agent-tools/` /
   `capabilities.ts`.
3. Diff the two field sets. Fail if the wrapper's schema is missing any field the `UnifiedTool`
   declares, unless the field is on a small, explicit allowlist (a field genuinely meant to be
   internal-only, if that case exists).

This is a real static check, not a heuristic — both schemas exist at build time and can be compared
directly, unlike Theme 1's fail-open detection.

## Files likely in scope

- new script, e.g. `scripts/verify-tool-schema-parity.ts`
- wire into `pnpm verify:arch` or `pnpm gate` as a new step
- `src/tools/*.ts` / `src/agents/agent-tools/*.ts` — no changes needed to fix existing drift unless
  the check finds current violations (it may — this should be run once manually before wiring into
  CI, to see if `jobBriefTool`'s original bug class has any live siblings)

## Out of scope

- Not attempting to check parity for tools that don't have a zod-schema-based wrapper (if any use a
  different registration mechanism, they're out of scope for this pass — note them, don't block on
  them).

## Verify

```bash
node --import tsx/esm scripts/verify-tool-schema-parity.ts
```
Should report zero mismatches once wired in, or list any current drift found on first run (expected
— this is the first time this check will have existed).

## Next step

Turn into an AG-NNN dispatch brief once prioritized. Recommend running the check manually first (as
a one-off script, not yet CI-gated) to see how much existing drift it finds before deciding whether
CI should hard-fail or warn initially.
