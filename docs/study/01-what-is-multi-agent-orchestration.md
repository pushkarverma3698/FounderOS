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

FounderOS is that team, but in software.

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
| Confused by too many tools | Each agent has 2–4 focused tools |
| One prompt for all contexts | Each agent has a prompt tuned for its job |
| Hard to test and debug | Each specialist tested independently |
| Failure in one task breaks everything | Isolated failures, clean handoffs |
| Hard to add new capabilities | Add a new agent in 10 lines |

In practice: a research agent doesn't need to know about email formatting rules. An email agent doesn't need to know about GitHub repos. Focused = better quality.

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
User → Supervisor → Research Agent (search_web)
                  → Comms Agent (email, linkedin)
                  → Engineering Agent (github)
```
Good for: 3–10 tools split across clear departments. Easy to extend.

### Pattern 3: Hierarchical Supervisor
```
User → CEO → Sales Supervisor → BDR Agent
                               → Lead Intel Agent
          → Engineering Supervisor → Senior Dev Agent
                                   → QA Agent
```
Good for: large teams where each department itself has sub-specialists. Adds latency and complexity — only justified when a single specialist genuinely can't handle a department's breadth.

### Pattern 4: Parallel Agents
```
User → Orchestrator → Research Agent  ─┐
                    → Comms Agent     ─┼→ Merge → Result
                    → Eng Agent       ─┘
```
Good for: tasks that are genuinely independent (e.g. research three companies simultaneously). Harder to implement — use when you've proven sequential is too slow.

**FounderOS current position**: Pattern 2. Move to Pattern 3 only when a department grows to 3+ tools that genuinely need independent management.

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
| **Short-term** | `messages[]` in graph state | All — every run has a messages history |
| **Long-term / per-user** | Postgres via checkpointer | Each chat has a stable `thread_id` — memory persists across messages |
| **External knowledge** | RAG / vector DB | Not yet in v2 — planned (turicks-brain integration) |
| **Tool state** | Returned in tool result | `audit_log` table tracks what was sent |

---

## Recommended Reading (in order)

1. [LangGraph JS Concepts](https://langchain-ai.github.io/langgraphjs/concepts/) — official, 30 min
2. [ReAct paper](https://arxiv.org/abs/2210.03629) — the original think/act loop, 20 min
3. [Multi-agent supervisor tutorial](https://langchain-ai.github.io/langgraphjs/tutorials/multi_agent/agent_supervisor/) — code + explanation, 45 min
4. The FounderOS source: `src/agents/office.ts` — you built it, read it

---

*See next: [02-langgraph-patterns.md](./02-langgraph-patterns.md) — the specific LangGraph primitives used in FounderOS and why.*
