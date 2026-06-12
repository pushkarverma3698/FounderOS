# FounderOS — Architecture

> Every design choice in this system has a reason. This document explains what was built, how it fits together, and — critically — why each layer exists in the form it does.

---

## The Big Picture

FounderOS is a multi-agent AI system with a single interface: Telegram. You type a task. A supervisor decides which department should handle it. The department executes with real tools. If the action affects the outside world, the system pauses and waits for your explicit approval.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  YOU (Telegram mobile)                                                  │
│  "Research OpenAI DevDay and draft a LinkedIn post about it"            │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ HTTP long-poll (grammy)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  GATEWAY  (src/gateway/telegram.ts)                                     │
│                                                                         │
│  • Receives every message from Telegram                                 │
│  • Handles slash commands (/reset, /run, /workflows, /q)                │
│  • Renders Approve / Reject inline keyboard cards for HITL              │
│  • Converts Markdown → Telegram HTML (tables, code, links)             │
│  • Enforces one-process guarantee (single-instance lock)                │
│  • Bounds thread history after each clean turn                          │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ LangGraph invoke()
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  SUPERVISOR  (LangGraph createSupervisor)                               │
│  Model: Gemini 2.5 Flash — temperature 0                                │
│                                                                         │
│  Tools available to supervisor only:                                    │
│  • read_context / update_context — business context (Postgres)          │
│  • search_memory — episodic memory search                               │
│  • record_event — log significant decisions                             │
│                                                                         │
│  Routes to exactly ONE department per turn.                             │
│  Never routes to two departments in a single message.                   │
└──────────┬───────────────────────────────────────────────────────────────┘
           │
     routes to one of:
           │
    ┌──────┴──────────────────────────────────────────┐
    │                                                 │
    ▼                                                 ▼
research · comms · engineering              marketing · sales · personal · jobhunt
(read-only tools, instant)                  (write tools, HITL-gated)
    │                                                 │
    └──────────────────────┬──────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  DEPARTMENT AGENT  (LangGraph createReactAgent)                         │
│  Same model as supervisor. ReAct loop: think → call tool → observe.    │
│  Returns answer directly, OR pauses for HITL before write/send.        │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │
          (if write/send tool is called)
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  HITL GATE  (LangGraph interrupt())                                     │
│                                                                         │
│  • Graph state is saved to Postgres checkpointer                        │
│  • Telegram sends you an Approve / Reject card                          │
│  • Process can crash here — approval survives restart                   │
│  • On Approve: Command({ resume: "approved" }) → action executes        │
│  • On Reject: Command({ resume: "rejected" }) → nothing happens         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Layer 1: The Gateway

**File:** `src/gateway/telegram.ts`

The gateway is the only code that talks to Telegram. Everything else in the system is Telegram-agnostic.

### What it does

- Receives messages via grammy's long-poll (HTTP getUpdates)
- Parses slash commands and dispatches to `src/gateway/commands.ts`
- For regular messages, invokes the office (LangGraph graph)
- Renders approval cards as inline keyboard buttons
- Handles the resume flow when you tap Approve or Reject
- Formats the final reply as Telegram-compatible HTML

### Why it matters

**The gateway is the highest-risk code in the system.** It is the boundary where Telegram events become agent actions. Several production bugs originated here:

- **Duplicate bot processes** caused split message delivery (fixed: single-instance lock)
- **Stale conversation history** caused routing loops (fixed: bounded history trimmer)
- **Approval landing on the wrong process** caused silent no-ops (fixed: single-instance lock)
- **Empty checkpoint state** caused Gemini 400 errors (fixed: `assertNonEmptyMessages` guard)

The gateway has its own direct unit tests (`tests/unit/gateway/`) that exercise the run-loop logic independently of the office — because the eval harness bypasses the gateway and cannot catch gateway-layer bugs.

### Key design decisions

**Decision: grammy over node-telegram-bot-api**  
grammy is modern, TypeScript-native, and has a cleaner middleware model. It handles polling reliably without the class-inheritance patterns of older libraries.

**Decision: all commands extracted to `commands.ts`**  
`telegram.ts` hit 716 lines. Command handlers were extracted to `src/gateway/commands.ts`. The gateway now owns only message routing and HITL rendering. This makes both files testable in isolation.

**Decision: Markdown → HTML conversion in the gateway, not the agents**  
Agents write natural Markdown. The gateway converts it to Telegram-safe HTML before sending. This keeps agents clean of Telegram-specific formatting knowledge, and lets us fix rendering bugs in one place.

---

## Layer 2: The Supervisor

**File:** `src/agents/office.ts` (inside `buildOffice()`)

The supervisor is a LangGraph `createSupervisor` node. It reads your message, consults business context, and hands off to exactly one department.

### Why a supervisor pattern?

The alternative is to send every message to every department and let them compete. This creates three problems:

1. **Ambiguous actions:** "Send an email to myself with the research summary" requires sequencing research → comms, not simultaneous execution
2. **Tool collisions:** if two departments share tools, routing is undefined
3. **Cost:** every department runs = every department burns tokens

The supervisor solves this by being the single router. One message, one department, one execution thread.

### Why temperature = 0?

Routing must be deterministic. If the supervisor routes "write a cold email to Stripe" to `comms` on Monday and `sales` on Tuesday, the system is unreliable for daily use. Temperature = 0 means the same input produces the same routing decision every time. This is not about making the model "dumb" — it's about making routing auditable.

### What the supervisor knows

The supervisor has four tools that no department has:

- `read_context` — reads business context (company bio, ICP, goals) from Postgres
- `update_context` — writes updated context when the founder shares new info
- `search_memory` — queries episodic memory (what did we decide about X last week?)
- `record_event` — logs significant decisions for future retrieval

This means the supervisor carries the "who are we and what are we trying to do" context. Departments don't need to re-ask.

---

## Layer 3: Departments (ReAct Agents)

**File:** `src/agents/office.ts` (department definitions), `src/agents/agent-tools/` (tool wrappers)

Each department is a LangGraph `createReactAgent` — a model that runs a Reason-Act loop: think about what to do, call a tool, observe the result, repeat until done.

### Why ReAct instead of a fixed workflow?

Fixed workflows are brittle. "Research a company, then draft an email" seems simple until the research returns nothing (retry with different query?), or returns too much (summarize first?), or the company has a known LinkedIn policy (skip email, use LinkedIn instead?).

A ReAct agent handles these branches naturally. The model decides what to do next based on what it just saw. This is the right abstraction for open-ended tasks.

### The two-layer tool architecture

Every tool is implemented in two layers:

```
Layer 1: src/tools/{name}.ts
  - Pure business logic
  - No LangGraph imports
  - execute(args) → { success, data, error }
  - Testable without the agent framework
  - Used directly by probe scripts and the MCP server

Layer 2: src/agents/agent-tools/{dept}.ts
  - LangChain tool() wrapper with Zod schema
  - Adds HITL gate for write operations
  - Calls Layer 1 internally
  - Registers with the department agent
```

**Why two layers?**

When we first built FounderOS v1, business logic was mixed with LangGraph code. This meant:
- Tests had to mock LangGraph internals just to test "does this email get formatted correctly?"
- Probe scripts couldn't call tools without spinning up a full agent
- The MCP server couldn't reuse tools without importing the agent

The two-layer split fixed all three. `src/tools/` is pure TypeScript that can be imported anywhere. `agent-tools/` is the thin LangGraph adapter layer.

---

## Layer 4: HITL (Human-in-the-Loop)

**Files:** `src/agents/agent-tools/{dept}.ts` (gate logic), `src/gateway/telegram.ts` (card rendering), `src/db/schema.ts` (`interrupt_registry` table)

The HITL gate is the most important safety mechanism in FounderOS. It runs before every write, send, or destructive action.

### How it works

```typescript
// Tool wrapper pseudocode
async function sendEmail({ to, subject, body }) {
  // 1. Validation only — this runs TWICE (before and after interrupt)
  //    No HTTP calls, no DB writes above this line.

  // 2. Write intent to DB (crash-safe: if we crash here, intent is persisted)
  await db.interrupt_registry.insert({ action: "send_email", payload: { to, subject, body } });

  // 3. Pause — graph state is checkpointed to Postgres
  const approval = interrupt({ action: "send_email", preview: `To: ${to}\n${body}` });

  // 4. Resume — approval or rejection
  if (approval !== "approved") return "❌ Rejected by founder.";

  // 5. Execute — only runs AFTER approval
  const result = await emailTool.execute({ to, subject, body });
  if (!result.success) return `Failed: ${result.error}`;

  // 6. Audit — idempotency key prevents double-send
  await writeAuditEntry({ action: "send_email", idempotency_key: hash({ to, subject }), payload: { to } });
  return "✅ Email sent";
}
```

### Why `interrupt()` runs twice

LangGraph pauses execution by throwing a special exception when `interrupt()` is called. The graph state is saved. When you tap Approve, LangGraph restores state and re-executes the tool function from the top. `interrupt()` is called again — this time it immediately returns the stored resume value ("approved" or "rejected").

This means every line above `interrupt()` runs twice. **Keep it pure.** No HTTP calls, no DB writes. Only validation.

### Why DB-backed before calling `interrupt()`

The `interrupt_registry` table is written before `interrupt()` is called. If the process crashes between writing to DB and calling interrupt, the intent is preserved. On restart, the gateway can recover pending approvals from the registry.

This is the difference between "it probably works" and "it will always work."

### Why approval cards render inline buttons (not a URL)

We considered sending a web URL like `https://founderos.app/approve?id=abc`. The problem: you'd need a browser, a login, a web server, TLS. Two taps on Telegram beats that every time. Inline keyboards are native, fast, and work on any device where Telegram is installed.

---

## Layer 5: State Persistence

**Files:** `src/db/schema.ts`, LangGraph Postgres checkpointer

### How conversation state is stored

Every message exchange is part of a **thread** in LangGraph. The thread ID is `turicks:{chatId}` — one thread per Telegram chat, namespaced by tenant.

Thread state is persisted to Postgres after every step via the `@langchain/langgraph-checkpoint-postgres` checkpointer. This means:

- A process crash between steps loses nothing
- Pending HITL approvals survive restarts
- Conversation history is durable and queryable

### The history bounding problem

We discovered a critical production bug: **unbounded conversation history causes routing loops.**

Here's why: LangGraph passes the full thread history to the model on every invocation. As the thread grows (days of use), the model starts anchoring on old context — a prior HITL "yes", a stale routing decision, an old refusal. The supervisor starts replying to old state, not new messages.

The fix (`src/infra/history-window.ts`) trims the persisted thread to the last 12 human turns after each clean turn. This runs AFTER the reply is sent, and is guarded to never run while a HITL approval is pending (trimming during an interrupt would corrupt the checkpoint).

**The 12-turn default** was chosen empirically: enough for multi-turn follow-ups ("show me the file" → "now send it to me"), small enough to prevent context drift. It's configurable via `HISTORY_KEEP_TURNS` env.

### What's in Postgres

| Table | Purpose |
|---|---|
| `checkpoints` | LangGraph thread state (managed by checkpointer) |
| `interrupt_registry` | Pending HITL approvals (crash-safe) |
| `action_log` | Audit trail — every send/write with idempotency key |
| `knowledge_entries` | Turicks-brain — business knowledge, synced from docs/ |
| `episodic_memory` | Significant decisions and session summaries |
| `context_entries` | Business context (company bio, ICP, goals) |

---

## Layer 6: Idempotency

**File:** `src/db/queries.ts` (`hasBeenAudited`, `writeAuditEntry`)

Every external action that can't be undone uses an idempotency key. The key is a SHA-1 hash of the action parameters. Before executing:

```typescript
const key = sha1({ action: "send_email", to, subject });
if (await hasBeenAudited(key)) return; // Already sent — skip
// ... execute ...
await writeAuditEntry({ action: "send_email", idempotency_key: key });
```

**Why this matters:** If you tap Approve, the email is sent and the key is written. If you tap Approve again (double-tap, network retry), `hasBeenAudited` returns true and the action is skipped. The email is never sent twice.

Without idempotency, a user who taps Approve on a shaky network connection might send the same email twice. This is unacceptable for outreach.

---

## Layer 7: The Model

**File:** `src/agents/model.ts`

### One model, one configuration

Supervisor and all 8 department agents run the same model: `gemini-2.5-flash`, temperature = 0. This was a deliberate simplification.

v1 had a 6-tier multi-provider cascade (Claude → GPT → Gemini, depending on context). The complexity was justified by early uncertainty about which model would route best. After production use, the answer was clear: Gemini Flash routes correctly and is fast. One model is simpler to debug, cheaper to run, and more predictable.

### The 503 fallback

Google capacity spikes happen. When they do, Gemini returns 503. We handle this with a minimal fallback cascade:

```
gemini-2.5-flash → gemini-2.0-flash
```

Important: **deprecated models are not in the fallback chain.** `gemini-1.5-flash` and `gemini-2.0-flash-001` were removed after they returned 404 errors in June 2026. The fallback chain is validated against the real API on every update.

Non-503 errors (400, 401, 404) are re-thrown immediately — not silently swallowed. A 400 means the request is malformed. Retrying with a different model won't help. The error surfaces to Telegram so the founder knows something is wrong.

---

## Layer 8: The Eval Harness

**Files:** `src/eval/golden-tasks.ts`, `src/eval/runner.ts`, `src/eval/scoring.ts`

Production LLM systems drift. A prompt change that looks harmless can break routing. The eval harness catches this before merge.

### How it works

24 golden tasks are stored in `golden-tasks.ts`. Each task has:
- An input message
- Expected department routing (`"engineering"`, `"research"`, etc.)
- Expected tool calls (`["search_web"]`, `["github_read"]`, etc.)
- Whether HITL should trigger (`true` / `false`)

On `pnpm eval`, the eval runner:
1. Sends each task through the real office with a fresh MemorySaver (not the persistent Postgres checkpointer)
2. Records which department was routed to, which tools were called, whether HITL triggered
3. Scores against the golden expectation
4. Outputs a JSON report with pass/fail per task

HITL approval never executes in eval — the runner detects the interrupt and records "HITL triggered" without approving. This is intentional: eval should never send real emails.

### Current scores

| Metric | Score |
|---|---|
| Routing accuracy | 23/24 — 96% |
| Tool selection | 20/20 — 100% |
| HITL coverage | 21/23 — 91% |

The 3 failures are documented and acceptable: one requires a file that doesn't exist in the eval environment, one hits a Firecrawl timeout, one is reachable via `/run weekly_digest` but not natural language.

---

## Layer 9: Workflows

**Files:** `src/workflows/registry.ts`, `src/workflows/runner.ts`, `src/workflows/types.ts`

Workflows are named, parameterized multi-step procedures over the existing office. A workflow is not a new agent — it uses the same supervisor and departments.

Built-in workflows:
- `onboarding` — score company ICP → research → draft email → create repo
- `outbound` — score ICP → draft hook → draft cold email
- `weekly_digest` — pull episodic memory → surface open items → draft Monday plan

Invoked via `/run onboarding company="Acme Corp"`.

**Why workflows over just writing a multi-step message?**

A single message like "research Acme and draft a cold email" works. But a workflow adds:
- Named parameters that validate input types
- Step-level status updates ("Step 1/3: Researching ICP...")
- Ability to abort at any step if you reject a HITL
- Replayability — run the same workflow for every new lead

Workflows are typed TypeScript (`WorkflowDef`, `WorkflowStep`), not YAML. This means they're compile-checked and testable.

---

## The MCP Server

**File:** `src/mcp/server.ts`

FounderOS exposes its own MCP server on port 3100, giving Claude Code (and any MCP-compatible client) direct access to FounderOS data:

| Tool | Description |
|---|---|
| `search_web` | Firecrawl web search |
| `read_context` | Business context from Postgres |
| `search_knowledge` | Turicks-brain knowledge search |
| `search_memory` | Episodic memory search |
| `read_cv` | Career/CV data from personal-rag |
| `github_read` | GitHub repository access |

This means Claude Code can answer "what do we know about Stripe?" by calling `search_knowledge` directly, without going through the Telegram interface.

---

## What Was Explicitly Left Out

Understanding what FounderOS does NOT do is as important as understanding what it does.

| Feature | Status | Reasoning |
|---|---|---|
| Web dashboard | Not built | 3 weeks to build; Telegram works better for mobile approvals |
| Multi-tenant routing | Not built | Single-user reliability first; SaaS is Phase E |
| YAML-defined workflows | Not built | Typed TypeScript is compile-checked and harder to corrupt |
| Tool registry / allowed_tools | Removed in v2 | Was a source of bugs; tools are wired directly |
| Automatic sends | Never | This is a safety constraint, not a missing feature |
| Redis | Installed, not active | Reserved for SaaS quota management; not needed single-tenant |
| Prospecting department | Merged into research | Had zero unique tools; routing collision removed |
| LinkedIn in comms | Removed | Was duplicated in marketing; each tool has exactly one owner |

---

*For the decisions that shaped each of these choices, see [DECISIONS.md](./DECISIONS.md).*
