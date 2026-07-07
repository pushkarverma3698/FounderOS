# FounderOS — Architecture Review

**Reviewer:** Senior architecture review pass
**Date:** 2026-05-26
**Scope:** Phase 1A (foundation) + 1B (brain) complete; 1C (gateway) next.

---

## 1. Architecture Strengths

- **Registry-as-source-of-truth (`src/core/registry.ts`).** Adding a company or agent is a one-file change. Backlink population (Agent → Company) keeps lookups O(1). This is genuinely better than what most early-stage agent stacks ship with.
- **Cross-family critic (`src/agents/critic.ts`).** Gemini-generates / Claude-critiques is a sound anti-sycophancy pattern. Critic correctly modeled as a NODE with side effects, separated from the pure routing edge (`afterCriticEdge`). Textbook LangGraph.
- **DB-backed HITL before `interrupt()`** (`gateway/hitl.ts` + `interrupt_registry`). Crash-safe by construction. Most hobby agent projects skip this; it's the right call.
- **Cascade + circuit breaker + bottleneck + cost logging** in one place (`infra/llm.ts`). Provider failover with per-`provider:model` opossum breakers is production-grade.
- **Schema versioning on every Annotation.** Cheap insurance; rarely seen in side projects.
- **Singleton graph compile** (`getGraph()` memoization in `graph.ts`). Correctly avoids the most common LangGraph performance footgun.
- **Idempotency guard before external side effects** (`hasBeenAudited` in `finalizeNode`). Real engineering discipline.

---

## 2. Critical Risks & Gaps

1. **HITL does not actually pause the graph.** `requestHITL` writes the DB row but never calls LangGraph `interrupt()`. The sales pod flows `hitl_gate -> finalize` straight through, so `finalize` runs before the human approves. This is the single biggest correctness bug. Fix: call `interrupt()` inside `hitlNode` and resume via `Command({ resume })` from the Telegram callback.
2. **Circuit breakers are dead code.** `getBreaker` is defined but never used in `callCascade` — the action closure is a placeholder that throws. Either wire it (`breaker.fire(...)`) or delete it. Right now it gives false confidence.
3. **Subgraph runs without checkpointer.** `salesGraph.compile()` in `pods/sales.ts` has no checkpointer, so the sales pod is not actually resumable mid-flight despite the parent being checkpointed. LangGraph nested checkpointing needs explicit propagation.
4. **CEO JSON parsing is brittle.** `supervisor.ts` falls back to `direct_answer` on parse failure, but downstream nodes read `state.task` and `state.department`. A malformed CEO response produces `department: ""` -> graph routes to `END` silently. Use `generateObject` with a Zod schema instead of string parsing.
5. **No retry loop budget.** `revision_count` is bumped only in the critic. If `bdr` throws after several cascade fallbacks, the loop never escapes — the breaker is the only safety net, and it's not wired.
6. **`thread_id` derived from `trace_id`** (`${tenant_id}:sales:${trace_id}`). `trace_id` defaults to a new UUID per state init, so reruns of the same Telegram message get new threads — no idempotency at the conversation level.
7. **Sycophancy pattern is partially undermined** — the critic rules document is loaded from disk inside the node and cached as a module-level `let`. In multi-process or hot-reload, cache invalidation is unclear. Minor, but worth a comment.

---

## 3. Complexity Hotspots

- **34 agents in the registry, ~6 actually wired into pods.** This is aspirational scope and bloats reviewer cognition. Cut to ~10 agents that have real nodes; mark the rest as "planned" in a separate file or comment block.
- **Three near-identical pod state schemas** (`SalesState` / `EngineeringState` / `MarketingState`) duplicate 80% of fields. Factor a `BasePodState` Annotation and spread it; saves ~150 lines and a future migration.
- **Critic's `extractDepartmentRules` is a hand-rolled markdown parser.** Replace with three rule strings keyed by department, or a small YAML file. The line-based parser is a debugging trap.
- **`callCascade` is doing six things** (provider resolution, rate limiting, breakers, cost logging, error aggregation, fallback). Split: (a) `callProvider(entry)` primitive, (b) `withFallback(tier)` composer. Easier to test.
- **Wrapper nodes in `graph.ts`** (salesNode/engineeringNode/marketingNode) are copy-paste. One generic `wrapPod(subgraph, draftField)` factory removes 60 lines.

---

## 4. Multi-Workflow Concurrency (one-man company)

The realistic concurrency picture is not "10 things at once" — it's "3-4 long-running workflows, each with a HITL pause, the founder context-switches between them on Telegram." Recommended pattern:

- **One Node process. One Postgres.** Do not add Redis/BullMQ in Phase 1 — Cal.com and Plausible ran on a single Node+Postgres for years.
- **Thread = workflow.** `thread_id = tenant:dept:topic_msg_id` (stable across reruns). Each Telegram topic message starts or resumes a thread. LangGraph checkpointer handles all interleaving naturally because each `invoke` is independent.
- **Concurrency unit = `Promise.all` over independent threads** at the gateway, not parallelism inside a graph. The Bottleneck limiter (`maxConcurrent: 5`) already serializes LLM calls globally — good.
- **Per-tenant budget guard** (already in `checkBudget`) gives the only backpressure you need. When daily spend hits cap, new threads error politely.
- **One dashboard line per thread** in Telegram: pinned message in the boardroom topic showing `[sales-acme: awaiting approval] [eng-PR42: running] [mktg-post: drafting]`. This is your ops surface. No Kanban needed.

When (and only when) you have 50+ concurrent threads or remote workers, swap the in-process invoke for BullMQ — graph code stays the same.

---

## 5. Industry Benchmarks (micro-SaaS that scaled)

What Cal.com, Plausible, Pika, Lemon Squeezy, Raycast (pre-Series A) standardized on:

- **Boring monolith + Postgres.** Plausible was Elixir+Postgres to $1M ARR. Cal.com is Next.js+Prisma+Postgres. No microservices.
- **One queue, one cache, one DB.** Plausible used Postgres for everything before adding ClickHouse. Lemon Squeezy still runs Laravel + Postgres + Redis.
- **Feature flags + audit log over fancy authz.** Simple `audit_log` table, not Casbin/OPA.
- **Sentry + one observability vendor.** Not a Grafana stack. You picked LangSmith + Pino — sufficient.
- **Stripe + Postmark/Resend** — buy, do not build, billing and transactional email.

What they did NOT build (and you might be tempted to):

- **Their own vector DB** (ChromaDB self-hosted is fine, but most went pgvector to delay infra).
- **Custom RBAC.** Single-owner system — `tenant_id` filter is enough.
- **Multi-region from day one.**
- **A plugin system.** The `UnifiedTool` registry is good; do not build a marketplace.
- **Streaming UI.** Telegram is not interactive enough to need streamed tokens.
- **A "platform."** Resist generalizing the FounderOS framework for other founders until 1 paying user asks.

---

## 6. Portfolio Readiness (senior backend / AI eng hiring lens)

Strong: typed state, LangGraph patterns, cascade + cost tracking, ADRs folder, schema versioning, idempotency.

Missing (a senior reviewer will look for these):

- **An actual test suite.** `vitest.config.ts` exists; `tests/` doesn't. Add at minimum: `_resolveDepartment` unit, critic JSON parse, `afterCriticEdge` truth table, `callCascade` fallback with mocked providers.
- **An evaluation harness.** One LangSmith dataset + 10 graded sales emails proves you understand LLM eval, not just LLM calling.
- **One worked end-to-end trace** in `docs/` (LangSmith share-link or screenshots) — this is the single most persuasive artifact.
- **Load/cost numbers.** "p50 latency 4.2s, $0.018 per sales draft" in the README.
- **A diagram in `architecture.md` that matches code.** Current ASCII shows `senior_dev -> vibe_coder -> qa_tester` but no eng pod implementation is shown in this review — verify it exists or update the doc.
- **Conventional commits + a 30-second demo gif/video** at the top of README. Hiring managers scroll for 20 seconds.
- **Threat model paragraph.** Telegram bot token compromise, prompt injection in lead intel scraping, idempotency-key collisions. Half a page is enough.

---

## 7. Concrete Simplifications (max 5)

1. **`src/agents/critic.ts`** — delete `extractDepartmentRules` and the markdown loader. Inline three rule strings as `const RULES: Record<Department, string>`. Saves ~60 lines, removes a parsing class of bugs.
2. **`src/agents/state.ts`** — extract `BasePodState` Annotation with the shared 11 fields, spread into Sales/Eng/Marketing. Saves ~120 lines.
3. **`src/agents/graph.ts`** — replace three pod wrapper nodes with one `makePodNode(subgraph, getFinalField)` factory.
4. **`src/agents/supervisor.ts`** — replace JSON.parse + try/catch with Vercel AI SDK `generateObject({ schema: zCeoResponse })`. Removes the fence-stripping regex and the brittle fallback path.
5. **`src/core/registry.ts`** — move the 20+ aspirational agents to `_agentRoadmap` (not exported into `_agents`). Keep only the ~10 with real nodes in the live registry. Documents intent without polluting routing.

---

## 8. Next 2 Phases — Recommended Scope

**Phase 1C — Gateway (the value-multiplier phase).** Target: a real end-to-end Telegram interaction with HITL pause/resume working.

- Fix the HITL bug: `hitlNode` calls LangGraph `interrupt()`; `resolveHITL` triggers `graph.invoke(null, { configurable: { thread_id }, ...Command({ resume: decision }) })`.
- grammy bot with topic-aware routing (sales topic -> sales-prefixed task).
- Inline keyboard: Approve / Reject / Edit. Edit opens a force-reply.
- Status pinned message per topic showing active threads.
- `/health` and `/cost` admin commands (read from `llm_costs`).
- Wire the unused circuit breaker in `callCascade` OR delete it.
- One Composio integration: Gmail send (so finalize actually emails).

**Phase 1D — Tests + Evals (the portfolio phase).**

- Unit: critic edge truth table, registry lookups, cascade fallback with mocked providers, HITL state machine.
- Integration: full sales pod with a stubbed LLM returning canned JSON; assert audit_log + interrupt_registry rows.
- LangSmith eval dataset: 15 sales scenarios graded on ICP fit, banned-phrase compliance, length.
- A `make demo` script that runs a recorded scenario end-to-end and prints the cost + latency.
- Update README with the demo gif, the eval scores, and one LangSmith trace link.

Defer to 1E+: engineering pod implementation, ChromaDB, Naggar agents, LinkedIn growth. None of those move the portfolio needle until 1C/1D are tight.
