# AI Systems — Agents, RAG, Critic Pattern, Evaluation

> Study guide for the AI-specific concepts in FounderOS. Covers agent architecture, prompt engineering, evaluation, and common interview questions.

---

## Agents vs Chains vs RAG — Clear Definitions

**Chain:** A fixed sequence of LLM calls. Input → LLM1 → LLM2 → Output. No branching, no state, no tool use. Useful for simple pipelines (translate then summarise).

**Agent:** An LLM that decides what to do next based on observations. The LLM receives a task + available tools, calls tools, observes results, and loops until it decides it's done. Non-deterministic by nature.

**Agentic workflow (FounderOS approach):** Fixed graph of specialized nodes, not a free-roaming agent. The supervisor routes to a department, nodes run in a defined sequence, and the critic enforces quality. More predictable than pure agents, more flexible than chains.

**RAG (Retrieval-Augmented Generation):** Retrieve relevant documents from a vector store before generating. Reduces hallucination for domain-specific knowledge. FounderOS uses SQL few-shot from `agent_results` table at Phase 2 scale (< 10k rows); will add ChromaDB per company when that threshold is crossed (Phase 3).

---

## The Critic Pattern — Deep Dive

### Why Same-Model Self-Critique Fails

RLHF (Reinforcement Learning from Human Feedback) trains models to produce text that humans rate highly. A model evaluating its own output will apply the same learned preferences that produced that output — it will rate it highly. This is sycophancy at the training data level.

**Tested this directly:** Gemini Flash generating and reviewing its own sales email with explicit rules like "BANNED: 'I wanted to reach out'" → it approved emails containing the exact banned phrase, rationalising "this establishes rapport."

### Why Cross-Family Works

Different model families have:
- Different training corpora (different sources, different eras)
- Different RLHF processes (different evaluator preferences)
- Different instruction-following strengths (Claude is notably rule-following; Gemini is more creative)

Pairing **Gemini Flash (generator)** with **Claude Haiku (critic)** creates genuine adversarial review. Claude's instruction-following strength makes it good at checking a checklist of rules.

### The Critic Prompt Structure

```
SYSTEM: You are a quality control agent reviewing AI-generated content.
        Review the output against the rules below.
        Return JSON: { result: "APPROVED"|"NEEDS_REVISION", notes: string, rule_violations: string[] }

RULES: [contents of governance/critique-rules.md, department section]

TASK: Review this [email/code/post] for the [sales/engineering/marketing] department.

OUTPUT TO REVIEW:
[the generator's output]
```

Key design choices:
1. **Structured JSON output** — not free text. Easier to parse reliably than extracting from prose.
2. **Rules from file** — `critique-rules.md` is loaded at runtime. Rules are versioned in git, not in code.
3. **Return the violations explicitly** — `rule_violations: ["Banned phrase found: 'I wanted to reach out'"]` — the generator node uses this to fix the specific issues on retry.

---

## Prompt Engineering Patterns

### System vs Task Prompts

```
SYSTEM prompt: Who the agent is + general rules
               Changes rarely — maybe once per sprint
               
TASK prompt:   What to do right now
               Changes per invocation — includes context, variables
```

In FounderOS, `src/core/prompts.ts` separates these:
```typescript
getSystem("OUTREACH_AGENT") // → who the BDR agent is, tone, approach
getPrompt("OUTREACH_EMAIL", { company_name: "Acme", pain_point: "manual invoicing" })
// → specific email task with context injected
```

### `{{varName}}` Placeholder Syntax

Python used `{varName}` for template substitution. This conflicts with TypeScript template literals `${varName}`. FounderOS uses double-brace `{{varName}}`:

```typescript
const template = "Draft a cold email to {{company_name}} addressing {{pain_point}}.";
const result = applyVars(template, { company_name: "Acme", pain_point: "manual invoicing" });
// → "Draft a cold email to Acme addressing manual invoicing."
```

```typescript
function applyVars(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [key, val]) => acc.replaceAll(`{{${key}}}`, val),
    template,
  );
}
```

### Role Prompting

Each agent in the registry has a corresponding system prompt that establishes its role, style, and constraints:

```
CEO Prompt: You are FounderOS CEO. Your ONLY job is to classify tasks and route them.
            Output JSON: { department: "sales"|"engineering"|"marketing", reasoning: string }
            Do NOT perform the task. Do NOT write emails. Just classify.

BDR Prompt: You are an outbound BDR for Turicks, an AI agency...
            Pain-first: always open with the prospect's problem.
            Word count: outreach emails ≤ 150 words.
```

**Key insight:** CEO prompt explicitly says "ONLY classify." Without this constraint, frontier models try to be helpful and start writing the email instead of just routing. The `ONLY` emphasis matters.

---

## Model Cascade — The Strategy

### Why Not Just Use GPT-4 for Everything

1. **Cost** — Claude Sonnet 4.5 is $3/$15 per 1M in/out tokens. Gemini Flash is $0.075/$0.30. For bulk operations (lead intel scraping, nano-tasks), the 20x cost difference matters at scale.

2. **Latency** — Large models are slower. A nano-task like "format this as a standup update" doesn't need Sonnet — Gemini Flash-Lite completes in 200ms vs 2s.

3. **Availability** — If Anthropic has an outage, fall back to Google. If Google is slow, try OpenRouter. Single-provider dependency is a reliability risk.

### Cascade Design Principle

**Primary:** Best model for the task (quality-optimised)  
**Secondary:** Good model from a different provider (reliability fallback)  
**Tertiary:** Free/cheap model (cost fallback, never returns nothing)

```
CEO tier: claude-sonnet-4-5 → gemini-2.5-pro → gemini-flash
         (best quality)       (different family) (always available)
```

### Circuit Breaker + Rate Limiter

**Circuit breaker (opossum):** Tracks failure rate per `provider:model` key. After 3 failures in a window → circuit opens → that entry is skipped for 5 minutes. This prevents hammering a failing API.

**Rate limiter (bottleneck):** Global shared limiter. Max 5 concurrent LLM calls, min 200ms between calls. Prevents 429 rate limit errors from providers.

```
Task arrives → Bottleneck schedules call → Circuit breaker checks state
→ If CLOSED: call LLM
→ If OPEN: skip to next cascade entry
→ All entries failed: throw AggregateError
```

---

## Evaluation Strategy

### Current (Phase 1)

- LangSmith traces every run — inputs, outputs, latency, token count visible in dashboard
- `CritiqueRecord` in state history — can query for approval/revision rates
- Manual spot-checking by founder (the actual human-in-the-loop)

### Next Steps (Phase 2+)

**LangSmith Datasets:**
1. Collect 50+ examples of good/bad sales emails, code outputs, LinkedIn posts
2. Label them: `{ input, expected_output, verdict: "good"|"bad" }`
3. Create a LangSmith dataset and run evals on prompt changes

**Regression Testing:**
Before merging a prompt change, run the eval suite:
```bash
npx tsx scripts/run-evals.ts --dataset sales-email-v1
# Compares critic approval rate on known-good examples vs baseline
```

**Metrics to track:**
- Critic approval rate (high = generator improving OR critic too lenient)
- Revision count per run (lower = better quality first-pass)
- Human rejection rate (HITL rejections = ground truth on quality)
- LLM cost per approved output (efficiency metric)

---

## Common Interview Questions

**"What's the difference between a ReAct agent and a structured workflow?"**

> "ReAct (Reason + Act) is the pattern where an LLM decides which tool to call based on its reasoning about the current state. It's flexible but non-deterministic — the LLM might take unexpected paths. FounderOS uses a structured workflow: the graph topology is fixed (lead_intel → bdr → critic → hitl), but each node uses an LLM to decide HOW to perform its step. This gives us predictability for operational workflows while retaining LLM flexibility for the actual work."

**"How do you handle prompt injection attacks?"**

> "Two defenses: First, agents only receive structured input (not raw user text injected into prompts). Lead intel node gets a URL, not a user-controlled prompt. Second, the critic pattern provides a second-LLM check — even if a prompt injection tricks the generator, the critic (different provider, different system prompt) evaluates the output against our rules. We also validate all external API responses with Zod."

**"How do you know when an agent output is 'good enough' without human review?"**

> "We don't rely on the agent to judge itself. The critic node is a separate LLM from a different model family with explicit rules from `governance/critique-rules.md`. It returns a structured verdict with specific violations. 'Good enough' means: no rule violations from the critic. The human still sees the output for final approval, but the critic dramatically reduces the revision rate before it reaches HITL."

**"What is context window management for long-running agents?"**

> "In our generator-critic loop, the messages array grows with each revision cycle. For long-running tasks, we manage this by: (1) keeping only the last N messages in the messages array using LangGraph's `messagesStateReducer` which deduplicates by message ID; (2) the generator receives only the current draft and the latest critique, not the entire history; (3) for truly long tasks, we summarise previous steps into a `summary` field and pass that instead of raw messages. This prevents context window exhaustion on the LLM side."

---

## ICP Scoring with Banded Thresholds

### What ICP Scoring Is

ICP = Ideal Customer Profile. The `icp_score_node` in ProspectingPod scores a prospect on a 0.0–1.0 scale based on fit criteria:

**Turicks ICP:**
- AI-forward company (they value AI tooling)
- 10–200 employees (big enough to pay, small enough to move fast)
- B2B SaaS or tech-enabled services
- Has a software team (they can evaluate technical proposals)

### Why Banded Thresholds, Not Binary

Binary approach (≥ 0.5 = qualify, < 0.5 = reject):
- Wastes money sending CEO-tier model calls to marginal leads
- No middle ground between "yes" and "no"

**Banded approach:**
```
score < 0.4   → Disqualified — Telegram notification only, stop
score 0.4–0.69 → MD tier (Gemini Flash) — lighter model for lower-value lead
score ≥ 0.70  → CEO tier (Claude Sonnet) — best model for hot prospect
```

**What this achieves:**
1. Cost proportional to lead quality — warm leads cost ~$0.002, hot leads ~$0.04
2. Quality proportional to lead quality — best writing for the best prospects
3. No wasted human review for clearly poor fits

**Interview framing:**
> "The system automatically allocates LLM spend based on signal quality. A borderline lead gets Gemini Flash — fast, cheap, good enough. A high-fit lead gets Claude Sonnet — our best model for the highest-value outreach. This is resource allocation baked into the graph topology."

### `route_by_score` is a Pure Function

Critical implementation detail: `route_by_score` is a LangGraph conditional edge (pure function), not a node.

```typescript
// Conditional edge — pure function, no side effects
function routeByScore(state: ProspectingState): string {
  const score = state.icp_score ?? 0;
  if (score < 0.4) return "disqualified";
  if (score < 0.70) return "sales_md";
  return "sales_ceo";
}
```

It reads state, returns a routing string. **No LLM calls, no DB writes, no tool invocations.** Those belong in nodes. This keeps the graph deterministic and testable.

---

## Prompt Response Caching Strategy

### What We Cache

The `callCascade` function in `src/infra/llm.ts` has an optional Redis cache layer:

```typescript
// Before calling the LLM:
if (tier !== "ceo") {
  const hash = sha256(JSON.stringify({ tier, systemPrompt, userPrompt }));
  const cached = await redis.get(KEYS.llmCache(hash));
  if (cached) return JSON.parse(cached) as LLMResult;
}

// After calling the LLM:
if (tier !== "ceo") {
  await redis.setex(KEYS.llmCache(hash), TTL[tier], JSON.stringify(result));
}
```

### TTL Rationale per Tier

| Tier | TTL | Reasoning |
|------|-----|-----------|
| CEO | 0 (never cached) | Supervisor routing decisions must be fresh — stale routing = wrong department |
| MD | 3600 (1 hour) | Research and scoring prompts are stable enough to cache short-term |
| NANO | 86400 (24 hours) | Formatting tasks (standup summaries, date normalisation) rarely change |

**Why CEO is never cached:**
The CEO tier runs the supervisor node which classifies tasks and routes to departments. If a user sends "fix the auth bug" and then "prepare the sales deck" — the second request must not get the routing decision from the first. Caching supervisor decisions would corrupt the graph execution.

**When caching saves money:**
```
/prospect acme.com (first run)
  → research_node NANO tier — cache miss — calls Gemini Flash Lite — cost: $0.0002
  → Result cached in Redis for 24h

/prospect acme.com (second run, same day)
  → research_node NANO tier — cache HIT — cost: $0.00
```

For repeat prospects (founder runs the command twice, or scrape worker re-indexes), the cache eliminates redundant LLM calls entirely.

---

## Per-Lead Cost Attribution

### The Pattern

Every `callCascade()` call accepts an optional `leadId` parameter:

```typescript
const result = await callCascade({
  tier: "md",
  agent: "icp_scorer",
  tenantId: "turicks",
  leadId: state.lead_id,   // ← FK to outbound_leads row
  systemPrompt: SYSTEM.ICP_SCORER,
  userPrompt: buildIcpPrompt(state.research),
});
```

This gets written to `ai_call_costs`:

```typescript
await db.insert(aiCallCosts).values({
  tenant_id, agent, tier, model,
  tokens_in, tokens_out, cost_usd,
  lead_id: opts.leadId ?? null,   // ← nullable FK
});
```

### What It Enables

```sql
-- Which prospects are most expensive to qualify?
SELECT ol.company_name,
       SUM(acc.cost_usd)  AS total_cost_usd,
       COUNT(*)           AS llm_calls,
       MAX(ol.icp_score)  AS icp_score
FROM ai_call_costs acc
JOIN outbound_leads ol ON acc.lead_id = ol.id
GROUP BY ol.company_name
ORDER BY total_cost_usd DESC;
```

**Practical insight:** If a disqualified lead costs as much as a won lead, your ICP scoring is wrong. The cost-per-lead view reveals this.

**Interview framing:**
> "We tag every LLM call with a lead_id at the time of the call — not after the fact. This gives us a cost accounting system per prospect. We can answer 'how much did it cost to qualify Acme Corp and ultimately win them?' That attribution data feeds back into ICP threshold tuning."
