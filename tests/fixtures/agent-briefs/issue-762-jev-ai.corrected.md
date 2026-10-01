## Goal

Add a deterministic pre-filter that trims RAG search results before they reach the reasoning model, and a pre-execution validation step for tool calls. Done means both are wired into the existing kernel path, covered by unit tests, and fall back to today's behaviour when they are disabled.

## Problem / observed behavior

RAG search results and tool-call arguments currently reach the reasoning model and the tool layer unfiltered, so a noisy retrieval or a malformed call is only caught downstream.

## Expected behavior

Implement the pre-filter as pure, unit-tested functions.
- In `src/kernel/supervisor.ts`: run the deterministic route evaluation before any LLM call and keep the current decision as the fallback.
- In `src/tools/rag.ts`: trim and filter search results before they are returned to the reasoning model.
- In the tool dispatch validation layer: add pre-execution checks that reject a malformed call with a typed failure.
- Maintain existing interfaces and fall back to standard behaviour when the pre-filter is disabled or unavailable.

## Evidence

- Issue #762 named files that do not exist on main; the dispatcher on main is `src/kernel/supervisor.ts` (pure code, per the file map in CLAUDE.md).
- This brief lists only files that exist today. The one file it adds is listed under "New files to create" so the lint does not look for it.

## Files or subsystem in scope

src/kernel/supervisor.ts, src/tools/rag.ts, src/tools/index.ts

### New files to create

src/tools/rag-prefilter.ts

## Constraints

- Keep `src/kernel/` free of I/O: the pre-filter takes already-fetched data and returns new data.
- No new npm dependency.
- Existing tool and kernel interfaces must not change.

## Explicitly forbidden

Do not break existing test suites, do not remove existing fallback supervisor/RAG logic, do not commit directly to main.

## Verification commands

pnpm test && pnpm gate

## Acceptance criteria

1. The supervisor (src/kernel/supervisor.ts) runs the pre-filter before any LLM call and falls back to its current decision when it is disabled.
2. The RAG tool (src/tools/rag.ts) trims results through the pre-filter before returning them.
3. Tool calls are validated before dispatch and a malformed call fails with a typed failure.
4. Feature branch created and draft PR opened against beta branch.
5. All tests pass with `pnpm test`.
