# ADR-001: Why LangGraph Instead of a Custom State Machine

**Date:** 2025-05  
**Status:** Accepted  
**Context:** FounderOS needs a framework to orchestrate multi-step agent workflows with persistence, human-in-the-loop (HITL) approvals, and recovery from crashes.

---

## The Problem

FounderOS workflows look simple on paper:

```
lead_intel → bdr → critic → HITL → finalize
```

But in production, they have painful edge cases:

1. **Mid-execution crash** — What if the process restarts between `bdr` and `critic`? The email draft is lost.
2. **HITL latency** — The founder might approve 6 hours later (or never). The process can't block a thread waiting.
3. **Revision loops** — Critic might send work back to the generator 1–2 times before approving. Need loop logic.
4. **Observability** — Which node is currently running? What did each node receive as input?

A custom state machine can handle all of this — but it's 500–1000 lines of infrastructure code before writing a single line of business logic.

---

## Options Considered

### Option A: Custom TypeScript State Machine
Write a `WorkflowEngine` class with a step-runner, database checkpointing, and a resume API.

**Pros:** Full control, no external dependency.  
**Cons:** 6–8 weeks of infrastructure work. Bugs are on us. No observability out of the box.

### Option B: LangGraph JS (`@langchain/langgraph`)
Use the JavaScript port of LangGraph — a framework specifically built for stateful, multi-actor agent workflows.

**Pros:**
- Built-in PostgreSQL checkpointing via `@langchain/langgraph-checkpoint-postgres`
- `interrupt()` primitive for durable HITL — pause execution, survive restarts, resume when human responds
- `Command({ goto })` for clean supervisor routing
- Native LangSmith integration — every node call, input/output, and latency is traced automatically
- `StateGraph` + `Annotation.Root()` make state transitions explicit and type-safe
- Battle-tested by major AI companies; open source with active development

**Cons:**
- External dependency; API changes between minor versions
- More complex than a simple function chain when you first encounter it

### Option C: Temporal / Inngest
Workflow-as-code platforms with durable execution.

**Pros:** Production-proven at scale. Great for long-running workflows.  
**Cons:** Temporal requires a separate server (operational overhead). Inngest adds cost. Neither is purpose-built for AI agents (no concept of `interrupt()` for HITL, no LangSmith integration, no built-in LLM tooling).

---

## Decision: LangGraph JS

LangGraph was built precisely for our use case. The key capabilities that made this a clear choice:

### 1. Durable HITL via `interrupt()`

```typescript
// In hitl_node:
const decision = interrupt({ type: "approval", content: emailDraft });
// ↑ Execution pauses here. Process can restart. Thread resumes when
//   the graph is invoked again with the human's response.
```

This is not "fire and forget with a callback" — the graph literally pauses at the `interrupt()` call and resumes from the exact same line when the human responds. This is impossible to do correctly with a custom state machine without significant infra work.

### 2. PostgreSQL Checkpointing

Every node transition is automatically checkpointed:

```typescript
const checkpointer = await PostgresSaver.fromConnString(env.DATABASE_URL);
await checkpointer.setup(); // creates LangGraph tables
const graph = workflow.compile({ checkpointer });
```

If the process crashes after `lead_intel` completes but before `bdr` starts, the next invocation resumes from `bdr` — `lead_intel` is not re-run.

### 3. Natural Expression of Our Patterns

The supervisor + department pod pattern maps directly to LangGraph primitives:

```typescript
// Supervisor uses Command() to route — clean and explicit
function supervisorNode(state) {
  const dept = classifyTask(state.task);
  return new Command({ goto: dept, update: { department: dept } });
}

// Conditional edges are pure functions — easy to test
function afterCriticEdge(state) {
  if (state.critiques.at(-1)?.result === "APPROVED") return "hitl";
  if (state.revision_count >= state.max_revisions) return "hitl"; // escalate
  return "generator"; // loop back
}
```

### 4. Free Observability

With `LANGCHAIN_TRACING_V2=true`, every run is visible in LangSmith: which node ran, what it received, what it returned, how many tokens it used, what the latency was. This would take weeks to build from scratch.

---

## Consequences

- **Compile once at startup:** The graph must be compiled once (`getGraph()` singleton in `graph.ts`) — never per request. Compiling is expensive.
- **Annotation schema for state:** All state fields must be declared with `Annotation.Root()`. This is more verbose than a plain object but enforces reducers (e.g. append-only `critiques` history).
- **`.js` extension imports:** LangGraph uses ES modules. TypeScript with `"moduleResolution": "NodeNext"` requires `.js` extensions in all imports. This is a TypeScript config constraint, not a LangGraph one.
- **Version pinning:** LangGraph JS is evolving. Pin `@langchain/langgraph@^0.2` and test before upgrading.
