# FounderOS

**A multi-agent AI operating system that runs two real businesses — and documents every decision for engineering interviews.**

Built on: Node.js 22 · TypeScript (strict) · LangGraph JS · Vercel AI SDK · grammy · drizzle-orm · PostgreSQL

---

## What It Does

A founder types a task in Telegram. FounderOS handles the rest:

1. **Supervisor** (Claude Sonnet) classifies the task → routes to Sales, Engineering, or Marketing
2. **Specialist agents** generate the output (email draft, PR, LinkedIn post)
3. **Critic** (different model family → no sycophancy) checks quality against department rules
4. **Human approval** via Telegram inline keyboard — nothing leaves the system without the founder's sign-off
5. **Finalize** executes the approved action and records it (idempotency-guarded)

Every state transition is checkpointed to PostgreSQL. A crash mid-workflow resumes from the last saved point.

---

## Architecture

```
┌─────────────────────────────────┐
│        GATEWAY LAYER            │  grammy (Telegram bot)
│  Telegram topics → department   │  Inline keyboards for HITL
│  callback_query → graph resume  │
└────────────────┬────────────────┘
                 │
┌────────────────▼────────────────┐
│         BRAIN LAYER             │  LangGraph StateGraph
│  Supervisor → Pod routing       │  Generator → Critic loop
│  interrupt() for durable HITL   │  PostgreSQL checkpointing
└────────────────┬────────────────┘
                 │
┌────────────────▼────────────────┐
│         TOOLS LAYER             │  Unified tool interface
│  Firecrawl · Gmail · GitHub     │  Registry-controlled access
│  LinkedIn · OpenWeatherMap      │  per agent
└────────────────┬────────────────┘
                 │
┌────────────────▼────────────────┐
│         MEMORY LAYER            │  PostgreSQL 16
│  LangGraph checkpoints          │  interrupt_registry
│  llm_costs · audit_log          │  (idempotency guard)
└─────────────────────────────────┘
```

**[Full architecture docs →](docs/architecture.md)**

---

## Key Design Decisions

| Problem | Solution | Where |
|---------|----------|-------|
| Agent output quality | Cross-model critic (Gemini → Claude) | [ADR-003](docs/decisions/003-critic-pattern.md) |
| HITL crash recovery | DB-backed `interrupt()` + PostgreSQL checkpoints | [ADR-004](docs/decisions/004-why-telegram-hitl.md) |
| Duplicate external actions | Idempotency key in `audit_log` with `UNIQUE` constraint | `src/db/queries.ts` |
| LLM outage resilience | Model cascade + opossum circuit breakers | `src/infra/llm.ts` |
| Multi-tenant from day 1 | `tenant_id` on every table, thread IDs namespaced | `src/db/schema.ts` |
| Type-safe state | drizzle schema = TypeScript types, no codegen | [ADR-002](docs/decisions/002-why-drizzle.md) |

---

## Tech Stack

| Concern | Package | Why |
|---------|---------|-----|
| Agent orchestration | `@langchain/langgraph@^0.2` | Durable `interrupt()`, PostgreSQL checkpointing |
| LLM client | `ai@^4` (Vercel AI SDK) | Unified interface — Anthropic + Google + OpenAI + OpenRouter |
| Telegram bot | `grammy@^1` | TypeScript-first, inline keyboards, excellent DX |
| ORM | `drizzle-orm@^0.38` | Schema IS TypeScript types — zero codegen |
| Circuit breaker | `opossum@^8` | Per-model fault isolation (3 failures → 5min cooldown) |
| Rate limiting | `bottleneck@^2` | Global LLM concurrency control |
| Logging | `pino@^9` | Structured JSON + PII redaction |
| Observability | `langsmith@^0.2` | Per-node trace, token counts, latency |
| Validation | `zod@^3` | Type-safe env vars + external API responses |

---

## Running Locally

**Prerequisites:** Node.js 22, pnpm, Docker

```bash
# 1. Install
git clone <repo> && cd founderos
pnpm install

# 2. Configure
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN + one LLM key at minimum

# 3. Start PostgreSQL
docker compose -f docker/docker-compose.yml up postgres -d

# 4. Run migrations
npx tsx scripts/setup-db.ts

# 5. Start
npx tsx src/index.ts
```

**[Full setup guide →](docs/local-dev.md)**

---

## Agent Registry (30+ agents)

All agents are defined in `src/core/registry.ts`:

**Turicks (AI Agency):** `bidding_sniper` · `lead_intel` · `senior_dev` · `vibe_coder` · `qa_tester` · `proposal_writer` · `seo_specialist` · `github_agent` · `web_designer` · `ops_agent` · `kb_agent`

**Naggar Retreat (Himalayan Farm):** `farm_weather` · `yield_scout` · `booking_concierge` · `culinary_agent` · `market_scout` · `guest_crm` · `video_editor` · `vibe_designer` · `naggar_kb`

**Cross-Company:** `social_handler` · `social_researcher` · `linkedin_growth` · `platform_growth` · `outreach_agent` · `pipeline_md` · `cost_watchdog` · `team_therapist` · `revenue_scout` · `scrum_engine` · `hr_agent`

Each agent declares its cascade tier, allowed tools, and memory collections. No hardcoded strings outside `registry.ts`.

---

## Model Cascade

| Tier | Primary | Fallback 1 | Fallback 2 |
|------|---------|------------|------------|
| CEO | claude-sonnet-4-5 | gemini-2.5-pro | gemini-flash |
| Deep Research | gemini-2.5-pro | gemini-flash | deepseek-r1 (free) |
| MD | gemini-flash | claude-haiku | llama-70b (free) |
| Code | LM Studio (local) | qwen-coder (free) | gemini-flash |
| Nano | gemini-flash-lite | claude-haiku | — |

Circuit breakers prevent hammering failing providers. Daily budget cap ($5 default) prevents runaway spend.

---

## Project Structure

```
founderos/
├── src/
│   ├── core/          # registry.ts + prompts.ts + config.ts — single source of truth
│   ├── agents/        # LangGraph state machines + supervisor + critic + pods
│   ├── gateway/       # Telegram bot + HITL interrupt handler
│   ├── tools/         # UnifiedTool interface + web-search, email, github
│   ├── db/            # drizzle schema + client + named queries
│   ├── infra/         # LLM cascade + checkpointer + logger + telemetry
│   └── index.ts       # entry point
├── docs/
│   ├── architecture.md
│   ├── local-dev.md
│   └── decisions/     # 4 ADRs explaining major choices
├── governance/
│   └── critique-rules.md   # per-department quality rules (loaded by critic at runtime)
├── study/             # interview prep — LangGraph, TypeScript, AI systems, STAR stories
├── scripts/           # setup-db.ts + inspect-thread.ts
└── docker/            # multi-stage Dockerfile + docker-compose.yml
```

---

## Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1A — Foundation | Config, types, DB schema, infra, Docker | ✅ Complete |
| 1B — Brain | Supervisor, sales pod, critic (full impl) | 🔄 In Progress |
| 1C — Gateway | Telegram polling, HITL resume | ⏳ Pending |
| 1D — Quality | Unit tests, integration tests, evals | ⏳ Pending |
| 2 — Full Pods | Engineering + Marketing full impl | ⏳ Pending |
| 3 — Vector Memory | ChromaDB per company | ⏳ Pending |

---

## For Hiring Managers

This project is built as a real operational system (handling live business tasks) **and** a demonstration of production-grade AI engineering patterns.

Key technical decisions are documented in `docs/decisions/` (Architecture Decision Records). Each ADR explains not just what was chosen but why — the trade-offs and what was rejected.

The `study/` folder contains my interview preparation notes, including how to explain each component of this system, LangGraph internals, TypeScript patterns used, and behavioral STAR stories from building it. It's a transparent look at what "building this project" actually taught me.

If you're reviewing this for an interview:
- **System design:** `docs/architecture.md` → `src/agents/graph.ts`
- **Data model:** `docs/decisions/002-why-drizzle.md` → `src/db/schema.ts`
- **Quality assurance:** `docs/decisions/003-critic-pattern.md` → `src/agents/critic.ts`
- **TypeScript patterns:** `study/03-typescript-advanced.md` → `src/core/config.ts`
