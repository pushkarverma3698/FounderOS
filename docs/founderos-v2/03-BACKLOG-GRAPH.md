# 03 — Backlog Graph

**This file is data, not prose.** At M0b it becomes the first rows loaded into the `missions` table
— FounderOS solving its own construction graph. That is the acceptance test for M0b: *the system's
first missions are its own build-out.*

## Node shape

```ts
MissionNode := {
  id, objective, dependencies[], capability_required,
  provider,                       // resolved at dispatch by the registry, not hardcoded
  business_id,                    // "founderos" for all self-build nodes → counts against the 20% cap
  problem_id,                     // the problem this attacks; holds the KPI
  priority, est_cost_usd, est_days,
  risk_class,                     // low | medium | high → decides merge path (M-R)
  reduces,                        // which M0.5 founder-time category this reduces
  outcome                         // null until terminal
}
```

`risk_class` is load-bearing: `low` may auto-merge on green, `high` is always founder-merge.

## Graph

```
M0.5 ──────────────────────────────────────────► (runs in parallel, gates M6's proof)
  │
M0a ──► M0b ──► M-R ──► M1 ──► M2 ──► M3 ──► M4 ──► M5 ──► M6 ⟨CROSSOVER⟩
                 │              │                            │
                 └── unblocks ──┴────────────────────────────┘
```

## Nodes

| id | objective | deps | capability | risk | reduces | est |
|---|---|---|---|---|---|---|
| **M0.5** | Two-week founder-time baseline across 7 categories | — | human | low | *establishes the baseline* | 2 wk (bg) |
| **M0a** | Evolution Engine v0: self-audit analyzers on working sensors; cadence ladder; ranked roadmap to Telegram; Ollama, $0 | — | analysis | low | Planning, Researching | 5–6 d |
| **M0b** | Sensors + Problem/Business layer: wire dead `missions` API into `kernel-run`; `problems` table; `writeTaskOutcome`; `updateApplicationStage`; costs→`mission_id`; activate `COMPANY_PROFILES`; KPI linkage; load this graph | M0a | backend | medium | Planning | 6–7 d |
| **M-R** | Review throughput: risk-classed merge; Claude as first reviewer; batched digest | M0b | backend | **high** | **Reviewing** | 2–3 d |
| **M1** | Executive Engine: economics, Negotiation, uncertainty fields, "recommend NOT building" path, resource vector, portfolio allocation, **20% cap** | M0b | backend | medium | Planning | 5–6 d |
| **M2** | Intelligence Engine: revive `bench/metrics.ts` into live capability→strategy→provider profiles. Wilson bounds · N shown · ε-greedy | M0b, M1 | analysis | medium | Prompting | 5–6 d |
| **M3** | Capability Registry + Execution Strategy + Discovery; replaces hardcoded `WORKERS`; domain-general; `rank.ts` pure | M2 | backend | medium | Prompting, Coding | 6–7 d |
| **M4** | Single tool boundary: consolidate 20 `hitlGate` sites onto `adaptTool`; `idempotency_key` in receipts; fitness rule | M3 | backend | **high** | Debugging | 3–4 d |
| **M5** | Reflection · Friction Detector · DNA · **Policy Engine v0** · typed assets; memory decay + merge | M4 | analysis | medium | Prompting, Planning | 6–7 d |
| **M6** | **⟨CROSSOVER⟩** Evolution Engine v1: reflections → auto-created build missions; measure before/after vs business KPI **and M0.5**; autonomous to **green PR** | M5 | orchestration | **high** | *all* | 5–6 d |

**Total to crossover: ~27–33 working days** (M0.5 runs in parallel).

## Parallelisable to Antigravity (off the critical path)

| Work | Parent | Why it parallelises |
|---|---|---|
| Self-audit analyzers + tests | M0a | Wide-and-shallow; each analyzer is independent and pure |
| Provider adapters | M3 | One per provider kind; no shared state |
| The 20-file `hitlGate` migration | M4 | Mechanical, batched in 3s, each with a regression test |
| Test authoring across all nodes | all | Pattern-following against existing suites |

**Review discipline:** the executor is never its own grader. Every delegated batch closes with
reading `git diff` and re-running the verify command — never accepting Antigravity's own summary.

## Post-crossover backlog (built by the system)

Knowledge Graph + World Model · Capability Marketplace & cross-business inheritance ·
Business Workflows (`wake_at`, months-long) · Signal bus · Founder Memory · Market Awareness ·
Metrics dashboard · Plugin extraction · Parallel execution (**gated on langgraphjs PR #2665**) ·
Amputation (~1,865 LOC + 5 deps).

**Then, only with ≥1 quarter of data:** Simulation · Prediction · Portfolio Engine.

## Amputation list (approved in principle; execute post-crossover)

`src/outreach/` (648) · `src/workflows/` (372) · `src/infra/context-manager.ts` (342) ·
`src/tools/jobhunt/humanise.ts` (136) · `SUPERVISOR_PROMPT` (169) · dead CRM queries
(`createLead`, `updateLeadStage`, `getLeadById`, `getLeadsByStage`, `addSuppression`)

Deps: `@langchain/langgraph-supervisor` · `mem0ai` · `hono` · `opossum` · `bottleneck`
**Verify before removing:** `langsmith` (can activate via env without an import).

> `src/bench/metrics.ts` is **NOT** on this list despite being orphaned — M2 revives it as the
> Intelligence Engine's scorer.
