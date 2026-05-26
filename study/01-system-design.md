# System Design: How to Explain FounderOS in an Interview

> Goal: Answer "walk me through a system you built" in 8–10 minutes, clearly, with depth on the decisions that matter.

---

## The 30-Second Version (for the opener)

> "FounderOS is a multi-agent AI operating system I built to run two real businesses — a TypeScript AI agency and a Himalayan farm + retreat. A founder types a task in Telegram; a supervisor agent routes it to the right department; specialist agents generate the output; a critic checks quality using a different model family to prevent sycophancy; and nothing leaves the system without human approval. Every state transition is persisted to PostgreSQL so the system survives crashes and is always resumable."

This covers: what it does, why it exists, the interesting technical parts, and the reliability guarantee. Lead with this, then go deeper on whatever the interviewer asks about.

---

## The 4-Layer Architecture

When drawing the architecture, always draw it as 4 layers:

```
┌─────────────────────────┐
│     GATEWAY LAYER       │  ← Telegram bot (grammy)
├─────────────────────────┤
│      BRAIN LAYER        │  ← LangGraph state machines
├─────────────────────────┤
│      TOOLS LAYER        │  ← Web search, email, GitHub
├─────────────────────────┤
│     MEMORY LAYER        │  ← PostgreSQL (checkpoints + app tables)
└─────────────────────────┘
```

**Talking points for each:**
- **Gateway:** "grammy handles Telegram messages; inline keyboards give us native approve/reject buttons on mobile with zero frontend code"
- **Brain:** "LangGraph StateGraph gives us durable checkpointing — every node transition is saved; a crash mid-workflow just resumes from the last checkpoint"
- **Tools:** "Unified interface over Composio, Firecrawl, GitHub API — agents declare which tools they're allowed to use in the registry"
- **Memory:** "One PostgreSQL instance for everything — LangGraph checkpoint tables, our HITL state, LLM cost tracking, and idempotency audit log"

---

## The Generator-Critic Loop

This is usually the most interesting part to interviewers. Explain it clearly:

**Why it exists:**
> "AI agents hallucinate and violate rules. We need a quality gate. But asking the same model to critique its own output fails — it approves everything (sycophancy problem)."

**The solution:**
> "Generator uses Gemini (Google family). Critic uses Claude (Anthropic family). Different training data, different RLHF process — genuinely adversarial. The critic reads department-specific rules from a Markdown file, checks the output, and either approves or lists specific violations."

**The loop:**
```
generator → critic → [approved?] → HITL
                ↑         ↓ no (revision_count < 2)
                └─────────┘
```

**Critical implementation detail:**
> "The critic is a LangGraph **node**, not a conditional edge. This matters because a node can have side effects — making an LLM call, writing a CritiqueRecord to state, incrementing revision_count. Conditional edges must be pure functions."

---

## HITL Architecture

HITL is usually the second-most interesting topic. Walk through the durability problem:

**The naive approach (wrong):**
```
1. Pause execution → wait for Telegram response → resume
```

**The problem:** What if the process restarts while waiting? The pause is lost.

**The correct approach:**
```
1. Write interrupt_registry row to PostgreSQL (status: pending)
2. Send Telegram message with Approve/Reject inline keyboard
3. Call LangGraph interrupt() — execution checkpointed here
```

"LangGraph saves the exact execution point to PostgreSQL. If the process restarts, it resumes from the interrupt(). The interrupt_registry row is how we map a Telegram button tap back to the right graph thread."

---

## Scalability Q&A

Interviewers often probe "how does this scale?" Have clear answers:

**Q: What if you have 100 concurrent tasks?**
> "The current single-process architecture handles ~10–20 concurrent LangGraph runs comfortably (rate-limited to 5 concurrent LLM calls via Bottleneck). For more, the swap is clean: replace the in-process executor with a BullMQ queue. The graph.ts stays the same; you just run it from a worker instead of the gateway handler."

**Q: What about multiple tenants / companies?**
> "Multi-tenant from day 1. Every DB table has a tenant_id column. LangGraph thread IDs are namespaced: `turicks:telegram:123:run-abc`. Adding a third company means adding to registry.ts — zero schema changes."

**Q: How do you handle LLM API failures?**
> "Model cascade with circuit breakers. Each tier has a primary + fallback chain. Opossum circuit breaker trips after 3 failures, cools down for 5 minutes. Bottleneck rate-limiter enforces 200ms between calls globally. If all providers in a tier fail, we throw AggregateError and the run shows in LangSmith as failed."

**Q: How do you prevent duplicate emails from being sent?**
> "Idempotency via audit_log table. Before any external action, we check if the idempotency_key (usually the interrupt_id) already exists. INSERT with `onConflictDoNothing()`. If the process crashed after sending the email but before marking it sent, the next run finds the audit_log entry and skips the send."

---

## The Data Model — Three Key Tables

```
interrupt_registry
├── interrupt_id (PK)
├── thread_id       ← links to LangGraph checkpoint
├── status          ← pending | approved | rejected | expired
├── telegram_msg_id ← so we can update the message after resolution
└── expires_at      ← 24h expiry; cron job cleans up stale approvals

llm_costs
├── tenant_id, agent, tier, model
├── tokens_in, tokens_out
└── cost_usd        ← lets cost_watchdog alert when spend approaches $5/day budget

audit_log
├── action          ← "email_sent" | "github_pr" | "telegram_send"
├── idempotency_key ← UNIQUE constraint — the heart of idempotency
└── payload         ← full action context for debugging
```

---

## Common Follow-Up Questions

**"Why not use Temporal instead of LangGraph?"**
> "Temporal needs its own server to run. LangGraph just needs a PostgreSQL table — we already have PostgreSQL. For an AI-specific use case, LangGraph also has the `interrupt()` primitive built in, native LangSmith integration, and the StateGraph model fits agent orchestration naturally. Temporal is better for general-purpose workflow orchestration at large scale."

**"How do you evaluate agent quality over time?"**
> "Every run produces a CritiqueRecord in state. Those records accumulate in the LangGraph checkpoint history. LangSmith traces every call with inputs and outputs. For systematic evaluation, the next step is building an eval harness using LangSmith datasets — seed it with examples of good/bad outputs, run regression tests on prompt changes."

**"What's the biggest technical risk in this system?"**
> "LangGraph JS is evolving quickly — API surface changed significantly between 0.1 and 0.2. We pin the version, test before upgrading, and the architecture is clean enough that swapping the orchestration layer (while painful) is possible. The bigger risk is LLM quality regression when providers update their models. LangSmith gives us the observability to catch this."

---

## Building the Narrative

When explaining this project, hit these themes in order:
1. **Real problem** — "This runs my actual business. It handles real emails, commits real code."
2. **Clean architecture** — "4 layers with clear boundaries. You can explain each in one sentence."
3. **Production thinking** — "Crash recovery, idempotency, circuit breakers, PII scrubbing — these aren't afterthoughts."
4. **Interesting technical decisions** — "The cross-model critic, the DB-backed HITL, the model cascade."
5. **What's next** — "Vector memory per company, streaming responses, web dashboard for approvals."
