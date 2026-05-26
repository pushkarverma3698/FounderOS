# FounderOS — Architecture

> **One-paragraph pitch:** FounderOS is a multi-agent AI operating system that runs two real businesses (Turicks AI agency + Naggar Retreat farm) via a Telegram bot. A founder types a task; a supervisor routes it to the right department pod; specialists generate output; a critic checks quality; and nothing leaves the system without human approval. Every state transition is persisted to PostgreSQL so the system is resumable after any crash.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GATEWAY LAYER                               │
│                                                                     │
│   Telegram (grammy)  ──────────────────────────────────────────     │
│   • Receive tasks in department topics                              │
│   • Send HITL approve/reject inline keyboards                       │
│   • Route callback_query back to interrupt resolver                 │
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
│  │         ╱        │        ╲                               │   │
│  │  [sales pod] [eng pod] [mktg pod]                          │   │
│  │         ╲        │        ╱                               │   │
│  │          └────────────────┘                               │   │
│  │                 ▼                                         │   │
│  │               END                                         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────┐  ┌─────────────────────────────────┐  │
│  │  Sales Pod (subgraph)   │  │  Engineering Pod (subgraph)     │  │
│  │                         │  │                                 │  │
│  │  lead_intel             │  │  senior_dev                     │  │
│  │      ↓                  │  │      ↓                          │  │
│  │  bdr (email draft)      │  │  vibe_coder                     │  │
│  │      ↓                  │  │      ↓                          │  │
│  │  critic ────────┐       │  │  qa_tester                      │  │
│  │      ↓          │ needs │  │      ↓                          │  │
│  │  hitl_node    revision  │  │  critic → hitl → finalize       │  │
│  │      ↓          │       │  │                                 │  │
│  │  finalize ◄─────┘       │  └─────────────────────────────────┘  │
│  └─────────────────────────┘                                       │
│                                                                     │
│  Marketing Pod: researcher → content_writer → critic → hitl        │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │  callCascade()
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          TOOLS LAYER                                │
│                                                                     │
│   Web Search (Firecrawl)   Email (Composio/Gmail)                  │
│   GitHub (REST + MCP)      LinkedIn (Composio)                     │
│   Telegram Send            Bash execution                           │
│   OpenWeatherMap           FFmpeg (Naggar video)                    │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         MEMORY LAYER                                │
│                                                                     │
│   PostgreSQL 16                                                     │
│   ├── LangGraph checkpoints    (every node transition, resumable)  │
│   ├── interrupt_registry       (HITL state — pending/approved/etc) │
│   ├── llm_costs                (per-call token tracking)           │
│   └── audit_log                (idempotency keys for ext. actions) │
│                                                                     │
│   Future: ChromaDB             (vector memory per company)         │
└─────────────────────────────────────────────────────────────────────┘

         Cross-cutting: Observability
         LangSmith traces (LANGCHAIN_TRACING_V2=true)
         Pino structured JSON logs (PII redacted before any sink)
```

---

## Layer Responsibilities

### Gateway Layer (`src/gateway/`)
Humans talk to FounderOS through Telegram. This layer has exactly two jobs:
1. **Receive** — parse incoming Telegram messages and route them into the graph
2. **Respond** — send HITL approval messages with inline keyboards, update on completion

All grammy handlers are `async` and respond immediately (no blocking). Long-running work happens in the graph.

### Brain Layer (`src/agents/`)
The "thinking" part. Built on LangGraph `StateGraph`:
- **Supervisor node** (`supervisor.ts`) — CEO-tier LLM that reads the task and emits `Command({ goto: dept })` to route to the correct department pod
- **Department pods** (`pods/`) — each is a compiled `StateGraph` subgraph with specialist nodes for that domain
- **Critic node** (`critic.ts`) — runs after every generator node; uses a *different model family* from the generator to prevent sycophancy
- **HITL node** — calls LangGraph `interrupt()` to pause execution; DB-backed so it survives restarts

The entire graph is compiled **once at startup** (`graph.ts`) and reused for every request. Never compile per-request.

### Tools Layer (`src/tools/`)
Implements the `UnifiedTool` interface. Agents declare `allowed_tools` in `registry.ts`. The runtime calls `getToolsForAgent()` to get only the tools an agent is allowed to use.

### Memory Layer (`src/db/`)
PostgreSQL is the single source of truth for all state:
- **LangGraph checkpoints** — every node transition is checkpointed; any crash is recoverable
- **interrupt_registry** — maps a HITL interrupt to its Telegram message; enables "approve" button to resume the right thread
- **audit_log** — idempotency guard; before any external action (email/GitHub), check this table

---

## Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Agent orchestration | LangGraph JS | Built-in PostgreSQL checkpointing, durable `interrupt()`, native LangSmith |
| LLM client | Vercel AI SDK | Unified interface across Anthropic/Google/OpenAI/OpenRouter |
| Telegram | grammy | TypeScript-first, inline keyboards for HITL, topic groups = departments |
| ORM | drizzle-orm | Schema IS TypeScript types — no codegen, SQL-like API |
| Multi-model critique | Gemini → Claude | Different families prevent sycophancy in quality gate |
| State persistence | PostgreSQL | One DB for app tables + checkpoints; no additional infra |

See `docs/decisions/` for full ADR write-ups.

---

## State Flow (Sales Example)

```
User: "Draft cold email to Acme Corp CEO"
  │
  ▼
Telegram handler receives message
  │  writes thread_id: "turicks:telegram:456:run-xyz"
  ▼
Supervisor node (CEO tier: Claude Sonnet)
  │  classifies task → department: "sales"
  │  emits: Command({ goto: "sales" })
  ▼
Sales pod starts
  │
  ├─ lead_intel node (local tier: LM Studio)
  │    scrapes Acme Corp, builds LeadProfile
  │
  ├─ bdr node (md tier: Gemini Flash)
  │    drafts email using LeadProfile + company profile from registry
  │
  ├─ critic node (ceo tier: Claude Sonnet)
  │    checks against governance/critique-rules.md (Sales rules)
  │    if NEEDS_REVISION → back to bdr (max 2 retries)
  │    if APPROVED → hitl_node
  │
  ├─ hitl_node
  │    writes interrupt_registry row (status: pending)
  │    calls LangGraph interrupt()  ← execution pauses here
  │    sends Telegram message with [Approve] [Reject] [Edit] buttons
  │
  ▼ (founder taps Approve in Telegram)
  │
  ├─ Telegram callback_query handler
  │    resolves interrupt_registry (status: approved)
  │    resumes graph from checkpoint
  │
  ├─ finalize node
  │    writes audit_log (idempotency_key = interrupt_id)
  │    sends email via Gmail/Composio
  │
  ▼
Done — Telegram confirmation sent to founder
```

---

## Multi-Tenant Design

Every state schema, DB table, and thread ID includes `tenant_id`. Today it's always `"turicks"`. Adding Naggar Retreat or a third company requires:
1. Add company to `src/core/registry.ts`
2. Zero schema changes
3. Zero code changes — routing works by `tenant_id` convention

---

## Scalability Notes

The system is intentionally **single-process** for Phase 1 — one Node.js process, one PostgreSQL instance. This is sufficient for a two-person founding team. When it needs to scale:

- **Horizontal**: Each company becomes its own process (already tenant-isolated in DB)
- **Queue**: Replace in-process execution with BullMQ + Redis (single graph.ts → queue consumer swap)
- **Vector memory**: Add ChromaDB collections per company (collections already named in registry)
- **Streaming**: LangGraph supports streaming — gateway layer already handles async; just pipe `streamEvents()` to Telegram

None of these require architecture changes — they're slot-in upgrades to existing seams.
