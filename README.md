# FounderOS

**A multi-agent AI operating system that runs a one-man company — and documents every decision for engineering interviews.**

Built with: Node.js 22 · TypeScript 5.5 (strict) · LangGraph JS · Native fetch (no SDK bloat) · grammy · drizzle-orm · PostgreSQL · Redis

> **Status:** Production-grade. 128 tests across unit, integration, and live suites. Running against Ollama locally and OpenRouter free tier in the cloud.

---

## What It Does

A founder types a task in Telegram. FounderOS handles the rest:

1. **Supervisor** (CEO tier) classifies the task and routes to the right department — Sales, Engineering, Marketing, or Prospecting
2. **Specialist agents** generate the output (cold email, technical plan, LinkedIn post)
3. **Critic** (different model family — prevents sycophancy) gates quality against department rules
4. **Human approval** via Telegram inline keyboard — nothing leaves the system without sign-off
5. **Finalize** executes the action, writes to audit log (idempotency guard), and records the outcome for self-improvement

Every state transition is checkpointed to PostgreSQL. A crash mid-workflow resumes from the last saved point.

```
Telegram message
      │
      ▼
┌─────────────────┐
│   Supervisor    │  classifies task type
└────────┬────────┘
    ┌────┴─────┬──────────┬──────────┐
    ▼          ▼          ▼          ▼
ProspectingPod  SalesPod  EngPod  MktgPod
    │
    ▼
ICP Score
 < 0.4 → disqualified
0.4–0.7 → MD tier outreach
 ≥ 0.7 → CEO tier outreach
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      GATEWAY LAYER                          │
│   grammy Telegram bot — /prospect, HITL inline keyboards    │
│   Topic routing (Sales/Eng/Mktg/Boardroom)                  │
└─────────────────────────────┬───────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│                       BRAIN LAYER                           │
│   LangGraph StateGraph — Supervisor + 4 Department Pods     │
│   Generator → Critic loop (cross-model, no sycophancy)      │
│   interrupt() for durable HITL · PostgreSQL checkpointing   │
└─────────────────────────────┬───────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│                      LLM EXECUTION                          │
│   callCascade(): native fetch — no SDK layer                │
│   Tier-based fallback: CEO→MD→nano→code→local               │
│   Key-skip guard: zero HTTP calls when provider key absent  │
│   opossum circuit breakers · bottleneck rate limiters       │
└─────────────────────────────┬───────────────────────────────┘
                              │
┌──────────────┬──────────────▼──────────────┬────────────────┐
│  TOOLS LAYER │     CACHING LAYER (Redis)    │  MEMORY LAYER  │
│  Firecrawl   │  research: TTL 7d            │  PostgreSQL 16 │
│  Gmail/Drive │  quota: INCR + auto-expire   │  7 tables      │
│  LinkedIn    │  llmCache: tier-based TTL    │  Checkpoints   │
│  GitHub      │                              │  task_outcomes │
└──────────────┴──────────────────────────────┴────────────────┘
```

---

## Key Design Decisions

| Problem | Solution | Where |
|---------|----------|-------|
| Agent hallucination / quality drift | Cross-model critic: generator (Gemini family) vs critic (Claude family) | [ADR-003](docs/decisions/003-critic-pattern.md) |
| HITL crash recovery | `interrupt_registry` DB row written BEFORE calling LangGraph `interrupt()` | [ADR-004](docs/decisions/004-why-telegram-hitl.md) |
| Wasted LLM calls on missing keys | `hasProviderKey()` skips providers before circuit breaker check — zero 401s | `src/infra/llm.ts` |
| Duplicate external actions | `audit_log` idempotency key with `UNIQUE` constraint — checked before every send | `src/db/queries.ts` |
| LLM outage resilience | Provider cascade + opossum circuit breakers (50% error threshold → 10s cooldown) | `src/infra/llm.ts` |
| Cold email cost per lead | `llm_costs.lead_id` FK — every token billed to the lead that caused it | `src/db/schema.ts` |
| Repeated research on same domain | Redis `research:{md5(url)}` TTL 7d — Firecrawl hit once per week per domain | `src/infra/redis.ts` |
| Agent self-improvement | `task_outcomes` table + few-shot injection into system prompts at execution time | `src/db/queries.ts` |
| Cross-department coordination | `departmentSignals` in LangGraph state (ephemeral) + `dept_signals` table (durable) | `src/agents/state.ts` |
| SDK abstraction overhead | Native fetch `callAnthropic()` / `callGoogle()` / `callOpenAICompat()` — 30 MB lighter | `src/infra/llm.ts` |

---

## Tech Stack

| Concern | Package | Why |
|---------|---------|-----|
| Agent orchestration | `@langchain/langgraph@^0.2` | Durable `interrupt()`, PostgreSQL checkpointing, `Command({ goto })` routing |
| LLM execution | Native `fetch` (no SDK) | Direct REST — eliminated 8× `as unknown as BaseChatModel` casts, ~30 MB deps |
| Telegram bot | `grammy@^1` | TypeScript-first, inline keyboards, excellent DX |
| ORM | `drizzle-orm@^0.38` | Schema IS TypeScript types — zero codegen |
| Circuit breaker | `opossum@^8` | Per-model fault isolation |
| Rate limiting | `bottleneck@^2` | Separate cloud (5 concurrent) vs local (1 concurrent, 500ms) limiters |
| Redis | `ioredis@^5` | Research cache, send quotas, LLM prompt cache |
| Logging | `pino@^9` | Structured JSON + PII redaction |
| Observability | `langsmith@^0.2` | Per-node trace, token counts, latency |
| Validation | `zod@^3` | Type-safe env vars + external API responses |
| Web search | Firecrawl REST API | Fail-open, 5 search results, Redis-cached |
| Testing | `vitest@^3` | 128 tests across unit / integration / live suites |

---

## Model Cascade

| Tier | Use case | Primary | Fallback 1 | Fallback 2 |
|------|----------|---------|------------|------------|
| CEO | Supervisor routing, critical decisions | claude-sonnet-4-5 | gemini-2.5-pro | llama-70b (free) |
| deep_research | Market research, ICP rationale | deepseek-r1 (free) | gemini-flash | — |
| md | Draft generation, analysis | gemini-2.0-flash | claude-haiku-4-5 | llama-70b (free) |
| code | Technical plans, code generation | LM Studio (local) | qwen3-coder (free) | gemini-flash |
| nano | Quick classifications, summaries | gemini-flash-lite | claude-haiku-4-5 | — |
| local | Offline-first tasks | LM Studio (Ollama) | — | — |
| critic | Quality gating | claude-haiku-4-5 | llama-70b (free) | — |

**Key-skip guard:** if `ANTHROPIC_API_KEY` is absent, all `anthropic` entries are skipped before any HTTP call — cascade jumps straight to the next provider. No wasted 401s.

---

## Agents

All definitions in `src/core/registry.ts`. Each declares cascade tier, allowed tools, and memory collections.

**Turicks (AI Agency):**
`supervisor` · `lead_intel` · `sales_engineer` · `bdr` · `critic` · `eng_engineer` · `senior_dev` · `vibe_coder` · `qa_tester` · `mktg_engineer` · `seo_specialist` · `web_designer` · `content_writer` · `social_handler` · `ops_agent`

**ProspectingPod:**
`disambiguate` · `prospecting_researcher` · `icp_scorer`

**ICP Scoring bands:**
- `< 0.4` → disqualified (daily digest, no outreach)
- `0.4–0.7` → MD tier outreach (Gemini Flash)
- `≥ 0.7` → CEO tier outreach (Claude Sonnet)

---

## Self-Improvement Loop

After every completed task, all pod finalize nodes:
1. Write to `task_outcomes` table: agent_id, outcome, decision_summary, tools_used, cost_usd, latency_ms
2. At next execution: top 3 successful + 1 failed outcome injected as few-shot examples into system prompt

This means the BDR agent learns from past cold emails that got approved vs rejected. The ICP scorer learns from which companies converted. No manual prompt tweaking.

---

## Running Locally

**Prerequisites:** Node.js 22, pnpm, Docker, Ollama (optional for local LLM)

```bash
# 1. Clone and install
git clone https://github.com/pushkarverma3698/FounderOS.git
cd founderos
pnpm install

# 2. Configure
cp .env.example .env
# Minimum: TELEGRAM_BOT_TOKEN + OPENROUTER_API_KEY (free tier works)

# 3. Start infrastructure
docker compose -f docker/docker-compose.yml up postgres redis -d

# 4. Run migrations
npx tsx scripts/setup-db.ts

# 5. Start
npx tsx src/index.ts
```

**Run tests:**
```bash
# Fast — unit + integration (no Ollama needed, ~3s)
npx vitest run --exclude "tests/e2e/**" --exclude "tests/live/**"

# Live — full one-man-company test (needs Ollama, ~13 min)
pnpm test tests/live/one-man-company.test.ts --reporter=verbose
```

**[Full setup guide →](docs/local-dev.md)**

---

## Project Structure

```
founderos/
├── src/
│   ├── core/          # registry.ts + prompts.ts + config.ts — single source of truth
│   ├── agents/        # LangGraph StateGraph: supervisor, critic, 4 department pods
│   │   └── pods/      # sales.ts, engineering.ts, marketing.ts, prospecting.ts
│   ├── gateway/       # grammy Telegram bot + HITL interrupt lifecycle
│   ├── tools/         # Firecrawl search, LinkedIn, email, GitHub
│   ├── db/            # drizzle schema (7 tables) + client + named queries
│   ├── infra/         # LLM cascade, Redis, scheduler (cron), checkpointer, logger
│   └── index.ts       # entry point: compile graph once, start bot, init scheduler
├── tests/
│   ├── unit/          # 60+ tests — pure logic, cascade, state reducers
│   ├── integration/   # 6 tests — full pod flows with mocked LLM
│   └── live/          # 10 tests — real LLM calls (Ollama), 128 assertions
├── docs/
│   ├── architecture.md
│   ├── decisions/     # 5 ADRs explaining each major choice
│   └── diagrams/      # Mermaid system + pipeline flow diagrams
├── governance/
│   └── critique-rules.md   # per-department quality criteria (loaded at runtime)
├── study/             # interview prep: LangGraph internals, TS patterns, STAR stories
└── scripts/           # setup-db.ts, inspect-thread.ts, qa-pipeline-test.ts
```

---

## Build Status

| Suite | Tests | Status |
|-------|-------|--------|
| Unit (pure logic, cascade, state) | 60+ | ✅ Green |
| Integration (full pod flows, mocked LLM) | 6 | ✅ Green |
| Live (real Ollama, one-man-company) | 10 tests, 128 assertions | ✅ Green |
| TypeScript strict | 0 errors | ✅ Clean |

**Live test results (Ollama `qwen2.5:7b`, single run):**

| Test | Latency | Result |
|------|---------|--------|
| Supervisor routing (4 tasks) | 3–14s each | ✅ All correct |
| ProspectingPod — Notion.so research + ICP | 48s | ✅ Scored + routed |
| SalesPod — cold email for Linear.app VP Eng | 76s | ✅ APPROVED on first critique |
| EngineeringPod — AI cost dashboard spec | 56s | ✅ 9-step plan, code stub |
| MarketingPod — LinkedIn post on AI ROI | 84s | ✅ Draft + strategy brief |
| Cross-dept — Prospecting → Sales handoff | 157s | ✅ State transferred correctly |
| Company capacity — 4 parallel department tasks | 303s | ✅ All completed |

---

## Phase Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1A — Foundation | Config, types, DB schema, infra, Docker | ✅ Complete |
| 1B — Brain | Supervisor, sales pod, critic | ✅ Complete |
| 1C — Gateway | Telegram bot, HITL interrupt | ✅ Complete |
| 1D — Quality | Unit + integration tests | ✅ Complete |
| 2A — Redis layer | Research cache, quota counters, prompt cache | ✅ Complete |
| 2B — ProspectingPod | ICP scoring, banded routing | ✅ Complete |
| 2C — Safety rails | Suppression check, quota check, LinkedIn tools, scheduler | ✅ Complete |
| 2D — Observability | Mermaid diagrams, docs update | ✅ Complete |
| 2E — Engineer agents | `{dept}_engineer` nodes, autonomous dept decisions | ✅ Complete |
| 3A — Two-phase LLM | `runPlanner` (cloud) + `runToolExecutor` (local) | ✅ Complete |
| 3B — Self-improvement | `task_outcomes` table, few-shot injection | ✅ Complete |
| 3C — Cross-dept signals | Ephemeral + durable signal channels | ✅ Complete |
| 3D — Brand update | Turicks positioning in prompts | ⏳ Pending |

---

## For Hiring Managers

This is a real operational system, not a portfolio toy. It runs actual business tasks for Turicks (AI agency). Every design decision is documented because the process of making + justifying those decisions is what the project is actually demonstrating.

**Navigate by concern:**

| "Tell me about..." | Start here |
|---|---|
| System design | `docs/architecture.md` → `src/agents/graph.ts` |
| LangGraph patterns | `study/02-langgraph-patterns.md` → `src/agents/pods/sales.ts` |
| TypeScript patterns | `study/03-typescript-advanced.md` → `src/core/config.ts` |
| Database design | `docs/decisions/002-why-drizzle.md` → `src/db/schema.ts` |
| AI/agent patterns | `study/05-ai-systems.md` → `src/agents/critic.ts` |
| Why these choices | `docs/decisions/` — 5 ADRs with explicit trade-off analysis |
| Behavioral stories | `study/06-behavioral-stories.md` — STAR format, specific to this build |

**The patterns I'd highlight in an interview:**
- **Critic cross-model**: generator uses Gemini, critic uses Claude. Different provider families = genuine adversarial critique, not the model agreeing with itself. This is in production code, not theoretical.
- **Native fetch over SDK**: removed 4 LangChain provider packages in favour of direct REST calls. Eliminated ~30 MB of transitive deps and 8 type-cast workarounds. The trade-off: more lines in `llm.ts`, but those lines are readable and I own them.
- **HITL durability**: write to `interrupt_registry` (Postgres) BEFORE calling LangGraph's `interrupt()`. If the process crashes in the 5ms gap, the DB row survives. On restart, the sweeper cron picks it up. This is crash-safe human-in-the-loop.
- **Self-improvement without RAG**: `task_outcomes` table feeds few-shot examples into system prompts at execution time. No vector DB needed at <10k rows. SQL + Drizzle is faster to reason about and explain in interviews than ChromaDB.
