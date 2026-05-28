# FounderOS — Architecture

> **One-paragraph pitch:** FounderOS is a multi-agent AI operating system that runs two real businesses (Turicks AI agency + Naggar Retreat farm) via a Telegram bot. A founder types a task; a supervisor routes it to the right department pod; specialists generate output; a critic checks quality; and nothing leaves the system without human approval. Every state transition is persisted to PostgreSQL so the system is resumable after any crash.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GATEWAY LAYER                               │
│                                                                     │
│   Telegram (grammy)  ──────────────────────────────────────────     │
│   • /prospect <url>  → ProspectingPod                              │
│   • free-form tasks  → Supervisor → dept routing                   │
│   • HITL callbacks   → inline [Approve] [Reject] [Edit] buttons    │
│                                                                     │
│   Admin HTTP (Hono)  ──── /health  /metrics  /threads               │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │  grammy message handler
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          BRAIN LAYER                                │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Main FounderGraph (LangGraph StateGraph)                   │   │
│  │                                                             │   │
│  │   START → [supervisor_node] ─────────────────────────────   │   │
│  │                │                                           │   │
│  │       Command({ goto: dept })                              │   │
│  │      ╱     │      │      ╲                                │   │
│  │ [prospect] [sales] [eng] [mktg]                            │   │
│  │      ╲     │      │      ╱                                │   │
│  │          └──────────────┘                                 │   │
│  │                 ▼                                         │   │
│  │               END                                         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────┐  ┌──────────────────────────────┐  │
│  │  ProspectingPod (subgraph)  │  │  Sales Pod (subgraph)        │  │
│  │                             │  │                              │  │
│  │  disambiguate               │  │  lead_intel                  │  │
│  │      ↓                      │  │      ↓                       │  │
│  │  research (Redis-first)     │  │  suppression_check (edge)    │  │
│  │      ↓                      │  │      ↓                       │  │
│  │  icp_score                  │  │  quota_check (edge)          │  │
│  │      ↓                      │  │      ↓                       │  │
│  │  route_by_score ────────────┼─▶│  bdr (email draft)           │  │
│  │   < 0.4 → disqualified      │  │      ↓                       │  │
│  │   0.4–0.69 → md tier        │  │  critic ────────────┐        │  │
│  │   ≥ 0.70 → ceo tier         │  │      ↓        needs revision │  │
│  └─────────────────────────────┘  │  hitl_node ◄────────┘        │  │
│                                   │      ↓                       │  │
│  Engineering: senior_dev →        │  finalize                    │  │
│    vibe_coder → qa → critic →     └──────────────────────────────┘  │
│    hitl → finalize                                                  │
│  Marketing: researcher →                                            │
│    content_writer → critic → hitl → finalize                        │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │  callCascade()
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          TOOLS LAYER                                │
│                                                                     │
│   Web Search (Firecrawl/Tavily)   Email (Composio/Gmail)           │
│   GitHub (REST + MCP)             LinkedIn (Composio)              │
│   Telegram Send                   Bash execution                   │
│                                                                     │
│   Scheduler (node-cron — NOT graph nodes):                         │
│   • LinkedIn posts Mon/Wed/Fri 9am                                 │
│   • Gmail reply poller every 15 min                                │
│   • HITL sweeper hourly (expires stale pending approvals)          │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                   ┌───────────────┴───────────────┐
                   ▼                               ▼
┌─────────────────────────────┐   ┌───────────────────────────────────┐
│       CACHING LAYER         │   │         MEMORY LAYER              │
│       (Redis 7)             │   │         (PostgreSQL 16)           │
│                             │   │                                   │
│  research:{url_hash}        │   │  LangGraph checkpoints            │
│    TTL 7 days               │   │    every node transition          │
│    avoids re-scraping       │   │    fully resumable after crash    │
│                             │   │                                   │
│  quota:{tenant}:{date}      │   │  hitl_approvals                   │
│    INCR atomic counter      │   │    HITL queue → Telegram buttons  │
│    auto-expires midnight    │   │                                   │
│                             │   │  ai_call_costs + lead_id          │
│  llm:{prompt_hash}          │   │    per-call cost + per-lead view  │
│    TTL: 0 (CEO) /           │   │                                   │
│          3600 (MD) /        │   │  action_log                       │
│          86400 (NANO)       │   │    idempotency guard (ext. sends) │
│                             │   │                                   │
└─────────────────────────────┘   │  outbound_leads                   │
                                   │    prospect state machine        │
                                   │                                   │
                                   │  do_not_contact                   │
                                   │    GDPR/CAN-SPAM suppression     │
                                   │                                   │
                                   │  agent_results (Phase 3)         │
                                   │    few-shot training data        │
                                   │                                   │
                                   │  dept_signals (Phase 3)          │
                                   │    cross-department events       │
                                   └───────────────────────────────────┘

         Cross-cutting: Observability
         LangSmith traces (LANGCHAIN_TRACING_V2=true) — PII scrubbed
         Pino structured JSON logs
```

---

## Layer Responsibilities

### Gateway Layer (`src/gateway/`)
Humans talk to FounderOS through Telegram. Two jobs:
1. **Receive** — parse messages, route into the graph
2. **Respond** — send HITL inline keyboards, send completion notifications

All grammy handlers are `async` and respond immediately. Long-running work happens in the graph.

Special command: `/prospect <url>` — kicks off the full outbound pipeline (disambiguate → research → ICP score → BDR → HITL).

### Brain Layer (`src/agents/`)
LangGraph `StateGraph`:
- **Supervisor** (`supervisor.ts`) — CEO-tier LLM, emits `Command({ goto: dept })`
- **ProspectingPod** (`pods/prospecting.ts`) — qualifies inbound leads before SalesPod
- **Department pods** (`pods/`) — Sales, Engineering, Marketing — each a compiled subgraph
- **Critic** (`critic.ts`) — runs after generators; uses *different model family* to prevent sycophancy

Graph compiled **once at startup**. Never compile per-request.

### Caching Layer (`src/infra/redis.ts`)
Redis is exclusively for ephemeral data with natural TTLs:

| Key pattern | TTL | Purpose |
|-------------|-----|---------|
| `research:{md5(url)}` | 7 days | Research results — avoids re-scraping same company |
| `quota:{tenant}:{YYYY-MM-DD}` | Until midnight | Daily send quota — atomic INCR, race-condition safe |
| `llm:{sha256(prompt)}` | 0 / 3600 / 86400 | LLM response cache by tier (CEO never cached) |

**Rule:** Redis for data that self-destructs. Postgres for data you query later.

### Tools Layer (`src/tools/`)
Implements `UnifiedTool` interface. Agents declare `allowed_tools` in `registry.ts`.

**Scheduler** lives here conceptually — `src/infra/scheduler.ts` runs three `node-cron` jobs at startup. NOT graph nodes (sleeping nodes are an antipattern in LangGraph — waste checkpointer storage).

### Memory Layer (`src/db/`)
PostgreSQL is the single source of truth for durable state:

| Table | Purpose |
|-------|---------|
| `langgraph_checkpoints` | Every node transition — process-crash recovery |
| `hitl_approvals` | Links LangGraph interrupt → Telegram message_id |
| `ai_call_costs` | Per-call token + USD cost, tagged with `lead_id` |
| `action_log` | Idempotency key guard before any external action |
| `outbound_leads` | Prospect state machine (researching → won/lost) |
| `do_not_contact` | GDPR/CAN-SPAM suppression — checked before every send |
| `agent_results` | Phase 3: few-shot examples for self-improving agents |
| `dept_signals` | Phase 3: durable cross-department event log |

---

## Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Agent orchestration | LangGraph JS | Built-in PostgreSQL checkpointing, durable `interrupt()`, native LangSmith |
| LLM client | Vercel AI SDK | Unified interface across Anthropic/Google/OpenAI/OpenRouter |
| Telegram | grammy | TypeScript-first, inline keyboards for HITL, topic groups = departments |
| ORM | drizzle-orm | Schema IS TypeScript types — no codegen, SQL-like API |
| Multi-model critique | Gemini → Claude | Different families prevent sycophancy in quality gate |
| Ephemeral data | Redis | TTL-native, atomic INCR for quota — Postgres would need cleanup jobs |
| Scheduling | node-cron | Sleeping graph nodes waste checkpointer storage; cron is purpose-built |
| Local model | Ollama (qwen2.5:7b) | Deterministic JSON output at temp=0.1 — cost-free for structured tasks |

See `docs/decisions/` for full ADR write-ups.

---

## Outbound Sales Pipeline (Phase 2)

```
Telegram: /prospect acme.com
  │
  ▼
ProspectingPod
  │
  ├─ disambiguate_node (NANO tier)
  │    "acme.com" → { company_url: "https://acme.com", company_name: "Acme Corp" }
  │    Writes outbound_leads row (stage: "researching")
  │
  ├─ research_node (NANO tier, Redis-first)
  │    1. Check Redis research:{md5("https://acme.com")} → cache hit? return blob
  │    2. Cache miss → Tavily search → extract pain_points, tech_stack, funding
  │    3. Cache in Redis TTL=7d
  │
  ├─ icp_score_node (MD tier)
  │    Input: research blob
  │    Output: { icp_score: 0.82, outreach_tier: "ceo", icp_rationale: "..." }
  │    Updates outbound_leads (stage: "drafting", icp_score: 0.82)
  │
  └─ route_by_score (pure function — NO LLM)
       score < 0.4  → Telegram: "Disqualified — [reason]". Stop.
       score 0.4-0.69 → SalesPod with tier: "md"
       score ≥ 0.70  → SalesPod with tier: "ceo"
         │
         ▼
     SalesPod
       │
       ├─ lead_intel_node — additional context enrichment
       ├─ suppression_check — pure edge: SELECT from do_not_contact
       ├─ quota_check — pure edge: Redis INCR quota:{tenant}:{today}
       ├─ bdr_node (md/ceo tier based on score) — draft email
       ├─ critic_node — quality check (different model family)
       ├─ hitl_node — pause, send Telegram [Approve][Reject][Edit]
       └─ finalize_node — send email, write action_log, update outbound_leads stage
```

---

## State Flow (Direct Task Example)

```
User: "Review our GitHub PR #42"
  │
  ▼
Supervisor (CEO tier: Claude Sonnet)
  → classifies: department = "engineering"
  → Command({ goto: "engineering" })
  ▼
Engineering Pod
  ├─ senior_dev — reads PR diff, generates review
  ├─ critic — checks against engineering quality rules
  ├─ hitl_node — pauses, sends Telegram approval
  └─ finalize — posts GitHub review comment
```

---

## Multi-Tenant Design

Every state schema, DB table, and thread ID includes `tenant_id`. Today: `"turicks"`. Adding Naggar Retreat:
1. Add company to `src/core/registry.ts`
2. Zero schema changes, zero code changes

Thread ID format: `{tenant}:{user}:{run}` — e.g. `turicks:telegram:456:run-abc123`

---

## Scalability Notes

Intentionally **single-process** for Phase 1/2 — one Node.js process, one PostgreSQL, one Redis. Sufficient for a two-person team. When it needs to scale:

- **Horizontal**: Each company becomes its own process (already tenant-isolated)
- **Queue**: Replace in-process with BullMQ + Redis workers (graph.ts → queue consumer swap)
- **Vector memory**: Add ChromaDB per company when `agent_results` > 10k rows (Phase 3+)
- **Streaming**: LangGraph supports `streamEvents()` — pipe to Telegram with no architecture change
