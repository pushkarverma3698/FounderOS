# 04 — Design Log

**Why this file exists:** the roadmap's central claim is that the moat is the accumulated decision
corpus. This is the first entry in it. The reasoning behind **dropped** ideas matters most — it is
what stops them being re-proposed in six months by a founder, an agent, or a future Claude.

Eight design passes, 2026-08-06. Each row: what was proposed, what happened, why.

---

## Pass 1 — "FounderOS V2: mission state machine, event bus, DAG, stateless agents"

| Proposal | Outcome | Reason |
|---|---|---|
| Delete `Input→Planner→Executor→Done` | **Rejected as premise** | That architecture doesn't exist. v3 is already contract-first with a pure-code supervisor. The brief described a v2 mental model killed on 2026-07-08. |
| Stateless agents, constructed context | **Already done** | `envelopeMessage()`; workers never see the conversation. |
| Event bus | **Accepted, deferred** | `dept_signals` + 6 Zod contracts + exactly-once claiming already built and unwired. |
| Mission state machine surviving days | **Accepted** | `missions` table + 7 query fns already built, zero callers. |
| DAG / parallel execution | **Accepted, gated** | `dependencies` exists; `Send` unused. Blocked on langgraphjs PR #2665. |
| "No central retry loop" | **Dropped** | The escalating retry + typed `FailureReport` **is** the anti-hallucination mechanism. |
| 7 independent critics per merge | **Dropped** | 7 LLM calls/merge replacing deterministic gates that work at $0. |
| 6 always-on VPS daemons | **Dropped** | One box runs bot + Postgres + Ollama; latency is an existing incident class. |

## Pass 2 — "Audit is architecture-centric; I want an AI organization"

| Proposal | Outcome | Reason |
|---|---|---|
| Twelve engines; coding is one | **Accepted** — reframed the whole plan | Correct; the first audit answered "is the architecture sound?" instead of "is this an organization?" |
| **M0 Evolution Engine first**, before everything | **Accepted, split into M0a/M0b** | Evolution = variation + **selection**; selection needs a fitness signal. Two sensors already worked (`ai_call_costs`, `failure_lessons`), three were dead. M0a ships on what works; M0b builds the rest. |
| Layer 5: dynamic per-mission LLM teams | **Dropped** | Department subgraphs were built, audited, killed, and are **CI tombstones**. The Capability Registry supersedes them. *(Conceded by founder in pass 3.)* |
| Layer 10: fully autonomous self-construction | **Accepted with ceiling** | Autonomy ends at a **green PR**; the founder's own CI/branch-protection rule set the boundary — no question needed. |

## Pass 3 — Concessions + Intelligence / Knowledge Graph / Simulation

| Proposal | Outcome | Reason |
|---|---|---|
| Intelligence Engine (empirical worker profiles) | **Accepted** | And its scorer already existed: `src/bench/metrics.ts`, orphaned, with `ToolReceipt` ground truth so the grader cannot hallucinate. |
| Knowledge Graph Engine | **Accepted, post-crossover** | `scripts/generate-knowledge-graph.ts` already emits typed nodes/edges from the live registry. Needs mission/ADR nodes + a query surface. |
| Simulation Engine | **Accepted, then removed in pass 8** | Requires historical data that doesn't exist. |
| Cadence ladder (per-mission → weekly → monthly → quarterly) | **Accepted** | With one constraint: per-mission reflection is fire-and-forget after the reply, never in turn latency. |
| Human-friction optimisation | **Accepted** — became the Friction Detector | Best idea of the pass; `saved_workflows` signature/`run_count` is its prototype. |

**Added by Claude:** sample-size discipline for M2 — Wilson bounds, N displayed, ε-greedy
exploration. Without it, routing away from a worker on 3 samples means never collecting the data
that would correct it (explore/exploit collapse).

## Pass 4 — Business defensibility, three streams, backlog graph

| Proposal | Outcome | Reason |
|---|---|---|
| The moat is accumulated experience, not models | **Accepted** — reframed the deliverable as the asset ledger | Strongest strategic point in the conversation; retroactively justifies sensors-first. |
| Backlog Graph replaces milestones | **Accepted** | And extended: the graph becomes the **first data in the `missions` table** — dogfood. |
| "Every manual action must become a future capability" | **Accepted** → became Constitution rule 1 | |
| Three parallel streams: 53 days → 18–25 | **Corrected to ~24–30** | Three reasons: (1) **bootstrap** — stream C is the artifact being built; (2) **data dependencies** M0b→M2→M3 are not organizational; (3) **review throughput** — 8 PRs/day × 10 min consumes the entire founder budget. Streams do collapse the wide work. |

**Added by Claude:** M-R (Review Throughput). If the founder reviews 80 missions, the founder is the
bottleneck the system exists to remove.

## Pass 5 — Venture OS: business above mission

| Proposal | Outcome | Reason |
|---|---|---|
| Elevate Business above Mission | **Accepted** | And it is cheap: `COMPANY_PROFILES` (turicks, naggar) is the **third** built-and-unreachable layer found. |
| Full Organization→Business→Product→Project hierarchy | **Reduced to thin keys** | `business_id`/`product_id` on the mission node. A six-level hierarchy above a mission table persisting zero rows is premature generalization. |
| Company OS, not Engineering OS | **Accepted** | Registry generalises to marketing/sales/finance/support with no special handling. |
| Business workflows (days–months) vs missions (hours–days) | **Accepted, post-crossover** | Same durable record + `wake_at`; reuses the proven claim-and-fire pattern. |
| Every mission produces typed assets | **Accepted** | Generalises `agent_assets` beyond files. |
| 80/20: FounderOS shouldn't consume its own capacity | **Accepted → made a mechanism** | Became the **20% self-improvement cap**, Executive-enforced, measurable via `mission_id` cost attribution. |

## Pass 6 — Portfolio, resources, capability-first, kernel+plugins

| Proposal | Outcome | Reason |
|---|---|---|
| **Capability → Providers** instead of Worker → Capability | **Accepted** | Architecturally superior and Claude should have proposed it. Capabilities are stable; providers rotate. A new model is a row, not a refactor. |
| Portfolio Engine | **Reduced to an allocation field** | N<3 revenue ventures. The entire portfolio decision today is "FounderOS vs Turicks" — which *is* the 20% cap. |
| Resource Scheduler incl. founder time/attention | **Accepted as a resource vector** on the Executive Engine | Founder attention is the scarcest resource; it's why M-R is on the critical path. |
| Kernel + plugins; "can this be a plugin?" | **Accepted as a design question**, not a refactor | The plugin boundary already exists: `applyMcpBridge()` + `mergeBridgedTools` (ADR-041). Extraction before kernel stability churns both. |
| "Reduces maintenance 30–40%" | **Not repeated** | Unsourced number. |

## Pass 7 — Design freeze

Claude flagged that the conversation had become the failure mode the roadmap prevents: seven passes,
zero files, zero code. The 20% cap applied to the design process itself. **Freeze recommended.**

## Pass 8 — Final additions, then frozen

| Proposal | Outcome | Reason |
|---|---|---|
| **M0.5 Founder Time Baseline** | **Accepted — highest value addition** | Makes the fitness function personal and measurable. Time-critical: a two-week measurement, so every day unstarted is a day on the critical path. Started 2026-08-06. |
| Problem as first durable entity | **Accepted** | One table, one FK. A problem can exist with no mission; many missions can attack one problem; the problem holds the KPI. |
| Policy Engine (memory → principle → policy) | **Accepted** | And the enforcement half exists: `verify-architecture.ts` fitness functions **are** policy-as-code. Only *derivation* is missing. |
| Execution Strategy between Capability and Provider | **Accepted** | single · dual-review · consensus · tournament · human-approval. Cheap now, expensive to retrofit. |
| Uncertainty Engine | **Accepted as a field set, not an engine** | `evidence · confidence · unknowns · assumptions · missing_data` on every decision record. |
| **Remove Simulation Engine** | **Accepted** | Founder correctly applied Claude's own sensors-before-evolution rule back. Joins Prediction + Portfolio in "deferred until data". |
| Identity: "Executive Intelligence System" | **Accepted + made falsifiable** | Positioning isn't testable; added the operational definition: *converts founder intent into executed, measured outcomes across a portfolio*. |
| Governance: changes only from telemetry / founder pain / flat KPI | **Accepted as a binding rule** | Violating it is a defect. |

---

## Standing corrections to `CLAUDE.md`

Found during the audit; the docs contradict the code:

1. **"`src/kernel/tool-adapter.ts` pins the ordering"** — it has **zero production importers**.
   20 files in `src/agents/agent-tools/` call `hitlGate` directly. Fixed by M4; until then the
   statement is false.
2. `ROADMAP.md` describes v2 (7 ReAct departments, "architecture is locked"). The live system is
   the v3 kernel with 8 workers. Treat `ROADMAP.md` as historical.

## Methodological note

Three dead-code heuristics were **discarded during the audit for producing false positives**
(`buildLessonStore`, `orchestrateRagQuery`, 17 `src/tools/*` modules — all correctly wired).
Every surviving claim uses single-occurrence counting or fixed-string import search.
**Recorded because the Evolution Engine's M0a analyzers will hit the same trap.**
