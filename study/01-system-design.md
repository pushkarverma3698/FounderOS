# System Design: How to Explain FounderOS in an Interview

> Goal: Answer "walk me through a system you built" in 8–10 minutes, clearly, with depth on the decisions that matter.

---

## The 30-Second Version (for the opener)

> "FounderOS is a multi-agent AI operating system I built to run two real businesses — a TypeScript AI agency and a Himalayan farm + retreat. A founder types `/prospect acme.com` in Telegram; a ProspectingPod qualifies the lead using web research and ICP scoring; if it scores well, a SalesPod drafts a personalised email; a critic using a different model family checks quality; and nothing leaves the system without human approval. Redis caches research results and enforces daily send quotas atomically. Every state transition is persisted to PostgreSQL so the system survives crashes and is always resumable."

This covers: what it does, why it exists, the interesting technical parts, and the reliability guarantee. Lead with this, then go deeper on whatever the interviewer asks about.

---

## The 6-Layer Architecture (Phase 2)

When drawing the architecture, draw it as 6 layers:

```
┌─────────────────────────┐
│     GATEWAY LAYER       │  ← Telegram (grammy) + Admin HTTP (Hono)
├─────────────────────────┤
│      BRAIN LAYER        │  ← LangGraph: Supervisor + 4 Department Pods
├─────────────────────────┤
│      TOOLS LAYER        │  ← Web search, Gmail, GitHub, LinkedIn + node-cron
├─────────────────────────┤
│     CACHING LAYER       │  ← Redis: research cache, send quotas, LLM cache
├─────────────────────────┤
│     MEMORY LAYER        │  ← PostgreSQL: checkpoints + 7 application tables
└─────────────────────────┘
         ↕ (both layers)
    OBSERVABILITY          ← LangSmith traces + Pino logs (PII scrubbed)
```

**Talking points for each:**
- **Gateway:** "grammy handles Telegram messages; inline keyboards give us native approve/reject buttons on mobile with zero frontend code. `/prospect <url>` triggers the outbound pipeline."
- **Brain:** "LangGraph StateGraph gives us durable checkpointing — every node transition is saved; a crash mid-workflow just resumes from the last checkpoint. ProspectingPod qualifies leads before SalesPod handles outreach."
- **Tools:** "Unified interface over Composio, Firecrawl, GitHub API. Scheduler runs three cron jobs — never inside graph nodes, which would waste checkpoint storage."
- **Caching:** "Redis handles data that self-destructs: research blobs (TTL 7d), daily send counters (atomic INCR, expires at midnight), LLM prompt responses (tier-specific TTL). CEO tier is never cached — decisions must be fresh."
- **Memory:** "PostgreSQL is the only source of truth for durable state. 7 application tables + LangGraph checkpoint tables. Separate from Redis by rule: if you need to query it later, it goes in Postgres."

---

## Outbound Prospecting Flow (ProspectingPod)

This is the most technically rich part to explain since it shows multiple systems working together:

```
/prospect acme.com
       │
       ▼
disambiguate_node (NANO tier)
  → Normalises URL, writes outbound_leads row (stage: researching)

research_node (NANO tier)
  → Check Redis research:{md5(url)}
  → Hit? return cached blob (saves $0.002 per re-research)
  → Miss? Tavily search → extract pain_points, tech_stack, team_size, funding
  → Write to Redis TTL=7d
  → Writes research blob to state

icp_score_node (MD tier)
  → Scores 0.0–1.0 against Turicks ICP criteria
  → Turicks ICP: AI-forward, 10-200 employees, B2B SaaS, tech-enabled teams
  → Writes icp_score + icp_rationale to outbound_leads row

route_by_score (pure function — no LLM)
  → < 0.4  : disqualified — Telegram notification, stop
  → 0.4–0.69: SalesPod with tier="md" (Gemini Flash handles)
  → ≥ 0.70 : SalesPod with tier="ceo" (Claude Sonnet handles)
```

**Why banded thresholds matter for the interview:**
> "The threshold isn't binary. Low-fit leads get a lighter outreach model (cheaper, faster). High-fit leads get our best model. This means the system automatically allocates LLM spend proportional to lead quality."

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

## The Data Model — Key Tables

```
hitl_approvals             (old name: interrupt_registry)
├── interrupt_id (PK)
├── thread_id       ← links to LangGraph checkpoint
├── status          ← pending | approved | rejected | expired
├── telegram_msg_id ← update the button message after resolution
└── expires_at      ← 48h expiry; hourly cron sweeper cleans stale rows

ai_call_costs              (old name: llm_costs)
├── tenant_id, agent, tier, model
├── tokens_in, tokens_out
├── cost_usd
└── lead_id         ← FK → outbound_leads: enables per-lead cost attribution

action_log                 (old name: audit_log)
├── action          ← "email_sent" | "linkedin_post" | "github_pr"
├── idempotency_key ← UNIQUE constraint — prevents duplicate external actions
└── payload         ← full context for debugging

outbound_leads             (new Phase 2)
├── company_url, company_name
├── stage           ← researching → drafting → sent → replied → won/lost
├── icp_score       ← 0.0–1.0 from icp_score_node
└── outreach_tier   ← "md" | "ceo" — banded by score

do_not_contact             (new Phase 2)
├── email_or_domain ← supports "@acme.com" domain-level suppression
└── reason          ← unsubscribed | bounced | competitor | do_not_contact
```

**Per-lead cost attribution query (Phase 2D):**
```sql
SELECT ol.company_name, SUM(acc.cost_usd) as total_cost, COUNT(*) as llm_calls
FROM ai_call_costs acc
JOIN outbound_leads ol ON acc.lead_id = ol.id
GROUP BY ol.company_name
ORDER BY total_cost DESC;
```
This tells you which prospects cost the most to research and draft — directly actionable for tuning ICP thresholds.

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
