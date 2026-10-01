## Goal

Integrate Jev AI as a System 1 deterministic gateway and RAG pre-filter across FounderOS routing, memory retrieval, and tool validation systems.

## Problem / observed behavior

Task dispatched by Founder via FounderOS.

## Expected behavior

Implement Jev AI integration as a fast System 1 deterministic gateway and RAG context pre-filter.
- In `src/agents/supervisor.ts`: Integrate Jev AI gateway for immediate, low-latency deterministic decision-making and route evaluation before falling back to full LLM processing.
- In `src/tools/brain.ts`: Integrate Jev AI context pre-filtering to trim and filter RAG search results and document context before presenting to the reasoning model.
- In tool dispatch validation layer: Add pre-execution validation checks using Jev AI rules.
- Maintain existing interfaces and ensure fallback to standard behavior if Jev AI engine options are disabled/unavailable.

## Files or subsystem in scope

src/agents/supervisor.ts, src/tools/brain.ts, src/tools/index.ts, src/services/jev-ai.ts

## Explicitly forbidden

Do not break existing test suites, do not remove existing fallback supervisor/RAG logic, do not commit directly to main.

## Verification commands

pnpm test && pnpm gate

## Acceptance criteria

1. Supervisor router (src/agents/supervisor.ts) invokes Jev AI gateway for fast System 1 deterministic routing decision.
2. Turicks-brain tool (src/tools/brain.ts) uses Jev AI pre-filtering on RAG context retrieval.
3. Tool dispatch validation layer validates tool calls using Jev AI rules before dispatch.
4. Feature branch created and draft PR opened against beta branch.
5. All tests pass with `pnpm test`.
