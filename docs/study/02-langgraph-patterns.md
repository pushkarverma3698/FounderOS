# LangGraph JS — Patterns Used in FounderOS

*The specific primitives, why they exist, and how they map to our code.*

---

## The Core Primitive: StateGraph

Everything in LangGraph is a **StateGraph** — a directed graph where:
- **Nodes** are functions that read state and return partial updates
- **Edges** are transitions between nodes
- **State** is shared across all nodes via a typed annotation schema

```typescript
const graph = new StateGraph(MyAnnotation)
  .addNode("nodeA", nodeAFn)
  .addNode("nodeB", nodeBFn)
  .addEdge(START, "nodeA")
  .addEdge("nodeA", "nodeB")
  .addEdge("nodeB", END)
  .compile({ checkpointer });
```

**FounderOS v2 doesn't write this directly.** Instead it uses two prebuilt abstractions that LangGraph provides — `createReactAgent` and `createSupervisor` — which build the StateGraph internally. You get the power without writing the plumbing.

---

## `createAgent` — The Specialist Agent

FounderOS uses `createAgent` from `"langchain"` (the current abstraction over
`createReactAgent`). Give it a model, tools, a name, and middleware — it builds the full
think/act/observe loop automatically.

```typescript
import { createAgent } from "langchain";

const research = createAgent({
  model: getModel(),
  tools: DEPARTMENT_TOOLS["research"]!,  // from capabilities.ts
  name: "research",
  description: "Use for web facts, news, company research, and Turicks knowledge lookups.",
  includeAgentName: "inline",            // Gemini compatibility
  middleware: agentMiddleware(RESEARCH_PROMPT, SEARCH_TOOL_LIMITS),
}).graph;  // ← .graph extracts the compiled StateGraph
```

**What it builds internally:**
```
START → [agent node: LLM decides what to call]
         → if tool call → [tools node: runs the tool]
              → loop back to agent node with tool result
         → if no tool call → END with final message
```

**Key options:**
| Option | What it does | FounderOS usage |
|--------|-------------|-----------------|
| `model` | The model for this agent | Gemini Flash via OpenRouter (same for all) |
| `tools` | Tools this agent can use | `DEPARTMENT_TOOLS["dept"]` from `capabilities.ts` |
| `name` | Agent identifier for supervisor routing | "research", "admin", "engineering", etc. |
| `description` | Used by supervisor to decide when to route here | Deterministic routing hint |
| `middleware` | Pre/post model hooks (trimming, fallback) | `agentMiddleware(prompt, limits)` |
| `includeAgentName` | How agent name appears in messages | `"inline"` (Gemini compat) |

**Why `.graph`?** `createAgent(...)` returns an object with a `.graph` property containing
the compiled `StateGraph`. The supervisor takes compiled graphs as its `agents` array.

---

## The `agentMiddleware` Pattern — Middleware Stack

Every department agent runs through a middleware stack injected at build time:

```typescript
const agentMiddleware = (
  prompt: string | (() => string),
  opts?: Record<string, number> | TrimOptions,
) => [
  ...getModelFallbackMiddleware(),   // 503 retry → free model fallback
  ...createAgentMiddleware(prompt, {
    maxTokens: 4000,                 // sub-agent token budget
    toolCallLimits: opts,            // deterministic tool-call caps
  }),
];
```

### `getModelFallbackMiddleware()` — 503 Retry Chain

```typescript
// src/agents/model.ts
// On 503 (capacity spike): flash-paid → flash-free → deepseek-r1-free → llama-70b-free
// On non-503 errors: re-throw immediately (don't retry logic errors)
```

This is model-agnostic: if OpenRouter returns 503 for `gemini-2.5-flash`, the agent
automatically retries on the next model in the fallback chain. The founder's work continues
with no interruption.

### `createAgentMiddleware()` — Token Trimming + Tool Caps

**Token trimming:** `maxTokens: 4000` (sub-agents), `maxTokens: 6000` (supervisor).
Trimming bounds the message history *suffix* before each LLM call — keeping the
byte-stable system prompt prefix intact for Gemini implicit caching (≤75% cost reduction
on shared prefixes ≥ 1024 tokens).

**Tool call limits:** Deterministic caps prevent infinite loops:
```typescript
const SEARCH_TOOL_LIMITS = { search_web: 2, search_knowledge: 2, search_turicks_brain: 2 };
const ENGINEERING_LIMITS = { claude_code: 1, github_write: 1 };
```
After N calls to a tool this turn, the agent receives a `ToolMessage` that says "limit
reached — stop calling this tool." This is deterministic (counter in middleware), not
a prompt instruction the model might ignore.

---

## `createSupervisor` — The Orchestrator

From `@langchain/langgraph-supervisor`. Takes compiled sub-agent graphs and an LLM — builds
a supervisor that routes to them and collects results.

```typescript
const office = createSupervisor({
  agents: coreAgents,   // ← compiled .graph from each createAgent()
  llm: getModel(),
  prompt: createTrimmedPrompt(buildSupervisorPrompt, { maxTokens: 6000 }),
  outputMode: assertContextIsolation(CONTEXT_ISOLATION_OUTPUT_MODE),  // ← "last_message"
  includeAgentName: "inline",   // ← critical for Gemini (explained below)
}).compile({ checkpointer });
```

**What it builds internally:**
```
START → [supervisor LLM: reads capability manifest, picks which agent to call]
              → handoff to the chosen department graph
              → department's full ReAct loop runs (with its middleware)
              → department returns ONLY its final message (outputMode: "last_message")
        → supervisor sees the department result, decides: done? or route again?
END   → final reply sent to Telegram
```

**`outputMode: "last_message"` — Context Isolation (ADR-021):**
The most important option in the supervisor. Set to `"last_message"`:
- Only the department's final response text crosses back to the supervisor
- The department's internal tool calls (web searches, email drafts, GitHub reads) are hidden
- The supervisor's context window stays clean and bounded
- Gemini implicit caching works because the supervisor's prefix is stable

If set to `"full_history"`, every `ToolMessage` from every department leaks into the
supervisor's `messages[]` — multiplying context window cost and polluting routing decisions.
`assertContextIsolation()` makes switching to `"full_history"` a boot-time crash, not a
silent regression.

**`includeAgentName: "inline"` — Gemini compatibility:**
The supervisor tags each message with the sending agent's name. OpenAI accepts this as a
`name` field. Gemini maps `message.name → author` and throws `"Unknown author: supervisor"`.
Setting `"inline"` embeds the name in the message *content* instead — every provider accepts.

**ADR-028: Supervisor has NO tools.** The `SUPERVISOR_TOOLS` array in `capabilities.ts` is
intentionally empty. The supervisor routes — it doesn't do business work. Business context
and memory operations live in the `admin` department.

---

## `interrupt()` — Native HITL

The built-in way to pause a LangGraph run and wait for a human decision. No database, no manual state management — the checkpointer handles it.

```typescript
// Inside a tool function:
const decision = interrupt({
  kind: "approval",
  title: "📧 Send email to alex@acme.com?",
  preview: emailBody,
}) as string; // returns "approved" or "rejected" on resume

if (decision !== "approved") return "User rejected — email not sent.";
// → now actually send
```

**What happens under the hood:**
1. `interrupt()` throws a special `NodeInterrupt` exception
2. LangGraph catches it, checkpoints current state to Postgres
3. `graph.invoke()` returns (with the graph paused)
4. You call `getPendingApproval()` to check if there's a pending interrupt
5. User taps Approve/Reject in Telegram
6. `graph.invoke(new Command({ resume: "approved" }), config)` resumes on the same node
7. `interrupt()` now **returns** the resume value instead of throwing
8. Code continues from the line after `interrupt()`

**Critical re-execution note:** Everything before `interrupt()` runs twice (once on pause, once on resume). Keep pre-interrupt code pure (no side effects). All real actions — database writes, HTTP calls — go AFTER `interrupt()`.

```typescript
// ✅ Correct
const decision = interrupt({ title: "Send email?" });   // runs twice (pure)
if (decision === "approved") {
  await sendEmail(...);   // runs once, AFTER approval
}

// ❌ Wrong
await logDraftCreated(...);   // would run twice — double log entry
const decision = interrupt({ title: "Send email?" });
```

---

## `Command({ resume })` — Resuming a Paused Graph

```typescript
// Resume with "approved" or "rejected"
await office.invoke(
  new Command({ resume: "approved" }),
  { configurable: { thread_id: "turicks:123456" } }
);
```

The same `thread_id` connects the resume to the paused run. The checkpointer loads the saved state, injects the resume value, and continues from where it left off.

---

## `MemorySaver` vs `PostgresSaver` — Checkpointers

| | `MemorySaver` | `PostgresSaver` |
|--|---------------|-----------------|
| Storage | In-process RAM | Postgres database |
| Survives restart | ❌ No | ✅ Yes |
| Use case | Tests | Production |
| Setup | `new MemorySaver()` | `PostgresSaver.fromConnString(url)` |

In tests we inject `MemorySaver`:
```typescript
const office = buildOffice(new MemorySaver());  // fast, isolated
```

In production `getOffice()` uses the real Postgres saver:
```typescript
const checkpointer = await getCheckpointer();   // connects to DB
_office = buildOffice(checkpointer);
```

---

## Thread IDs — How Memory Works Per-User

Every `invoke()` call needs a `thread_id` in the config. LangGraph uses this to load and save the correct conversation state.

```typescript
const config = {
  configurable: {
    thread_id: "turicks:6775330211"   // format: tenant:chatId
  }
};
```

**FounderOS uses one stable thread per Telegram chat.** This means:
- Every message in the same chat shares conversation history
- The supervisor remembers what it delegated in the previous turn
- A pending approval is tied to the thread — Approve/Reject always goes to the right run

If you want a **fresh conversation** (no memory of past), change the thread_id.

---

## `getState()` — Inspecting a Paused Graph

```typescript
const state = await office.getState(config);

state.values      // current state (messages, etc.)
state.next        // which nodes are waiting to run: ["comms"]
state.tasks       // pending tasks with their interrupts
state.metadata    // checkpoint metadata
```

We use this in `getPendingApproval()` to detect whether the graph is paused for approval:

```typescript
export async function getPendingApproval(office, config) {
  const state = await office.getState(config);
  const interrupts = state.tasks
    .flatMap(t => t.interrupts ?? []);
  return interrupts[0]?.value ?? null;   // the ApprovalRequest payload
}
```

---

## The Full Message Flow

Every node adds messages to the shared `messages[]` array. After a complete run:

```
messages = [
  HumanMessage("Send an email to alex@acme.com about X"),
  AIMessage("Routing to comms department"),         ← supervisor decision
  AIMessage("I'll write and send this email"),      ← comms agent plan
  AIMessage({ tool_calls: [{ name: "send_email", args: {...} }] }),  ← tool call
  ToolMessage("✅ Email sent to alex@acme.com"),     ← tool result
  AIMessage("Done — email sent successfully"),       ← comms final
  AIMessage("Email sent to alex@acme.com"),          ← supervisor summary
]
```

The `finalReply()` function in the gateway scans backwards for the last AI message with text and no pending tool calls — that's what gets sent to Telegram.

---

## Adding a New Department (6 touch-points)

Full wiring map is in `docs/rules/PROGRAMMING-RULES.md`. Quick reference:

1. Write tool in `src/tools/{name}.ts` + test
2. Write agent-tools wrapper in `src/agents/agent-tools/{dept}.ts` (HITL gate)
3. Export from `src/agents/agent-tools.ts` barrel
4. Add to `src/agents/capabilities.ts` → `DEPARTMENT_TOOLS["new-dept"]`
5. Add to `src/agents/office.ts`:

```typescript
const newDept = createAgent({
  model: deptModel,
  tools: DEPARTMENT_TOOLS["new-dept"]!,
  name: "new-dept",
  description: "Use for X, Y, and Z.",    // supervisor reads this for routing
  includeAgentName: "inline",
  middleware: agentMiddleware(NEW_DEPT_PROMPT),
}).graph;

// Add to coreAgents array
const coreAgents = [admin, research, comms, engineering, newDept, ...];
```

6. Add prompt to `src/agents/prompts/new-dept.ts` + export from `system-prompts.ts`

**No manual supervisor prompt updates for routing.** The supervisor's capability manifest
is auto-generated from `capabilities.ts` + the `description` field on each `createAgent`
call — this was the fix for the 2026-06-09 "bot didn't know about browser" bug where
hand-maintained prompt prose drifted from reality.

---

## Nested Supervisors — The Hierarchy Pattern

When a domain grows to 2+ coordinating sub-agents, you can nest a sub-supervisor:

```typescript
// src/agents/revenue-domain.ts
const revenueSupervisor = createSupervisor({
  agents: [marketing, sales],
  llm,
  prompt: REVENUE_SUPERVISOR_PROMPT,
  outputMode: assertContextIsolation(CONTEXT_ISOLATION_OUTPUT_MODE),
  includeAgentName: "inline",
}).compile();  // ← NO checkpointer here (parent's checkpointer handles persistence)

// In office.ts, the parent supervisor treats this as a regular agent:
const coreAgents = [..., revenueSupervisor, ...];
```

**Critical: only one checkpointer.** The nested sub-supervisor is compiled WITHOUT its own
checkpointer. The parent's Postgres checkpointer handles state for the entire graph tree.
If the nested supervisor had its own checkpointer, interrupt/resume state would be split
across two checkpointers → broken resume.

**HITL through 3 levels:** The `interrupt()` exception from `linkedin_post` inside
`marketing` (inside `revenue`) bubbles up through all supervisor boundaries. The parent's
`getState().tasks` captures it. `getPendingApproval()` finds it. Resume with
`Command({ resume: "approved" })` on the parent thread_id → the correct tool gets
"approved" through the full graph chain. **Proven in `tests/integration/nested-hitl.test.ts`.**

---

## Pattern Reference Card

| What you want | LangGraph primitive / FounderOS pattern |
|--------------|---------------------|
| Agent that uses tools | `createAgent({ model, tools, name, description, middleware }).graph` |
| Orchestrate multiple agents | `createSupervisor({ agents, llm, prompt, outputMode: assertContextIsolation(...) })` |
| Pause for human approval | `interrupt(payload)` in a tool (via `hitlGate()`) |
| Resume after approval | `graph.invoke(new Command({ resume: value }), config)` |
| Persist state (production) | `PostgresSaver` via `getCheckpointer()` |
| Persist state (tests) | `new MemorySaver()` via `buildOffice(new MemorySaver())` |
| Inspect paused state | `getPendingApproval(office, config)` → `office.getState(config).tasks` |
| Fresh conversation | New `thread_id` in config |
| Context isolation | `outputMode: assertContextIsolation(CONTEXT_ISOLATION_OUTPUT_MODE)` |
| Token trimming | `createAgentMiddleware(prompt, { maxTokens: 4000 })` |
| 503 fallback | `getModelFallbackMiddleware()` in middleware array |
| Nested supervisors | Nested `createSupervisor` without own checkpointer; proven in `nested-hitl.test.ts` |
| Observe tool calls (eval) | `callbacks: [{ handleToolStart(..., name) { observedTools.push(name) } }]` |
| Typed dept handoffs | `validateSignalPayload(eventType, payload)` before `publish_signal` |
| Anti-hallucination | `detectUnbackedMemoryClaim(messages, toolsUsed)` execution guard |
| Tool failure reporting | `toolFailure("db", message)` → `[[TOOL_FAILURE stage=db]]` marker |

---

*See next: [03-production-hardening.md](./03-production-hardening.md) — the 6-phase hardening
story: context isolation, typed contracts, Claude-as-judge, dept signals, hierarchy proof.*
