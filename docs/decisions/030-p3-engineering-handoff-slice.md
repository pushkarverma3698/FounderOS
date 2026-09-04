# ADR-030 — P3: Engineering handoff typed state slice

- **Date:** 2026-06-17
- **Status:** Accepted (beta)
- **Follows:** [ADR-029](029-p2-engineering-subgraph-wired.md), [ADR-022](022-typed-interdept-contracts.md) pattern

## Context

P2 wired the CTO subgraph into the live office. Cross-boundary transfers still
risked carrying routing directives, stale thread history, and company-wide
context into the CTO's LLM input — context bloat and routing confusion (rule #21).

## Decision

1. **`EngineeringHandoff` Zod slice** (`src/agents/handoff-engineering.ts`):
   `taskBrief`, optional `owner`, `repo`, `branch`, `cwd`. Schema version in
   `src/agents/state.ts`.

2. **Deterministic extraction** at the gateway pre-router when `dept=engineering`:
   `extractEngineeringHandoff(text)` + `formatEngineeringHandoffEnvelope()` embedded
   in the routing directive.

3. **CTO boundary isolation** via `preModelHook` on `buildEngineeringDomain()`:
   parses envelope, replaces `llmInputMessages` with `isolateEngineeringMessages()`
   (typed slice only).

4. **Verification gates:**
   - `pnpm verify:p3` — structural (envelope, token ceiling, preModelHook wired)
   - `pnpm gate:p3:live` — isolation shrinks bloated input + P2 HITL still fires

## Consequences

- CTO never sees `ADMIN CONTEXT` / stale turns from the parent thread.
- Handoff fields are testable pure functions (rule #16).
- Re-exports from `contracts.ts` for discoverability alongside signal contracts.

## Live verification

```bash
pnpm gate:p3:live
```

Evidence: isolated slice tokens ≪ bloated input; `github_create_issue` HITL interrupt
still surfaces on real office invoke with `ENGINEERING_SUBGRAPH=1`.
