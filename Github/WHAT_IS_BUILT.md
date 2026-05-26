# FounderOS — What's Been Built

> **For recruiters & hiring managers:** A complete inventory of the FounderOS codebase with architectural highlights. Built as both a real operational system for Turicks (AI agency) and a portfolio demonstration of production TypeScript + AI architecture.

---

## TL;DR

A **multi-agent AI operating system** built in TypeScript on LangGraph. It runs Turicks' business operations (sales outreach, engineering tasks, social media) via Telegram, with human-in-the-loop approvals before any external action. Every design decision is documented, tested, and explainable.

**Stack:** Node.js 22 + TypeScript 5.5 (strict) + LangGraph 0.2 + Vercel AI SDK + grammy + drizzle-orm + PostgreSQL

---

## System Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    GATEWAY LAYER                         │
│          Telegram Bot (grammy) — topic-based routing     │
│          HITL callbacks — inline keyboard approve/reject │
├──────────────────────────────────────────────────────────┤
│                     BRAIN LAYER                          │
│  CEO Supervisor → routes to department pod               │
│  ┌──────────┐ ┌────────────┐ ┌───────────┐ ┌────────┐  │
│  │  Sales   │ │Engineering │ │ Marketing │ │ Social │  │
│  │   Pod    │ │    Pod     │ │    Pod    │ │  Pod   │  │
│  └──────────┘ └────────────┘ └───────────┘ └────────┘  │
│  Each pod: Generator → Critic → [HITL] → Action         │
├──────────────────────────────────────────────────────────┤
│                    INFRA LAYER                           │
│  LLM Cascade + Circuit Breakers + Rate Limiter          │
│  Token Optimizer + Context Manager + Logger             │
├──────────────────────────────────────────────────────────┤
│                   MEMORY LAYER                           │
│  PostgreSQL — checkpoints + audit_log + llm_costs       │
│  LangGraph checkpointer — every run is resumable        │
└──────────────────────────────────────────────────────────┘
```

---

## Phase Status

| Phase | Description | Status |
|-------|-------------|--------|
| **1A** | Foundation — config, types, DB schema, infra | ✅ Complete |
| **1B** | Brain — supervisor, pods, critic, token optimization | ✅ Complete |
| **1C** | Gateway — Telegram bot, HITL callbacks | ⏳ Next |
| **1D** | Tests + evals + CI pipeline | 🔄 In progress |

---

## Complete File Inventory

### `src/core/` — Pure Business Logic (zero external deps)

| File | What It Does |
|------|-------------|
| `registry.ts` | Single source of truth for all agents + companies. 25 agents, 3 companies (Turicks, Naggar, cross-company). Registry-driven routing prevents hardcoded strings. |
| `prompts.ts` | All system prompts, versioned and centralized. CEO prompt auto-populates with agent list from registry. |
| `config.ts` | Zod-validated env vars + model cascade tiers + budget limits. All provider config in one place. |

### `src/agents/` — The Brain (LangGraph state machines)

| File | What It Does |
|------|-------------|
| `state.ts` | ALL LangGraph Annotation schemas in one file. `FounderState` (root), `SalesState`, `EngineeringState`, `MarketingState`, `SocialState` + shared interfaces (`LeadProfile`, `CritiqueRecord`, `HITLRecord`, `AccountWarmingConfig`, `SocialPost`). |
| `graph.ts` | Main `FounderGraph` compiled ONCE at module load. Uses `makePodNode()` factory — eliminates copy-paste wrapper nodes. Routes CEO decision to 4 department pods. |
| `supervisor.ts` | CEO node — classifies task, resolves department via registry lookup + keyword heuristics. Includes `_resolveDepartment()` (exported, unit tested). Budget check before every CEO call. |
| `critic.ts` | Cross-model critic node. Generator uses Gemini, Critic uses Claude — different families prevent sycophancy. Writes `CritiqueRecord` to state (append-only). Exported `afterCriticEdge()` pure routing function. |
| `pods/sales.ts` | Full sales pipeline: `lead_intel → bdr → critic → [HITL] → finalize`. Lead profiling, email drafting, 2-revision loop. |
| `pods/engineering.ts` | Engineering pipeline: `spec_writer → senior_dev → qa_tester → critic → [HITL] → finalize`. Code review built in. |
| `pods/marketing.ts` | Marketing pipeline: `trend_researcher → content_writer → critic → [HITL] → finalize`. |
| `pods/social.ts` | Social media pipeline with LinkedIn safety: `content_researcher → post_writer → critic → [HITL] → publisher`. Includes account warming schedule (4-week ramp), circuit breaker, idempotency guard. |

### `src/infra/` — Infrastructure

| File | What It Does |
|------|-------------|
| `llm.ts` | Provider cascade with circuit breakers (opossum) + rate limiter (bottleneck). Tries providers in order, trips after 3 failures, resets after 5 min. Cost recording after every call. `isBreakerOpen()` exported for observability. |
| `token-optimizer.ts` | Pure text processing utilities. `estimateTokens`, `stripMarkdown`, `truncateToTokenBudget` (4 strategies), `prepareForLlm` (full pipeline), `parseJsonSafe`, `extractStateFields`. ~75% context token reduction in practice. |
| `context-manager.ts` | Context window management. `trimMessageHistory` (sliding window), `buildSystemContext` (compact system prompt builder), `serializeStateForPrompt` (priority-ordered state serialization), `computePromptBudget` (10/25/65 allocation). |
| `checkpointer.ts` | `TenantAwareCheckpointer` wrapping LangGraph's `PostgresSaver`. Thread ID format: `{tenant}:{user}:{runId}`. Every run is resumable from DB. |
| `logger.ts` | Pino structured logging. `childLogger({ module })` for scoped logs. JSON in prod, pretty-print in dev. |
| `telemetry.ts` | LangSmith tracing init + PII scrubber (strips emails, phone numbers, API keys from traces). |

### `src/db/` — Data Layer

| File | What It Does |
|------|-------------|
| `schema.ts` | All Drizzle-ORM table definitions: `interrupt_registry`, `llm_costs`, `audit_log`, `tenant_skills`. Multi-tenant from day 1. |
| `client.ts` | Connection singleton — `postgres.js` for queries, `pg.Pool` for LangGraph checkpointer. Single connection setup. |
| `queries.ts` | Named, typed query functions: `logLlmCost`, `getTodayCostUsd`, `hasBeenAudited`, `writeAuditEntry`, `createInterrupt`, `resolveInterrupt`. No raw SQL outside this file. |

### `src/gateway/` — How Humans Interact

| File | What It Does |
|------|-------------|
| `hitl.ts` | HITL interrupt lifecycle: `requestHITL()` writes `interrupt_registry` row BEFORE calling LangGraph `interrupt()` (crash-safe). TTL expiry built in. |
| `telegram.ts` | grammy bot with topic routing (Boardroom → CEO, department topics → direct pod). `callback_query` handler resolves HITL via interrupt_id. HTML-safe message formatting. |

### `src/tools/` — Agent Capabilities

| File | What It Does |
|------|-------------|
| `index.ts` | Tool registry. `registerTool()` + `getTool()` + `getToolsForAgent()` (filters by `allowed_tools` from registry). |
| `web-search.ts` | Tavily/Brave search implementation. Returns typed `SearchResult[]`. Respects `max_results` per agent config. |

---

## Agent Inventory (25 Agents, 3 Companies)

### Turicks AI Agency

| Agent | Department | Model Tier | What It Does |
|-------|-----------|------------|-------------|
| `lead_intel` | Sales | `local` | ICP scoring, pain point extraction, LinkedIn research |
| `bdr` | Sales | `md` | Cold email/DM drafting from lead profile |
| `proposal_writer` | Sales | `md` | Full proposal writing from meeting notes |
| `bidding_sniper` | Sales | `code` | Upwork/Freelancer bid automation |
| `outreach_agent` | Sales | `md` | Multi-channel outreach sequencing |
| `pipeline_md` | Sales | `nano` | CRM pipeline updates in markdown |
| `senior_dev` | Engineering | `code` | Code architecture, PR reviews, complex debugging |
| `vibe_coder` | Engineering | `local` | Rapid prototyping, boilerplate generation |
| `qa_tester` | Engineering | `local` | Test writing, bug reproduction |
| `github_agent` | Engineering | `md` | Issue triage, PR descriptions, code review comments |
| `scrum_engine` | Engineering | `nano` | Sprint planning, ticket breakdown |
| `web_designer` | Marketing | `md` | Landing page copy, component descriptions |
| `seo_specialist` | Marketing | `deep_research` | SEO audits, keyword research, meta optimization |
| `vibe_designer` | Marketing | `md` | Visual design briefs, Figma prompts |
| `social_researcher` | Social | `deep_research` | Trend analysis, competitor research, engagement data |
| `social_handler` | Social | `md` | LinkedIn/Twitter/Instagram post writing |
| `platform_growth` | Social | `md` | Platform growth strategy, content calendar |
| `linkedin_growth` | Social | `deep_research` | LinkedIn-specific growth analysis |
| `ops_agent` | — | `nano` | Internal ops automation |
| `kb_agent` | — | `local` | Knowledge base Q&A |
| `video_editor` | — | `md` | Video script editing, caption generation |

### Naggar Retreat (Himalayan Farm)

| Agent | Department | Model Tier | What It Does |
|-------|-----------|------------|-------------|
| `farm_weather` | — | `local` | Weather-based farming decisions |
| `yield_scout` | — | `local` | Crop yield analysis |
| `booking_concierge` | — | `nano` | Guest booking management |
| `culinary_agent` | — | `local` | Menu planning from seasonal inventory |
| `market_scout` | — | `deep_research` | Organic market pricing research |
| `guest_crm` | — | `local` | Guest relationship management |
| `naggar_kb` | — | `local` | Farm knowledge base |

### Cross-Company

| Agent | Department | Model Tier | What It Does |
|-------|-----------|------------|-------------|
| `cost_watchdog` | — | `nano` | Daily LLM cost alerting, budget enforcement |
| `team_therapist` | — | `nano` | Team health check-ins, retrospective facilitation |
| `hr_agent` | — | `md` | HR policy Q&A, onboarding automation |
| `revenue_scout` | — | `deep_research` | Revenue intelligence, competitor pricing |
| `scrum_pm` | — | `md` | Cross-team project coordination |

---

## LLM Provider Cascade

| Tier | Primary | Fallback 1 | Fallback 2 | Use Case |
|------|---------|-----------|-----------|----------|
| `ceo` | claude-sonnet-4-5 | gemini-2.5-pro | gemini-flash | Task classification (most important) |
| `deep_research` | gemini-2.5-pro | gemini-flash | deepseek-r1:free | Market research, SEO audits |
| `md` | gemini-flash | claude-haiku-4-5 | llama-70b:free | General writing (most common) |
| `code` | lmstudio/qwen | qwen3-coder:free | gemini-flash | Code generation |
| `nano` | gemini-flash-lite | claude-haiku-4-5 | — | Simple tasks, high volume |
| `local` | lmstudio/qwen | gemini-flash-lite | — | Dev/testing, free tier ops |

**Resilience:** opossum circuit breakers per provider — trips at 3 failures, resets at 5 min. Bottleneck rate limiter — max 5 concurrent, 200ms between requests.

---

## Database Schema

Four tables, all multi-tenant from day 1:

```
interrupt_registry   — HITL state machine (pending/approved/rejected/expired)
llm_costs            — Per-call cost tracking (model, tokens_in, tokens_out, cost_usd)
audit_log            — Idempotency log for external actions (email, publish, GitHub)
tenant_skills        — Company-specific tool configurations
```

LangGraph uses a separate `checkpoints` table managed by `@langchain/langgraph-checkpoint-postgres`.

---

## Key Engineering Patterns

### 1. Registry-Driven Architecture
No hardcoded strings. Every agent, company, and routing decision references `registry.ts`. Adding a new agent = 1 file change, not 5.

### 2. Compiled-Once Graph
`getGraph()` returns a singleton. The StateGraph is compiled at startup, not per request. Eliminates 200ms overhead per Telegram message.

### 3. Critic Anti-Sycophancy
Generator uses Gemini family, Critic uses Claude family. Cross-model evaluation catches issues the generator would overlook (it's critiquing its own output). This is the same approach used in Constitutional AI.

### 4. DB-Backed HITL
`interrupt_registry` row is written BEFORE LangGraph's `interrupt()` is called. If the process crashes between the write and the interrupt call, the Telegram bot can recover on restart by querying for pending interrupts.

### 5. Idempotency Guard
Every external action (email send, LinkedIn publish, GitHub PR) checks `audit_log` before executing. Re-running a crashed workflow never sends a duplicate email.

### 6. Account Warming (LinkedIn Safety)
4-week ramp schedule: 1/2/4/7/uncapped posts per week. Based on LinkedIn automation community best practices (Phantombuster, Expandi guidelines). The publisher node hard-blocks when the limit is reached.

---

## Test Coverage

```
tests/
├── unit/
│   ├── supervisor.test.ts     — 41 tests, _resolveDepartment all edge cases
│   ├── critic.test.ts         — Critique parsing, rule violation extraction  
│   ├── state.test.ts          — Annotation reducer behavior
│   └── token-optimizer.test.ts — Pure function coverage
├── e2e/
│   └── local-model.test.ts    — 28 tests (pure logic always runs, LM Studio 
│                                 tests auto-skip if not running)
└── integration/
    └── sales-flow.test.ts     — Full pod execution with mock LLM
```

**Philosophy:** E2E tests use the `local` cascade tier (LM Studio, `http://localhost:1234`). Zero cloud API cost for CI. Tests auto-skip with a console message if LM Studio isn't running — no hard failures on CI.

---

## What's Coming (Phase 1C+)

- **Telegram bot** — grammy integration, topic routing, HITL keyboard callbacks
- **Composio LinkedIn publish** — replacing Phase 1B stub with real OAuth publishing
- **Subgraph checkpointing** — pod subgraphs get checkpointers for mid-pod recovery
- **LangSmith dashboards** — trace visualization, token cost attribution per agent
- **Naggar Retreat workflows** — booking management, yield analysis pipelines
- **Vector memory** — ChromaDB for persistent lead profiles and content history
