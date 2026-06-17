# ADR-028 — Manager has no tools (CrewAI hierarchical rule)

- **Date:** 2026-06-16
- **Status:** Accepted
- **Branch:** `cursor/hierarchy-manager-pattern-7ecf`
- **Follows:** [ADR-027](027-tool-count-and-handoff-rules.md), [ADR-025](025-hierarchy-proof-on-prebuilts.md), [ADR-024](024-dept-signals-over-postgres.md)

## Context

FounderOS adopted the LangGraph supervisor pattern with a flat 7-department office.
The Chief of Staff supervisor directly carried four business tools (`read_context`,
`update_context`, `search_memory`, `record_event`). Production traces showed the
manager executing IC work instead of delegating — routing ambiguity and audit-trail
gaps.

CrewAI's `Process.hierarchical` enforces: **the manager agent must not have tools**.
Workers hold tools; managers route. LangGraph's `createSupervisor` allows supervisor
tools, but industry practice (and our bug history) says that is a footgun.

## Decision

1. **All supervisors have zero business tools.** Chief of Staff, Revenue head, and
   CTO route via handoffs only. Handoff tools are routing primitives, not business
   capabilities.

2. **`admin` is a worker department** (not a nested supervisor). It owns:
   `read_context`, `update_context`, `search_memory`, `record_event`,
   `list_pending_signals`. It does not publish signals or perform outbound actions.

3. **Nest domain supervisors only when ≥2 workers coordinate** (ADR-027):
   - `revenue` → {marketing, sales} behind `REVENUE_SUBGRAPH=1`
   - `engineering` → {coder, qa, devops} behind `ENGINEERING_SUBGRAPH=1`
   - `admin`, `research`, `comms`, `personal`, `jobhunt` stay flat under COS

4. **Sync request path; async `dept_signals`** unchanged (ADR-027).

5. **Multi-step orchestration** uses a deterministic Task Ledger injected by the
   pre-router — not prose telling the manager to self-execute tools.

6. **Promotion gates unchanged** (ADR-025): subgraph flags default OFF; live MTProto
   verification before flipping defaults on `main`.

## Consequences

- `SUPERVISOR_TOOLS` is empty; capability manifest lists supervisor as handoffs-only.
- Pre-router routes context/memory queries to `admin`.
- Monday-brief orchestration routes `admin` → `engineering` → COS synthesis.
- Eval harness `Department` type includes `admin`.
- Graph regen reflects 8 departments (or 7 when revenue subgraph replaces marketing+sales).
