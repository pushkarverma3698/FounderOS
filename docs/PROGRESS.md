# FounderOS — Progress & Journey Document

> **Last updated:** 2026-05-31  
> **Status:** Phases 1–4 complete · **Phase 5 (live test + reliability hardening) complete** — see [`docs/PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md) and [`docs/phases/PHASE-5-LIVE-TEST-HARDENING.md`](phases/PHASE-5-LIVE-TEST-HARDENING.md)
>
> **Phase 5 headline:** drove the live cloud cascade with real CEO tasks for <$0.04 and fixed ship-blockers — a fresh `setup-db.ts` was producing a broken DB (migration journal drift → dead cost tracking), and Gemini-only CEO routing returned empty (reasoning model + tight token cap). Both fixed; routing now reliable, graph degrades instead of crashing, anti-sycophancy restored. Non-live tests: **210 passing**. Added `/health`+`/metrics`, `LICENSE` (MIT), `CONTRIBUTING.md`.

---

## What Is FounderOS?

A multi-agent AI operating system that runs Turicks' business operations via a Telegram interface. Dual purpose:
- **Operational**: Real-time sales outreach, engineering task routing, marketing automation for Turicks
- **Portfolio**: Production-grade TypeScript + LangGraph architecture demo for hiring managers

Core flow: Telegram message → Supervisor (CEO) → Department Pod → Agent nodes → HITL approval → External action

---

## What We've Built (The Complete Picture)

### ✅ Phase 1A — Foundation

Everything needed before a single LLM call can happen.

| File | What It Does |
|------|-------------|
| `src/core/registry.ts` | Company profiles (Turicks) + all agent definitions + cascade tier assignments |
| `src/core/config.ts` | Model cascade tiers (CEO/MD/nano/code/local), env validation with Zod, budget limits |
| `src/core/prompts.ts` | All system prompts — CEO supervisor, BDR, ICP scorer, critic, content topics array |
| `src/agents/state.ts` | All LangGraph Annotation schemas — FounderState, SalesState, ProspectingState + interfaces |
| `src/db/schema.ts` | 7 Drizzle tables with clean names (see below) |
| `src/db/client.ts` | Postgres connection singleton (postgres.js + pg pool) |
| `src/infra/checkpointer.ts` | TenantAwareCheckpointer — thread ID = `{tenant}:{user}:{run}` |
| `src/infra/llm.ts` | LLM cascade executor — circuit breakers (opossum), rate limiter (bottleneck), cost logging |
| `src/infra/logger.ts` | Pino structured logging with child loggers |
| `src/infra/telemetry.ts` | LangSmith init + PII scrubber (strips emails, phone numbers before traces) |
| `docker/Dockerfile` | Node 22 Alpine multi-stage build |
| `docker/docker-compose.yml` | App + Postgres (+ Redis from 2A) |

**Database tables (after Phase 2D rename):**

| Table | Purpose |
|-------|---------|
| `hitl_approvals` | HITL approval queue — every interrupt() call writes here first |
| `ai_call_costs` | Per-call token + cost tracking (write after every LLM response) |
| `action_log` | Idempotency guard — check before every external action |
| `outbound_leads` | Outbound prospect state machine (researching → sent → replied → won/lost) |
| `do_not_contact` | GDPR/CAN-SPAM list — suppression by email or domain |
| `agent_results` | Agent self-improvement data (Phase 3 foundation) |
| `dept_signals` | Cross-department durable signals (Phase 3 foundation) |

---

### ✅ Phase 1B — Brain (Agent Graphs)

| File | What It Does |
|------|-------------|
| `src/agents/supervisor.ts` | CEO node — classifies task → routes to sales/engineering/marketing via `Command({ goto })` |
| `src/agents/critic.ts` | Critic NODE (side effects: writes CritiqueRecord) — Claude critiques Gemini output |
| `src/agents/pods/sales.ts` | Full sales pod: `lead_intel → suppression_check → quota_check → bdr → critic → [HITL] → finalize` |
| `src/agents/pods/engineering.ts` | Engineering pod stub (compiles, returns placeholder, ready for Phase 2E) |
| `src/agents/pods/marketing.ts` | Marketing pod stub (same) |
| `src/agents/graph.ts` | Main FounderGraph compiled ONCE at module load — never per request |
| `src/tools/web-search.ts` | Tavily search via @langchain/community TavilySearchResults |
| `src/tools/index.ts` | Tool registry with `registerTool()` + `getTools()` |

**Key architecture patterns in place:**
- **Supervisor routing**: CEO tier (Claude Sonnet) classifies task → `Command({ goto: dept })`
- **Critic pattern**: Generator (Gemini) → Critic (Claude) — different families prevent sycophancy
- **Max revisions**: `revision_count < max_revisions (2)` → back to generator; else → HITL with escalation note
- **HITL guard**: Every interrupt() call is DB-backed. Process crash between write and call is safe.

---

### ✅ Phase 1C — Gateway (Telegram + HITL)

| File | What It Does |
|------|-------------|
| `src/gateway/telegram.ts` | grammy bot — topic routing, `/prospect` cmd, HITL callback_query handler |
| `src/gateway/hitl.ts` | HITL interrupt lifecycle — `createInterrupt()`, `sendApprovalMessage()`, `resolveFromCallback()` |
| `src/index.ts` | Entry point — compile graph, start bot, init scheduler, SIGTERM drain |

**Telegram topic routing:**
- Boardroom topic → CEO supervisor
- Sales topic → Direct to sales pod
- HITL approval messages → inline keyboard with approve/reject/edit buttons

---

### ✅ Phase 1D — Tests

**88 unit + integration tests** across:
- State reducer behaviour
- Cascade fallback logic
- Idempotency check
- Suppression + quota pure edges
- Full sales flow with MockLLMProvider
- HITL lifecycle
- Social pod warming schedule

---

### ✅ Phase 2A — Redis + Caching Layer

| File | What It Does |
|------|-------------|
| `src/infra/redis.ts` | ioredis singleton + KEYS helpers (`research:`, `quota:`, `llm:`) |

**Three Redis use cases:**
1. **Research cache** — `research:{md5(url)}` TTL 7d — avoids re-scraping same company
2. **Send quota** — `quota:{tenant}:{YYYY-MM-DD}` atomic INCR + auto-expiry at midnight
3. **LLM prompt cache** — `llm:{sha256(prompt)}` TTL by tier (CEO=0, MD=3600, NANO=86400)

**Why Redis not Postgres for these:**
- TTL is native to Redis — no cleanup jobs needed
- Atomic INCR for quota is race-condition-safe (Postgres would need transactions)
- Prompt cache needs configurable per-tier TTL — trivial with SETEX

---

### ✅ Phase 2B — ProspectingPod

| File | What It Does |
|------|-------------|
| `src/agents/pods/prospecting.ts` | Full subgraph: disambiguate → research → icp_score → route_by_score |
| `src/agents/state.ts` | Added ProspectingState Annotation schema |
| `src/core/registry.ts` | Added agent defs: disambiguate, prospecting_researcher, icp_scorer |
| `src/core/prompts.ts` | Research prompt, ICP scoring prompt, 12-topic content rotation array |
| `src/gateway/telegram.ts` | `/prospect <url>` command handler |

**ProspectingPod flow:**
```
/prospect acme.com
    ↓
disambiguate_node (NANO tier) — extract canonical URL + company name
    ↓
research_node (NANO tier) — Redis-first: check cache → miss → Tavily → cache 7d
    ↓
icp_score_node (MD tier) — score 0.0–1.0, rationale, budget signal
    ↓
route_by_score (pure edge, no LLM):
  < 0.4   → disqualified (daily digest via Telegram)
  0.4–0.7 → SalesPod with tier: "md"
  ≥ 0.7   → SalesPod with tier: "ceo"
```

**Banded ICP scoring:**
- Below 0.4: Consumer apps, no-code-only, B2C, no budget signal → disqualify, log in daily digest
- 0.40–0.69: Mid-market fit → MD tier outreach (Gemini Flash)
- 0.70–1.0: Strong ICP → CEO tier (Claude Sonnet)

---

### ✅ Phase 2C — Safety Rails + LinkedIn + Scheduler

| File | What It Does |
|------|-------------|
| `src/agents/pods/sales.ts` | Added `suppression_check` (pure edge) + `quota_check` (pure edge) before BDR |
| `src/tools/linkedin.ts` | LinkedIn post + comment via Composio |
| `src/infra/scheduler.ts` | 3 cron jobs: LinkedIn Mon/Wed/Fri 9am, Gmail reply poller */15, HITL sweeper hourly |

**Safety rails before every outbound send:**
```
lead_intel → suppression_check → quota_check → bdr → critic → [HITL] → finalize
                     ↓                  ↓
              suppressed?          quota_exceeded?
              → log + stop          → log + stop
```

Both edges are PURE functions (no side effects, no LLM) — they're fast and testable.

**Scheduler jobs (node-cron, NOT graph nodes — by design):**
1. LinkedIn poster — Mon/Wed/Fri 9am CET, round-robin content topics, idempotency via `action_log`
2. Gmail reply poller — every 15 minutes (Phase 2C stub, Phase 3 wires Gmail Composio)
3. HITL sweeper — every hour, expires stale pending interrupts (marks as `expired`, could update lead stage)

---

### ✅ Table Renaming (Phase 2D Partial)

All 7 Postgres tables renamed from implementation-detail names to clear business names:

```
interrupt_registry → hitl_approvals    (what it is, not implementation detail)
llm_costs          → ai_call_costs     (AI calls, not just LLMs; future-proof)
audit_log          → action_log        (actions logged, not just audits)
lead_pipeline      → outbound_leads    (outbound direction is important)
suppression_list   → do_not_contact    (regulatory clarity — GDPR/CAN-SPAM language)
task_outcomes      → agent_results     (agent output, not just task completion)
dept_events        → dept_signals      (signals are richer than events)
```

Migration: `drizzle/0001_rename_tables.sql` (ALTER TABLE RENAME — no data loss)
Backwards aliases remain in `src/db/schema.ts` for external scripts during transition.

---

### ✅ Local Model (Ollama Modelfile)

| File | What It Does |
|------|-------------|
| `docker/Modelfile.founderos` | Custom Qwen2.5:7b with deterministic params + FounderOS system prompt |

**Model parameters:**
- Base: `qwen2.5:7b` (4.7GB, fast inference)
- `temperature: 0.1` — near-deterministic JSON output
- `num_ctx: 8192` — fits full system prompt + research + draft in one context
- `top_p: 0.9` — conservative nucleus sampling
- `num_predict: 2048` — enough for emails + analysis, prevents runaway
- `repeat_penalty: 1.1` — prevents repetitive phrasing in drafts
- Stop tokens: `<|im_end|>`, `<|im_start|>`, `<|endoftext|>` — **NOT decorative**, ChatML turn boundary tokens

**Build:** `ollama create founderos -f docker/Modelfile.founderos`

---

## E2E Journey Test Results (2026-05-27)

Run: `pnpm test tests/e2e/founderos-journey.test.ts`

| Task | Result | Notes |
|------|--------|-------|
| Ping | ✅ | Perfect JSON, 19s first cold call |
| Disambiguate | ✅ (partial) | Company name ✅, URL = null ⚠️ |
| ICP Score (Linear) | ✅ | Score 0.85 → ceo tier, good rationale |
| ICP Score (FitTrack) | ✅ | Score 0.3 → disqualified, correct reason |
| BDR Draft (Raycast) | ✅ | Personalised, references Raycast specifically |
| Classify (3 tasks) | ✅ | sales/engineering/marketing all routed correctly |
| Critic (weak email) | ✅ | NEEDS_REVISION, violations listed |
| Mini pipeline (3 steps) | ✅ | Disambiguate → ICP → BDR in 13.8s |

**Observed limitation:** Disambiguate returns `company_url: null` for informal company names ("framer", "vercel"). The model identifies the company but doesn't synthesise the URL without explicit research data. This is expected — in the real pipeline, `research_node` does a Tavily search which provides the canonical URL.

---

## What's Remaining

### 🔄 Phase 2D — Observability + Docs (In Progress)

| Task | Status | Notes |
|------|--------|-------|
| Add `lead_id` column to `ai_call_costs` | ⏳ | Enables per-lead cost attribution |
| Update `docs/architecture.md` | ⏳ | Add Redis layer + outbound pipeline path |
| Update `study/` files | ⏳ | Redis vs Postgres matrix, prospecting flow |
| Table rename migration applied to DB | ⏳ | Run `psql -f drizzle/0001_rename_tables.sql` |

### ⏳ Phase 2E — Engineer Agents Per Department

Each department pod needs an engineer agent as the first node — responsible for autonomous decisions.

| Agent | Department | Role |
|-------|-----------|------|
| `eng_engineer` | Engineering | Technical decision-making, architecture, code review |
| `sales_engineer` | Sales | Outreach strategy, ICP interpretation, pricing |
| `mktg_engineer` | Marketing | Content strategy, channel selection, brand voice |

**Design:** Engineer agents operate autonomously. HITL gates only outbound sends (email, LinkedIn, GitHub push). Never route to HITL for internal analysis or draft generation.

Files to create/modify:
- `src/core/registry.ts` — add 3 agent defs
- `src/core/prompts.ts` — add 3 decision-focused system prompts
- `src/agents/pods/sales.ts` — wire `sales_engineer` before `lead_intel`
- `src/agents/pods/engineering.ts` — implement with `eng_engineer` as first node
- `src/agents/pods/marketing.ts` — implement with `mktg_engineer` as first node

### ⏳ Phase 3A — Two-Phase LLM Execution

Split `callCascade` into:
- `runPlanner(tier, messages)` — cloud LLM, NO tools, returns structured JSON plan `{ steps: [{tool, args}][] }`
- `runToolExecutor(tool, args)` — local Qwen3 via LM Studio, ONE tool per call, Zod validates output

**Cost impact:** ~70% reduction. Code-tier cloud calls replaced by local inference.

### ⏳ Phase 3B — Self-Improvement Loop

After every task (in pod finalize nodes):
1. Write to `agent_results` table — outcome, decision_summary, tools_used, cost_usd, latency_ms
2. Write to turicks-brain MCP — `add_turicks_note` with insight
3. At execution time (NOT compile time): inject top 3 succeeded + 1 failed as few-shot examples

**Goal:** Agents improve with each task. Critic feedback becomes training signal.

### ⏳ Phase 3C — Cross-Department Signals

- `departmentSignals` append-only channel in `FounderState` (ephemeral, bounded to 50)
- `dept_signals` Postgres table (durable, persists across runs)
- Supervisor inspects `departmentSignals` after each pod completes
- Scheduler polls `dept_signals WHERE consumed=false` every 5 minutes

**Example wiring:** Sales `sent` event → Engineering pod auto-starts technical scoping if payload has tech requirement.

---

## Known Technical Debt

| Issue | Severity | Fix |
|-------|---------|-----|
| Engineering + marketing pods are stubs | Medium | Phase 2E |
| Gmail reply poller is a stub | Low | Phase 2C is wired but needs Composio Gmail auth |
| `lead_id` FK missing on `ai_call_costs` | Low | Phase 2D task |
| Disambiguate doesn't resolve URL without search | Low | Real pipeline uses Tavily; local-only limitation |
| CEO prompt cache TTL = 0 — no cache | By design | Decisions must always be fresh |
| Backwards-compat aliases in schema.ts | Cleanup | Remove after all scripts migrated (Phase 3) |

---

## Key Architecture Decisions (Summary)

| Decision | Choice | Rejected |
|----------|--------|---------|
| Agent framework | LangGraph JS | Custom state machine |
| ORM | drizzle-orm | Prisma |
| Telegram | grammy | Telegraf, node-telegram-bot-api |
| Local LLM | Ollama (founderos:latest) | LM Studio only |
| Caching | Redis | Postgres tables for ephemeral data |
| HITL | DB-backed + Telegram inline keyboard | In-memory only |
| Tracing | LangSmith (auto via LANGCHAIN_API_KEY) | Manual logging only |
| Critic pattern | Different model family (Gemini gen, Claude critic) | Same model self-critique |
| Scheduler | node-cron in infra layer | LangGraph sleeping nodes (antipattern) |
| Multi-tenancy | `tenant_id` on every table | Schema-per-tenant |

---

## Running the System Today

```bash
# Prerequisites
docker compose up -d postgres redis
ollama pull qwen2.5:7b
ollama create founderos -f docker/Modelfile.founderos

# Setup DB
pnpm install
cp .env.example .env   # fill in: TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY
npx tsx scripts/setup-db.ts

# Start
npx tsx src/index.ts

# In Telegram: /prospect https://linear.app
# → Researches Linear → ICP scores → drafts outreach → sends HITL approval to you

# Run all tests
pnpm test

# Run E2E journey test (needs Ollama)
pnpm test tests/e2e/founderos-journey.test.ts
```

---

## Timeline & Velocity

| Phase | Complexity | Status |
|-------|-----------|--------|
| 1A Foundation | High (all config + types) | ✅ Done |
| 1B Brain | High (LangGraph graphs) | ✅ Done |
| 1C Gateway | Medium (Telegram + HITL) | ✅ Done |
| 1D Tests | Medium (88 tests) | ✅ Done |
| 2A Redis | Low | ✅ Done |
| 2B ProspectingPod | High | ✅ Done |
| 2C Safety + Scheduler | Medium | ✅ Done |
| 2D Observability | Low | 🔄 60% done |
| 2E Engineer Agents | Medium | ⏳ Next |
| 3A Two-phase LLM | High | ⏳ Future |
| 3B Self-improvement | High | ⏳ Future |
| 3C Cross-dept signals | Medium | ⏳ Future |
