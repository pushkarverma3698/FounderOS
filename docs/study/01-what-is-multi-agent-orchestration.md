# What is Multi-Agent Orchestration?

*A ground-up explanation written for Pushkar — no CS degree required.*

---

## The Simple Idea

A **single LLM** is like a brilliant freelancer who does everything alone: they read your message, think, and write back. That works for simple tasks.

**Multi-agent orchestration** means you have a **team** — each member is a specialist with their own tools, and a **manager** decides who handles what.

Think of it like running Turicks:
- You (the founder) take in a client request
- You hand it to the right person: designer, developer, or sales person
- Each person uses their own tools (Figma, VS Code, HubSpot)
- Nothing leaves the building without your sign-off

FounderOS is that team, but in software. As of v2 (production since 2026-06-14) it runs
**8 departments** under a single supervisor — the architecture locked and hardened through
6 production phases.

---

## The Three Building Blocks

### 1. The Agent
An **agent** is an LLM that can take actions, not just answer questions.

```
Message → [LLM thinks] → "I need to search the web"
                       → [calls search_web tool]
                       → reads results
                       → "I need to search again for more detail"
                       → [calls search_web again]
                       → "I have enough, here's my answer"
```

This loop — think, act, observe, repeat — is called **ReAct** (Reasoning + Acting). It's the standard pattern for agents that use tools.

### 2. The Tool
A **tool** is a function the agent can call. It takes typed inputs, does something real, and returns a result.

```typescript
// The agent "calls" this like a function
const searchWeb = tool(
  async ({ query }) => {
    const results = await firecrawl.search(query);
    return results.map(r => `${r.title}: ${r.snippet}`).join("\n");
  },
  { name: "search_web", schema: z.object({ query: z.string() }) }
);
```

**Read-only tools** (web search, GitHub read) run immediately.  
**Write tools** (email send, GitHub create) pause and ask you to approve first. That pause is called an **interrupt**.

### 3. The Supervisor
A **supervisor** is an agent whose only job is to **delegate** to other agents. It never does the work itself.

```
Your message → Supervisor LLM thinks: "This is a research task"
             → handoff to research agent
             → research agent runs with its tools
             → returns result to supervisor
             → supervisor summarises and replies to you
```

---

## Why Not Just One Agent?

You could give one agent all the tools and one giant prompt. Here's why specialists are better:

| One Giant Agent | Supervisor + Specialists |
|-----------------|--------------------------|
| Confused by too many tools | Each agent has 2–6 focused tools |
| One prompt for all contexts | Each agent has a prompt tuned for its job |
| Hard to test and debug | Each specialist tested independently |
| Failure in one task breaks everything | Isolated failures, clean handoffs |
| Hard to add new capabilities | Add a new agent in 10 lines |

In practice: a research agent doesn't need to know about email formatting rules. An email
agent doesn't need to know about GitHub repos. A personal-laptop agent must never touch
GitHub credentials. Focused = better quality + security (least-privilege, ADR-013).

---

## The HITL Pattern (Human-in-the-Loop)

Before the agent sends an email, posts on LinkedIn, or pushes to GitHub, it **stops and asks you**. This is called HITL — Human-in-the-Loop.

In FounderOS this works via LangGraph's `interrupt()`:

```
Agent calls send_email tool
  → tool calls interrupt({ title: "Send email to X?", preview: body })
  → graph PAUSES (state saved to Postgres — crash-safe)
  → Telegram sends you an Approve/Reject card
  → You tap Approve
  → graph RESUMES, tool continues, email actually sends
```

**The key insight**: the email sends *after* approval on the exact same tool call — not in a separate "finalize" node. This means "approve → nothing happens" is structurally impossible.

---

## Orchestration Patterns (from simple to complex)

### Pattern 1: Single Agent (simplest)
```
User → Agent (has all tools) → Result
```
Good for: personal assistants with < 5 tools. You can hold the whole thing in your head.

### Pattern 2: Supervisor + Specialists (FounderOS v2)
```
User → Supervisor → Admin      (context, memory, signals)
                  → Research   (search_web, turicks-brain)
                  → Comms      (gmail, calendar)
                  → Engineering (github, claude_code)
                  → Marketing  (linkedin_post, brand)
                  → Sales      (cold outreach, ICP scoring)
                  → Personal   (files, shell, browser on founder's Mac)
                  → Jobhunt    (CV, job search, applications)
```
Good for: 4–8 tools split across clear departments. Easy to extend. FounderOS runs 8
departments today with ~30 total tools — all single-owner (no tool belongs to two depts).

### Pattern 3: Hierarchical Supervisor
```
User → CEO → Revenue Supervisor → Marketing Agent (linkedin_post)
                                 → Sales Agent (send_email)
          → Engineering Supervisor → Coder Agent (claude_code)
                                   → QA Agent
                                   → DevOps Agent (github_write)
```
Good for: departments that themselves have sub-specialists. FounderOS has **proven** this
works via integration test (`nested-hitl.test.ts`) — HITL `interrupt()` surfaces correctly
through 3 levels. Both the engineering subgraph and revenue subgraph exist in code, but
are **not in production yet** — gated on a real coordination trigger (ADR-025/027: only
nest when a domain genuinely needs ≥2 coordinating sub-agents, not preemptively).

### Pattern 4: Parallel Agents
```
User → Orchestrator → Research Agent  ─┐
                    → Comms Agent     ─┼→ Merge → Result
                    → Eng Agent       ─┘
```
Good for: tasks that are genuinely independent (e.g. research three companies simultaneously).
LangGraph supports this via `Send` edges; FounderOS doesn't use it yet — sequential routing
handles all current use cases.

**FounderOS current position**: Pattern 2 (flat 8-dept supervisor). Pattern 3 capability
proven but production-gated. Move to Pattern 3 only when a department grows to 2+ agents
that genuinely coordinate (ADR-027: tool count + coordination trigger).

---

## The State Machine Mental Model

LangGraph builds agents as **graphs** — nodes are actions, edges are transitions.

```
START
  │
  ▼
[supervisor] — picks which agent to call
  │
  ▼
[research | comms | engineering]  — specialist runs its ReAct loop
  │
  ├── calls tool → gets result → loops back to LLM
  ├── calls write tool → interrupt() → PAUSE (you approve/reject)
  │                                  → RESUME on same node
  │
  ▼
[supervisor] — sees the result, decides if done or routes again
  │
  ▼
END → final reply sent to Telegram
```

**State** is everything in `messages[]`. Every node reads from it and writes to it. The Postgres checkpointer saves state after every node — so if the process crashes during a pending approval, you can restart and the approval is still waiting.

---

## Memory in Agents

| Type | How | FounderOS |
|------|-----|-----------|
| **Short-term** | `messages[]` in graph state | All — every run has a messages history, bounded to 12 human turns |
| **Long-term / per-user** | Postgres via checkpointer | Each chat has a stable `thread_id` — memory persists across messages |
| **External knowledge** | RAG / vector DB | **Live** — `turicks-brain` (pgvector, business docs) + `personal-rag` (CV/career). `admin` dept queries both. |
| **Episodic memory** | `episodic_memory` Postgres table | `record_event` tool; queryable by `search_memory` |
| **Business context** | `context` Postgres table | `read_context` / `update_context` tools (admin dept) |
| **Tool state** | Returned in tool result | `action_log` table tracks every send (idempotency + audit) |

---

## Recommended Reading (in order)

1. [LangGraph JS Concepts](https://langchain-ai.github.io/langgraphjs/concepts/) — official, 30 min
2. [ReAct paper](https://arxiv.org/abs/2210.03629) — the original think/act loop, 20 min
3. [Multi-agent supervisor tutorial](https://langchain-ai.github.io/langgraphjs/tutorials/multi_agent/agent_supervisor/) — code + explanation, 45 min
4. The FounderOS source: `src/agents/office.ts` — you built it, read it

---

---

## The Quality Gate Stack

Before any external action executes, FounderOS runs a layered set of guards. As a
multi-agent system, this is important: agents can hallucinate, sycophancy can produce
low-quality copy, and writes without human approval are dangerous.

```
Draft output
  → [Gate 1] Brand validator (deterministic regex)
  → [Gate 2] Claude judge (different model family → no self-agreement)
  → [Gate 3] HITL interrupt() (mandatory human approval)
  → [Idempotency check] (duplicate-send prevention)
  → [Suppression check] (do-not-contact list)
  → Actual send
```

The critical design principle: **Gates 1 and 2 are advisory; Gate 3 is mandatory.** The
human is always the final approver for external side effects. See
[05-safety-and-quality-gates.md](./05-safety-and-quality-gates.md) for the full picture.

---

*See next: [02-langgraph-patterns.md](./02-langgraph-patterns.md) — the specific LangGraph primitives used in FounderOS and why.*
