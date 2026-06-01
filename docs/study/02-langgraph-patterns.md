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

## `createReactAgent` — The Specialist Agent

This is LangGraph's prebuilt ReAct loop. Give it a model, tools, and a prompt — it builds the full think/act/observe graph automatically.

```typescript
const research = createReactAgent({
  llm: getModel(),
  tools: [searchWeb],
  name: "research",
  prompt: "You are the research department. Use search_web to find information...",
});
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
| `llm` | The model for this agent | Gemini Flash (same for all — shared cost) |
| `tools` | Tools this agent can use | Scoped per department |
| `name` | Agent identifier for supervisor | "research", "comms", "engineering" |
| `prompt` | System prompt (string or `SystemMessage`) | `RESEARCH_PROMPT` etc from `system-prompts.ts` |
| `checkpointer` | State persistence (optional) | Set at supervisor level, not per agent |

---

## `createSupervisor` — The Orchestrator

From `@langchain/langgraph-supervisor`. Takes compiled sub-agents and an LLM — builds a supervisor that delegates to them.

```typescript
const office = createSupervisor({
  agents: [research, comms, engineering],
  llm: getModel(),
  prompt: SUPERVISOR_PROMPT,
  includeAgentName: "inline",   // ← critical for Gemini (explained below)
}).compile({ checkpointer });
```

**What it builds internally:**
```
START → [supervisor LLM: picks which agent to call]
              → handoff to research / comms / engineering
              → agent runs its full ReAct loop
              → returns to supervisor
        → supervisor decides: done? or route to another agent?
END   → final reply
```

**The `includeAgentName: "inline"` trick:**  
The supervisor tags each message with the sending agent's name. OpenAI accepts this as a `name` field on the message. Gemini doesn't — it throws `Unknown author: supervisor`. Setting `"inline"` embeds the name inside the message content instead, which every provider accepts.  
See: `src/agents/model.ts` — we also subclass the model to strip the `name` attribute before it reaches Gemini.

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

## Adding a New Department (10 lines)

1. Write tools in `src/agents/agent-tools.ts` (or a new file)
2. Write a prompt in `src/agents/system-prompts.ts`
3. Add the agent in `src/agents/office.ts`:

```typescript
// In buildOffice():
const sales = createReactAgent({
  llm,
  tools: [searchWeb, sendEmail],     // tools this department has
  name: "sales",
  prompt: SALES_PROMPT,
});

// Add to createSupervisor:
createSupervisor({
  agents: [research, comms, engineering, sales],  // ← add here
  ...
})
```

4. Update `SUPERVISOR_PROMPT` to mention the new department so the supervisor knows to route to it.

That's it. No new graph nodes, no new routing edges, no new state types.

---

## Pattern Reference Card

| What you want | LangGraph primitive |
|--------------|---------------------|
| Agent that uses tools | `createReactAgent({ llm, tools, name, prompt })` |
| Orchestrate multiple agents | `createSupervisor({ agents, llm, prompt })` |
| Pause for human approval | `interrupt(payload)` in a tool |
| Resume after approval | `graph.invoke(new Command({ resume: value }), config)` |
| Persist state (production) | `PostgresSaver.fromConnString(url)` |
| Persist state (tests) | `new MemorySaver()` |
| Inspect paused state | `graph.getState(config)` |
| Fresh conversation | New `thread_id` in config |

---

*See next: [03-v1-to-v2-migration.md](./03-v1-to-v2-migration.md) — the full story of why FounderOS v1 was rebuilt.*
