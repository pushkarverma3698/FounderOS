# Evidence map — market requirement → what proves it here

*2026-08-28. Every "demand %" comes from the 177 AI-track postings measured in
[MARKET-2026-AI-ENGINEER.md](MARKET-2026-AI-ENGINEER.md). Every "proof" is a file path or a
production number, not an adjective.*

Read this as a hiring manager would: **can the candidate point at the thing, and does it run?**

---

## Legend

| mark | meaning |
|---|---|
| ✅ | mechanism exists, is wired, and has production or CI evidence |
| 🟡 | exists but the evidence is thin, or it's built and not exercised at scale |
| ❌ | genuine gap — stated, not hidden |

---

## Tier 1 — table stakes (≥33% of AI postings)

| demand | % | status | proof |
|---|---|---|---|
| **Agents / agentic systems** | 61.0% | ✅ | 8 typed workers behind one orchestration path; `src/kernel/graph.ts`, `contracts.ts`. Not a chat loop — a `Plan` is Zod-validated data dispatched by **pure code**, not an LLM supervisor |
| **LLM integration** | 59.3% | ✅ | Injected models, 8 distinct providers used in prod (`agents.ai_call_costs`), temp 0, typed error taxonomy in `src/agents/model.ts` |
| **System design / architecture** | 53.7% | ✅ | 51 ADRs in `docs/decisions/`; three rewrites documented with the autopsy that forced each (`ZERO-BASE-AUDIT.md`) |
| **Scalability** | 45.2% | 🟡 | 1,297 ATS boards polled, 890 ingest runs/month, single-VPS. Horizontal scale is **not** demonstrated |
| **REST / API design** | 43.5% | ✅ | MCP server surface (`src/mcp/`), health API, Telegram gateway; 51 tool modules behind one `ToolResult` envelope |
| **Production systems** | 39.5% | ✅ | Live on a VPS since 2026-06; systemd + Docker + GitHub Actions CD; `docs/guides/DEPLOYMENT.md` |
| **Testing** | 39.5% | ✅ | **3,649 tests across 332 files, $0 per run** — scripted models let the full graph run in CI without paid calls |
| **Evaluation / evals** | **36.2%** | ✅ | Two harnesses: 41-task golden set (`pnpm eval`) and a retrieval ablation (`pnpm eval:retrieval`). Plus [an audit of the eval itself](../EVAL-AUDIT-2026-08-28.md) |
| **RAG / retrieval** | **35.6%** | ✅ | Hybrid pgvector + keyword via **reciprocal rank fusion** (`src/db/rrf.ts`, `rag-hybrid.ts`); **97.3% recall@5 / 0.855 MRR** measured over 1,214 chunks |
| **Security** | 36.7% | ✅ | `src/infra/path-guard.ts`, prompt-injection guard (incident SF-2), `docs/THREAT-MODEL.md` |
| **Python** | **70.1%** | ❌ | **This codebase is TypeScript.** The single largest measured gap — see [PORTFOLIO-GAPS-AND-ACTIONS.md](PORTFOLIO-GAPS-AND-ACTIONS.md) |
| **AWS / Azure / GCP** | 40 / 37 / 34% | 🟡 | Runs on Hetzner + Docker, not a hyperscaler. Google GenAI APIs used in prod; no managed-cloud IaC |

---

## Tier 2 — differentiators (10–33%)

| demand | % | status | proof |
|---|---|---|---|
| **CI/CD** | 32.8% | ✅ | `pnpm gate` = lint + build + wiring + arch + 3,649 tests; branch → beta → main with CD to prod |
| **Monitoring / observability** | 32.8 / 27.1% | ✅ | `src/infra/telemetry.ts`, `trace-callback.ts`, `health.ts`, `boot-report.ts`; per-call cost rows in `ai_call_costs` |
| **Vector database** | 26.0% | ✅ | pgvector in Postgres — **3.4% of postings name pgvector specifically**, so this is rarer vocabulary than it looks |
| **LangChain** | 25.4% | ✅ | LangChain tool wrappers throughout `src/agents/agent-tools/` |
| **Docker / Kubernetes** | 26.0 / 24.9% | 🟡 | Docker yes (Postgres, Ollama). **Kubernetes: no** |
| **Embeddings** | 24.3% | ✅ | `nomic-embed-text` via local Ollama; embedding pipeline in `src/db/` |
| **Prompt engineering** | 23.2% | ✅ | Worker prompts in `src/agents/prompts/`; and the stronger claim — routing is a **pure function**, deliberately *not* a prompt instruction (`regex-routing: 0` in the CI ratchet) |
| **Anthropic / OpenAI / Gemini** | 22.6 / 17.5 / 9.0% | ✅ | All three wired as providers; Gemini is the production default with a live-verified fallback chain |
| **Latency** | 18.1% | 🟡 | Measured in the retrieval eval (241ms p95 hybrid vs 9,579ms reranked → **rerank rejected on evidence**). Not gated in CI — named as a limitation |
| **LangGraph** | **18.1%** | ✅ | The kernel *is* a LangGraph `StateGraph` with a Postgres checkpointer — and [an upstream bug fix contributed back](https://github.com/langchain-ai/langgraphjs/pull/2665) (`maxConcurrency:1` silently dropped `Send` fan-out) |
| **TypeScript** | 15.8% | ✅ | Strict mode, Zod at every boundary |
| **MCP** | **15.3%** | ✅ | Read-only MCP server (`src/mcp/`) + MCP client bridge; `docs/guides/MCP-SERVERS.md` |
| **Multi-agent** | 14.1% | ✅ | 8 workers with **isolated envelope-only context** — a worker cannot see the conversation, only its `TaskEnvelope` |
| **MLOps / LLMOps** | 14.7 / 6.8% | 🟡 | Model routing, fallback chains, budget caps, cost attribution — yes. Model training/serving lifecycle — no |

---

## Tier 3 — rare vocabulary, highest leverage (<12%)

**This is the section that wins interviews.** These terms appear when a team has already been
burned in production.

| demand | % | status | proof |
|---|---|---|---|
| **Guardrails** | 11.9% | ✅ | Four independent mechanisms: `path-guard.ts` (filesystem), `daily-budget.ts` (spend), prompt-injection guard (SF-2), and HITL approval before every side effect |
| **Tool / function calling** | 9.0% | ✅ | 51 tool modules, 20 LangChain wrappers, capped per-step tool budget (`MAX_TOOL_CALLS_PER_STEP`) |
| **Human-in-the-loop** | **7.3%** | ✅✅ | **The strongest asset.** DB row written *before* `interrupt()`; side effects only after approval; idempotency key checked before every send. **229 real approvals in production — 131 approved, 36 rejected, 37 expired.** The gate has *actually blocked things* |
| **Cost optimisation** | 6.8% | ✅ | Per-call cost attribution: **1,843 calls, $2.53 total, $0.001373 mean**, across 8 models, tracked in `ai_call_costs`. Daily + per-run budget caps enforced in code |
| **Autonomous agents** | 6.8% | ✅ | **80 real side effects executed in production** (`action_log`): 24 shell runs, 13 code sessions, 11 GitHub issues, 6 LinkedIn posts, 6 emails, 1 job application, 1 site deploy |
| **Hallucination control** | 5.6% | ✅✅ | Mechanism, not a prompt: an action claim requires a successful `ToolReceipt` (`validateStepResult`); the synthesizer is fed **only validated results**, never raw tool output |
| **Reranking** | 5.6% | ✅ | Built (`src/db/rag-rerank.ts`) — and **measured then rejected**: +0.03 MRR but −8.4 points disjoint recall at 40× the latency. Evidence of *not* shipping something is rarer than shipping it |
| **pgvector** | 3.4% | ✅ | Production retrieval store |
| **LangFuse / LangSmith** | 2.3% each | ❌ | Neither wired. Observability is first-party (`telemetry.ts`) rather than a named vendor tool |

---

## What we have that the market hasn't learned to ask for yet

Not in the demand data, because these are things teams discover they need only after an
incident. They are the differentiators a *hiring manager* reacts to even when the JD doesn't
list them:

1. **An architecture-debt ratchet enforced in CI.** `governance/architecture-baseline.json`
   holds `gateway-imports: 0`, `kernel-purity: 0`, `regex-routing: 0`, `orphan-subsystem: 0`,
   `fail-open-catch: 11`, `loc-budget: 6` — and `scripts/verify-architecture.ts` **fails the
   build if any number rises**. Complexity cannot creep back by accident.
2. **Tombstones.** Deleted subsystems (the v2 supervisor, regex pre-router, execution guards)
   fail CI if anyone re-creates them. Deletion is enforced, not hoped for.
3. **Determinism as a mechanism.** The same input on two threads must produce **byte-identical
   plans** — asserted in `tests/unit/kernel/kernel-e2e.test.ts`, not claimed in a README.
4. **Typed failure reports.** `FailureReport = stage + component + evidence + retryable`. A
   failure names the component that failed instead of surfacing as a generic apology.
5. **A published limitations document.** `docs/LIMITATIONS.md` lists open defects by ID.
   Volunteering your own bug list is a stronger signal than a clean README.
6. **An audit of our own evaluation harness.** [EVAL-AUDIT-2026-08-28.md](../EVAL-AUDIT-2026-08-28.md)
   found that most of a bad score was the *measuring instrument*, and says so — including the
   one place the instrument was too generous.
7. **An upstream OSS fix** to LangGraph.js, CI-green and open.

---

## The honest gap list

Stated plainly, because a portfolio that claims no weaknesses reads as one that hasn't been
looked at:

| gap | severity | why it matters |
|---|---|---|
| **Python** — 70.1% of AI postings, codebase is TypeScript | **High** | The largest single mismatch in the dataset |
| **Kubernetes** — 24.9% | Medium | Runs on systemd + Docker on one VPS |
| **Hyperscaler (AWS/Azure/GCP)** — 34–40% | Medium | Hetzner + Docker; no managed-cloud IaC |
| **Horizontal scale** | Medium | Single instance, single tenant. Throughput is real; distribution is not demonstrated |
| **Named LLM-observability vendor** (LangFuse/LangSmith) — 2.3% | Low | First-party telemetry instead; low market demand |
| **Fine-tuning** — 15.8% | Low | No training work. This is an *AI engineering* profile, not an ML-research one — and the data says those are screened on different vocabularies |
| **Golden set not in CI** | Medium | Costs money, so it runs manually; a behavioural regression can reach main |

Remediation and sequencing: [PORTFOLIO-GAPS-AND-ACTIONS.md](PORTFOLIO-GAPS-AND-ACTIONS.md).

---

## The one-line version

> A production LangGraph agent kernel where every external action requires human approval,
> every action claim requires a receipt, retrieval is measured at 97.3% recall@5, complexity is
> ratcheted in CI, and the whole graph runs offline in 3,649 tests at $0 — with 229 real
> approvals and 80 real side effects behind it.

Every clause is a link in this document.
