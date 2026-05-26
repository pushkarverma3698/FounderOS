# LangGraph Patterns — Deep Dive

> Study guide for the LangGraph-specific patterns in FounderOS. Covers StateGraph, Annotation, interrupt(), Command, checkpointing.

---

## What LangGraph Is

LangGraph is a framework for building stateful, multi-step agent workflows as directed graphs. Key properties:
- **Nodes** are functions (async or sync) that receive state and return partial state updates
- **Edges** are routing decisions — either static (always go to node X) or conditional (decide at runtime)
- **State** is a typed object that flows through the graph; nodes merge their return values into it
- **Checkpointer** persists state to a backend (PostgreSQL, Redis, memory) after every node

Think of it as: Redux (for state management) + Express routing (for flow control) + a database (for persistence).

---

## StateGraph vs MessageGraph

| | StateGraph | MessageGraph |
|---|---|---|
| State shape | You define it with Annotation.Root() | Always `{ messages: BaseMessage[] }` |
| Use when | Complex multi-field state (FounderOS) | Simple chat / conversational agent |
| FounderOS uses | ✅ StateGraph | — |

For FounderOS, we need `lead`, `email_draft`, `critiques`, `hitl`, `revision_count` etc. — a rich custom state. MessageGraph's fixed messages-only state doesn't fit.

---

## Annotation.Root() — Defining State

Every field in LangGraph state must be declared with `Annotation`:

```typescript
import { Annotation, messagesStateReducer } from "@langchain/langgraph";

export const SalesState = Annotation.Root({
  // Simple value — last write wins
  task: Annotation<string>({ default: () => "" }),

  // Nullable complex object — last write wins
  lead: Annotation<LeadProfile | null>({ default: () => null }),

  // APPEND-ONLY ARRAY — important!
  critiques: Annotation<CritiqueRecord[]>({
    reducer: (existing, incoming) => [...existing, ...incoming],
    default: () => [],
  }),

  // Counter — simple increment pattern
  revision_count: Annotation<number>({ default: () => 0 }),

  // Messages — use the built-in deduplicating reducer
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});
```

**Why the append reducer matters:** When the critic loops back to the generator, we need the *entire* critique history, not just the latest. With append-only, `state.critiques` grows: `[critique1, critique2]`. You can always get the latest with `.at(-1)`.

**The `default` factory:** Always use `() => value` (factory function), not `value` directly. If you use `default: []`, all instances share the same array reference — classic JS mutation bug.

---

## Nodes

A node is an async function: `(state) => Partial<state>`. It receives the full state and returns only the fields it wants to update.

```typescript
// Node that updates a single field
async function bdrNode(state: typeof SalesState.State): Promise<Partial<typeof SalesState.State>> {
  const draft = await callCascade("md", [...], { system: getSystem("OUTREACH_AGENT") });
  return {
    email_draft: { subject: draft.subject, body: draft.body },
    revision_count: state.revision_count + 1,
  };
}
```

**Critical rules:**
- Return only the fields you changed — LangGraph merges your return value into state
- For array fields with reducers, return a new array with ONLY the new elements — the reducer appends them
- Never mutate state directly — always return a new object

```typescript
// ❌ WRONG — mutates state
state.critiques.push(newCritique);
return state;

// ✅ CORRECT — returns new elements; reducer appends
return { critiques: [newCritique] };  // reducer: (existing, [newCritique]) => [...existing, newCritique]
```

---

## Conditional Edges — Pure Routing Functions

After a node completes, a conditional edge decides where to go next:

```typescript
// Add a conditional edge after "critic" node
graph.addConditionalEdges("critic", afterCriticEdge, {
  generator: "bdr",   // maps return value "generator" to node name "bdr"
  hitl: "hitl_node",
});

// The function itself — MUST BE PURE
function afterCriticEdge(state: typeof SalesState.State): "generator" | "hitl" {
  const latest = state.critiques.at(-1);
  if (!latest || latest.result === "APPROVED") return "hitl";
  if (state.revision_count >= state.max_revisions) return "hitl"; // escalate
  return "generator";
}
```

**Rule: conditional edges must be pure functions.** No async, no side effects, no LLM calls. If you need to call an LLM to make a routing decision, add a node before the edge.

---

## Command — Supervisor Routing

`Command` is how the supervisor node routes to department subgraphs:

```typescript
import { Command } from "@langchain/langgraph";

async function supervisorNode(state: typeof FounderState.State) {
  // LLM classifies the task
  const dept = await classifyTask(state.task); // "sales" | "engineering" | "marketing"

  return new Command({
    goto: dept,           // go to the subgraph named "sales"/"engineering"/"marketing"
    update: {             // also update the parent graph state
      department: dept,
    },
  });
}
```

`Command` differs from a conditional edge because it can update state AND route — a conditional edge only routes.

---

## interrupt() — Durable HITL

`interrupt()` pauses graph execution and waits for human input:

```typescript
import { interrupt } from "@langchain/langgraph";

async function hitlNode(state: typeof SalesState.State) {
  // interrupt() pauses here — checkpointed to PostgreSQL
  // The value passed to interrupt() is available to the human reviewer
  const decision = interrupt({
    type: "approval",
    content: state.email_draft,
    interrupt_id: state.hitl?.interrupt_id,
  });

  // This line only runs AFTER the human responds
  // decision = whatever was passed to graph.invoke() when resuming
  return {
    hitl: { ...state.hitl, status: decision.action, resolved_at: new Date().toISOString() }
  };
}
```

**How resumption works:**

```typescript
// Initial invocation — graph pauses at interrupt()
await graph.invoke(
  { task: "draft email to Acme" },
  { configurable: { thread_id: "turicks:telegram:123:run-xyz" } }
);

// Later — human taps Approve in Telegram
// The callback handler calls this:
await graph.invoke(
  new Command({ resume: { action: "approved" } }), // resume value
  { configurable: { thread_id: "turicks:telegram:123:run-xyz" } } // same thread_id
);
// Graph resumes from the interrupt() — `decision` gets { action: "approved" }
```

**The thread_id is everything.** It maps to the checkpointed state. Same thread_id = same run. Without it, LangGraph creates a new run.

---

## PostgresSaver — Checkpointing

```typescript
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

// Create a pg.Pool (LangGraph needs pg specifically — not postgres.js)
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, min: 5, max: 20 });

// PostgresSaver wraps the pool
const checkpointer = new PostgresSaver(pool);

// MUST call setup() — creates the checkpoint tables
// (langgraph_checkpoints, langgraph_checkpoint_blobs, etc.)
await checkpointer.setup();

// Compile graph with checkpointer
const graph = workflow.compile({ checkpointer });
```

**What gets saved:** After every node completes, LangGraph serializes the full state to the checkpoint tables. The `thread_id` + `checkpoint_id` pair uniquely identifies each snapshot.

**What `inspect-thread.ts` does:**
```typescript
// List all checkpoints for a thread
for await (const checkpoint of checkpointer.list(config)) {
  console.log(checkpoint.checkpoint_id, checkpoint.metadata?.step);
}
```

---

## Subgraph Pattern

Department pods are compiled subgraphs added to the main graph:

```typescript
// In pods/sales.ts
export const salesSubgraph = salesGraph.compile();

// In graph.ts
mainGraph.addNode("sales", salesSubgraph); // subgraph IS a node
mainGraph.addNode("engineering", engineeringSubgraph);
mainGraph.addNode("marketing", marketingSubgraph);
```

When the supervisor routes `Command({ goto: "sales" })`, LangGraph runs the entire salesSubgraph as if it were a single node. The subgraph has its own `SalesState` — it doesn't pollute the parent `FounderState`.

---

## Common Pitfalls

**1. Compiling per-request**
```typescript
// ❌ VERY SLOW — compile is expensive (100ms+)
app.post("/task", async (req, res) => {
  const graph = workflow.compile({ checkpointer }); // ← compiling on every request
});

// ✅ Compile once at startup
const graph = await getGraph(); // singleton
app.post("/task", async (req, res) => {
  await graph.invoke(req.body, config);
});
```

**2. Forgetting `.js` extensions in imports**
```typescript
// ❌ Fails at runtime with NodeNext module resolution
import { SalesState } from "./state";

// ✅ Required for NodeNext ESM
import { SalesState } from "./state.js";
```

**3. Mutating state in a node**
```typescript
// ❌ Mutations don't get checkpointed
async function node(state) {
  state.revision_count++;  // mutating — LangGraph can't track this
  return {};
}

// ✅ Return new value
async function node(state) {
  return { revision_count: state.revision_count + 1 };
}
```

**4. Async in conditional edges**
```typescript
// ❌ Async conditional edge — LangGraph may not handle correctly
graph.addConditionalEdges("critic", async (state) => {
  const result = await db.query(...); // ← async in edge
  return result ? "approved" : "rejected";
});

// ✅ Put the async work in a node, edge reads state
// criticNode writes to state.critiques, then edge reads it
graph.addConditionalEdges("critic", (state) => {
  return state.critiques.at(-1)?.result === "APPROVED" ? "hitl" : "generator";
});
```
