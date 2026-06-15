# ADR-027: Tool-count and handoff rules for the hierarchical company

**Status:** Accepted (2026-06-15)
**Context:** Scaling to a hierarchical "company" raised two proposed rigid rules:
"exactly 2 tools per sub-agent" and "no direct handoffs (async everything)".
Researched against LangGraph hierarchical-teams + LangChain subagents docs.

## Decision
1. **No fixed tool cap.** Each sub-agent carries a small, domain-coherent toolset.
   The split signal is ~10 tools on a single agent; do not split prematurely —
   stay single while eval ≥85% on homogeneous tasks. (FounderOS depts: 1–4 tools.)
2. **Synchronous handoffs on the request path; async signals for background.**
   Tool-wrapped subagents are invisible to `getState()` — nested `interrupt()`
   would not surface, breaking the `getState().tasks` HITL path. So the
   interactive supervisor→department path stays synchronous (`Command`).
   `dept_signals` (ADR-024) remains the async layer for independent background
   coordination only.

## Consequences
- The CTO Engineering subgraph uses synchronous nesting (revenue-domain.ts pattern).
- New sub-agents are small by role, not by decree.
- Background cross-domain work continues to publish/consume dept_signals.
