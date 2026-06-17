# ADR-029 — P2: Engineering subgraph wired into live office

- **Date:** 2026-06-17
- **Status:** Accepted (beta — flag default OFF)
- **Follows:** [ADR-028](028-manager-no-tools-hierarchy.md), [ADR-027](027-tool-count-and-handoff-rules.md)

## Context

P1 delivered an isolated CTO subgraph (`buildEngineeringDomain`) with nested HITL
proven via `buildEngineeringNestedOffice`. P2 wires that subgraph into the live
`buildOffice()` graph behind `ENGINEERING_SUBGRAPH=1`, preserving the same routable
`engineering` node name so supervisor routing and the capability manifest stay stable.

## Decision

1. **`office.ts` conditional wiring** (already merged in PR #103): when
   `ENGINEERING_SUBGRAPH=1`, the `engineering` department node is
   `buildEngineeringDomain()` (CTO over coder/qa/devops); otherwise the flat ReAct
   agent. Parent checkpointer supplies persistence for nested interrupts.

2. **Default remains OFF** until live MTProto verification passes (rule #19.6):
   `ENGINEERING_SUBGRAPH` defaults to `false` in `config.ts`. Flipping the default
   to `true` on `main` is a separate, gated promotion after founder confirms
   `scripts/e2e-telegram-qa.ts` evidence on beta with the flag ON.

3. **Pre-router engineering write directive**: GitHub issue/PR create prompts
   routed to `engineering` receive a `CRITICAL — GITHUB WRITE` system hint — CTO
   delegation when subgraph ON, direct tool call when flat.

4. **Verification gates added:**
   - `pnpm verify:p2` — deterministic structural checks (compile, nodes, toolsets)
   - `pnpm gate:p2` — lint + unit + verify:p2
   - `tests/integration/engineering-office-p2.test.ts` — full office + flag ON (live LLM, mocked tools)
   - `tests/unit/gateway/engineering-subgraph-hitl-card.test.ts` — gateway HITL card seam

## Consequences

- Beta can opt into nested engineering with `ENGINEERING_SUBGRAPH=1` in `.env`.
- Production on `main` stays flat until MTProto gate + explicit promotion.
- Integration suites use `hasLiveIntegrationModel()` (matches `AGENT_MODEL` provider key, not Google-only).

## MTProto gate (required before default ON)

Run on beta with `ENGINEERING_SUBGRAPH=1`:

```bash
node --env-file=.env --import tsx/esm scripts/e2e-telegram-qa.ts run T08 --approve
```

Evidence: bot reply + matching `action_log` row for github issue create; reject path
clean (no side effect); recursion abort does not wedge thread.

**Status:** NOT VERIFIED in Cloud VM — requires founder MTProto session
(`TELEGRAM_TESTER_SESSION`).
