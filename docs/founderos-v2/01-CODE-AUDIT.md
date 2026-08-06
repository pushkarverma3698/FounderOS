# 01 — Code Audit

**Date:** 2026-08-06 · **Method:** code-only. Documentation was treated as untrusted and is cited
only where it *contradicts* the code.

## Method (so the numbers can be trusted)

- **Dead symbol** = occurs **exactly once** across all of `src/**/*.ts` (its own declaration).
  This catches the false-positive class where a symbol is used inside its own file.
- **Orphan module** = fixed-string import search (`grep -rlF "/name.js"`) returns no importer in `src`.
- Three earlier heuristics were **discarded for producing false positives**. `buildLessonStore`,
  `orchestrateRagQuery`, and 17 `src/tools/*` modules are all **correctly wired** — the first
  scripts were wrong, not the code. Any claim below survived the corrected method.

## Verified health

| Measure | Value |
|---|---|
| `tsc --noEmit` | **clean** |
| `verify:arch` | **green, exactly at baseline** (gateway-imports 0 · kernel-purity 0 · regex-routing 0 · fail-open-catch 11 · loc-budget 5) |
| `pnpm test` | **238 files · 2,498 tests · 0 failures · 15.03s** (2026-08-06 baseline) |
| `src` | 259 files · 42,391 LOC |
| `tests` | 31,961 LOC (ratio 0.75) |
| Kernel | 18 files · 2,458 LOC (5.8% of src) |
| Tools | `src/tools` 8,347 + `src/tools/jobhunt` 7,756 = **16,103 LOC (38% of src)** |

## What the system actually is

One `StateGraph` ([src/kernel/graph.ts](../../src/kernel/graph.ts)):
`START → plan → dispatch → agent ⇄ tools → collect → dispatch … → synthesize → END`

- **Routing is pure code.** `dispatch()` in [supervisor.ts](../../src/kernel/supervisor.ts) is a
  total function over state, unit-tested, no LLM. Rare and genuinely excellent.
- **Receipts are recorded by code** at the call site,
  [worker.ts:286](../../src/kernel/worker.ts). The zero-hallucination claim is **real**.
- **Workers are context-isolated** — `envelopeMessage()` is a worker's entire view of the world.
- **State**: one `Annotation.Root`, reducers only, `history` capped at 20 turns / 16k chars,
  checkpointed to Postgres (`PostgresSaver`, schema `agents`).
- **Model stack**: `withLlmCache(withModelFallbacks(withModelRetry(model)))` — three wrappers,
  cache off by default.

**The kernel is the strongest component in this repo and is not rewritten by the V2 plan.**

## The defining finding: four complete layers, built and unconnected

| Layer | Built | Connected |
|---|---|---|
| **Mission state machine** | `missions` table ([schema.ts:603](../../src/db/schema.ts)) with lifecycle `INIT→RUNNING→PARTIAL→AWAITING APPROVAL→COMPLETE/ERROR`, `agent_statuses`, `next_action`, `telegram_msg_id`, + 7 query fns | ❌ **zero callers** |
| **Event bus** | `dept_signals` + 6 Zod contracts ([signals.ts](../../src/kernel/signals.ts)) + `consumePendingEvents()` with `FOR UPDATE SKIP LOCKED` + atomic `publishDeptEventWithAudit()` | ❌ **zero callers** (schema comment admits it) |
| **Business registry** | `COMPANY_PROFILES` in [core/companies.ts](../../src/core/companies.ts) — turicks + naggar, with `getCompany`, `buildCompanyContextBlock` | ❌ **zero importers** |
| **Tool boundary** | `adaptTool` in [tool-adapter.ts](../../src/kernel/tool-adapter.ts) — HITL→idempotency→execute→audit, unit-tested | ❌ **zero importers**; 20 files in `src/agents/agent-tools/` call `hitlGate` directly |

**This is unused architecture, not absent architecture — a much cheaper problem.**

## Findings by cost

### F1 — Tool boundary duplicated; the tested one is dead 🔴
`CLAUDE.md` states `tool-adapter.ts` "pins the ordering." The code contradicts it. Consequences:
idempotency is per-tool and ad hoc; receipts carry **no `idempotency_key`** on the live path; a
green `tool-adapter.test.ts` gives false confidence about a path that never executes.
→ **M4**

### F2 — No durable mission 🔴
What runs is a per-turn in-memory object (`state.mission`) destroyed when the reply is sent.
FounderOS has no durable concept of work in progress. → **M0b**

### F3 — The largest subsystem cannot record its own outcome 🔴
`src/tools/jobhunt` is **7,756 LOC — 18% of the codebase**. It ingests, gates, screens, ranks and
briefs. `updateApplicationStage` and `listLiveApplications` are **both dead** — it structurally
cannot record that an application happened. → **M0b**

### F4 — Event bus unwired 🟠
The hard parts (exactly-once claiming, atomic publish+audit) are solved and tested.
Only the wiring is missing. → post-crossover

### F5 — Orphaned subsystems 🟠 (~1,865 LOC)

| Module | LOC | Reachability |
|---|---|---|
| `src/outreach/` | 648 | script-only, no `src` importer |
| `src/workflows/` | 372 | script/test-only; runner never called by the kernel |
| `src/infra/context-manager.ts` | 342 | **zero** `src` importers |
| `src/bench/metrics.ts` | 198 | test-only — **but it is the Intelligence Engine's scorer** (see F8) |
| `src/tools/jobhunt/humanise.ts` | 136 | **zero** `src` importers |
| `SUPERVISOR_PROMPT` | 169 | the **v2 LLM router prompt**, re-exported, consumed by nobody |

### F6 — Dead CRM and dead self-improvement tables 🟠
`outbound_leads` + `do_not_contact` query API fully dead. `agent_results`
(`writeTaskOutcome`/`getRecentOutcomes`) is test-only — nothing in production writes task outcomes.
**Counter-finding:** `failure_lessons` **is** correctly wired (`buildLessonStore()` injected in
`kernel-boot.ts`). The system does learn from retry failures.

### F7 — Six production dependencies with zero `src` imports 🟡
`@langchain/langgraph-supervisor` · `mem0ai` · `hono` · `opossum` · `bottleneck` · `langsmith`.
**Caveat:** LangSmith can activate via env without an import — verify that one before removing.

### F8 — The Intelligence Engine's scorer already exists, orphaned 🟡
`src/bench/metrics.ts` is an *Agent Reliability Benchmark*: `ArmId = "founderos" | "react" | "raw"`,
`summariseArm`, `fabricatedClaims`, `failureClarity`, `planDeterminism`. Pure, unit-tested, ground
truth = the code-recorded `ToolReceipt` **so the grader cannot hallucinate**. → **M2 revives it**

### F9 — Observability is logs, not telemetry 🟡
`trace.ts` (pluggable sink), `TraceCallback`, pino, `ai_call_costs` ledger all exist. No aggregation,
no metrics endpoint. `HIERARCHY_AGENTS`/`hierarchyDepth` are v2 leftovers. You cannot answer
"what is p95 turn latency this week" from the system today.

### F10 — Structural ceilings 🟡
`MAX_PLAN_STEPS = 8` · `MAX_TOOL_CALLS_PER_STEP = 6` · `dispatch()` runs the **first ready step
alone** (`dependencies` exists, `Send` used nowhere) · 17 HITL-gated tools mean every external side
effect needs a founder tap — correct for safety, and the throughput ceiling for autonomy.

## Asset ledger — the moat, as of today

| Asset | State |
|---|---|
| Engineering decisions | **47 ADRs, RAG-indexed by `brain:sync`** ✅ |
| Failure→resolution memory | `failure_lessons` + `lessons.ts` ✅ |
| Cost per call | `ai_call_costs` ✅ |
| Timing per seam | `trace.ts` ✅ |
| Reliability scorers | `bench/metrics.ts` — written, orphaned 🟡 |
| Outcome history | ❌ dead |
| Execution history | ❌ dead |
| Capability profiles | ❌ absent |
| Engineering DNA | ❌ absent |
| Founder behavioural model | ❌ absent |

## Not verified

- **No VPS/prod state inspected.** All findings are from the local working tree at `main`.
- **`langsmith`** dependency status needs an env check before removal.
- Effort estimates elsewhere in these docs are estimates, not measurements.
