# FounderOS — System Architecture

> Mermaid diagrams of the 6-layer architecture and data flows.

---

## Layer Overview

```mermaid
graph TB
    subgraph GATEWAY["🌐 GATEWAY LAYER"]
        TG["Telegram Bot (grammy)\n/prospect · /task · HITL callbacks"]
        ADMIN["Admin HTTP (Hono)\nhealth · metrics · webhook"]
    end

    subgraph BRAIN["🧠 BRAIN LAYER"]
        SUPER["Supervisor Node\nCEO-tier · classifies + routes"]
        PROS["ProspectingPod\ndisambiguate → research → ICP score"]
        SALES["SalesPod\nlead_intel → BDR → critic → HITL → finalize"]
        ENG["EngineeringPod\nplanner → coder → critic → HITL"]
        MKT["MarketingPod\nresearch → writer → critic → HITL"]
        SOC["SocialPod\ncontent → critic → scheduler → post"]
    end

    subgraph TOOLS["🔧 TOOLS LAYER"]
        SEARCH["Web Search (Tavily)"]
        GMAIL["Gmail (Composio)"]
        GITHUB["GitHub API"]
        LI["LinkedIn (Composio)"]
        CRON["Cron Scheduler (node-cron)"]
    end

    subgraph CACHE["⚡ CACHING LAYER"]
        R1["research:{md5(url)}\nTTL 7 days"]
        R2["quota:{tenant}:{date}\nINR + EXPIREAT midnight"]
        R3["llm:{sha256(prompt)}\nMD=1h · NANO=24h · CEO=never"]
    end

    subgraph MEMORY["🗄️ MEMORY LAYER"]
        PG_CKPT["LangGraph Checkpoints\n(PostgresSaver)"]
        PG_APP["Application Tables\nhitl_approvals · ai_call_costs\naction_log · outbound_leads\ndo_not_contact"]
    end

    subgraph OBS["📊 OBSERVABILITY"]
        LS["LangSmith Traces\n(PII scrubbed)"]
        PINO["Pino Logs\nstructured JSON"]
    end

    TG -->|user messages| SUPER
    ADMIN -->|webhook| SUPER
    SUPER -->|department route| PROS
    SUPER -->|department route| SALES
    SUPER -->|department route| ENG
    SUPER -->|department route| MKT
    SUPER -->|department route| SOC
    PROS -->|qualified lead| SALES

    SALES --> TOOLS
    ENG --> TOOLS
    MKT --> TOOLS
    SOC --> TOOLS

    BRAIN --> CACHE
    BRAIN --> MEMORY
    BRAIN --> OBS

    style GATEWAY fill:#1a1a2e,color:#e0e0e0
    style BRAIN fill:#16213e,color:#e0e0e0
    style TOOLS fill:#0f3460,color:#e0e0e0
    style CACHE fill:#533483,color:#e0e0e0
    style MEMORY fill:#2d4059,color:#e0e0e0
    style OBS fill:#1b262c,color:#e0e0e0
```

---

## Multi-Tenant Data Isolation

```mermaid
graph LR
    subgraph TURICKS["Turicks (tenant: turicks)"]
        T_BOT["Telegram Group A\nTopic: Sales · Eng · Mktg"]
        T_DB["DB rows WHERE tenant_id='turicks'"]
        T_THREAD["Thread IDs: turicks:telegram:*"]
    end

    subgraph NAGGAR["Naggar Retreat (tenant: naggar)"]
        N_BOT["Telegram Group B\nTopic: Ops · Social"]
        N_DB["DB rows WHERE tenant_id='naggar'"]
        N_THREAD["Thread IDs: naggar:telegram:*"]
    end

    subgraph SHARED["Shared Infrastructure"]
        PG["PostgreSQL\n(single DB, row-level isolation)"]
        REDIS["Redis\n(key-prefixed by tenant)"]
        LLM["LLM Cascade\n(shared circuit breakers)"]
    end

    TURICKS --> SHARED
    NAGGAR --> SHARED
```

---

## LLM Model Cascade

```mermaid
flowchart TD
    CALL["callCascade(tier, messages)"]

    CALL --> LIMIT["Rate Limiter\nbottleneck: max 5 concurrent\n200ms min between calls"]
    LIMIT --> CB["Circuit Breaker\nopossum: per provider:model\ntrips after 3 fails → 5min cooldown"]

    CB -->|"CLOSED (healthy)"| INVOKE["Invoke LLM Provider"]
    CB -->|"OPEN (failing)"| SKIP["Skip → next cascade entry"]

    INVOKE -->|success| COST["Log cost to ai_call_costs"]
    INVOKE -->|error| NEXT["Try next cascade entry"]

    NEXT -->|all failed| ERR["throw AggregateError\n(visible in LangSmith as failed run)"]

    subgraph TIERS["Tier Definitions"]
        CEO["CEO: claude-sonnet-4-5\n→ gemini-2.5-pro\n→ gemini-flash\n→ llama-3.3-70b:free\n⚠ Never cached"]
        DEEP["deep_research: gemini-2.5-pro\n→ gemini-flash\n→ deepseek-r1:free"]
        MD["md: gemini-flash\n→ claude-haiku\n→ llama-70b:free"]
        CODE["code: lmstudio/qwen (local)\n→ qwen3-coder:free\n→ gemini-flash"]
        NANO["nano: gemini-flash-lite\n→ claude-haiku"]
        CRITIC["critic: claude-haiku ← FIRST\n→ gemini-flash\n(anti-sycophancy: Anthropic reviews Gemini output)"]
    end
```

---

## HITL (Human-in-the-Loop) Durability

```mermaid
sequenceDiagram
    participant Agent as Agent Node
    participant DB as PostgreSQL
    participant LG as LangGraph Checkpointer
    participant TG as Telegram Bot
    participant Human as Founder

    Agent->>DB: INSERT hitl_approvals (status: pending, expires_at: +24h)
    DB-->>Agent: interrupt_id
    Agent->>TG: Send message with Approve/Reject keyboard
    TG-->>Agent: telegram_msg_id
    Agent->>DB: UPDATE hitl_approvals SET telegram_msg_id
    Agent->>LG: interrupt() — checkpoint full execution state

    Note over LG: Process can crash here safely.<br/>LangGraph resumes from checkpoint.

    Human->>TG: Tap "Approve" button
    TG->>DB: Look up pending interrupt by callback_data
    DB-->>TG: thread_id
    TG->>LG: resume thread with { approved: true }
    LG->>Agent: Execution continues from interrupt()
    Agent->>DB: UPDATE hitl_approvals SET status: 'approved'
    Agent->>DB: INSERT action_log (idempotency_key = interrupt_id)
    Agent->>Agent: Send email / publish post
```
