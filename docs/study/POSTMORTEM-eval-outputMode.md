# Post-Mortem: Agent Eval Tool-Select 0/7 → 7/7

> Date: 2026-06-03 · Severity: High (eval harness gave completely wrong signal) · Resolved: same day

---

## Summary

After shipping the eval harness (`pnpm eval`), tool-selection accuracy reported **0/7** on every run — even though the agents were *actually* calling the right tools in production. The eval harness was lying. Root cause: a LangGraph supervisor configuration that hides sub-agent tool calls from the top-level message trail.

---

## Timeline

- **16:00** — `pnpm eval` first run post-merge. Routing: 10/10 ✅. Tool-select: 0/7 ❌. HITL: 9/9 ✅.
- **16:05** — First hypothesis: tool schemas wrong / tools not registered. Checked agent definitions — tools were correct.
- **16:20** — Second hypothesis: tool names mismatched in golden-task assertions. Confirmed names were exact strings. Still 0/7.
- **16:45** — Added debug trace: printed all messages from `office.invoke()` return value. **No ToolMessage objects visible** — only AI messages.
- **17:00** — Root cause identified: `createSupervisor`'s `outputMode: "last_message"` strips sub-agent internal messages (including ToolMessages) from the top-level result. The invoke return only contains the supervisor's final AI response.
- **17:20** — Fix designed and implemented.
- **17:40** — Tool-select: 7/7. Full eval: 10/10.

---

## Root cause

LangGraph's `createSupervisor` with `outputMode: "last_message"` (the default) returns only the final message from the top-level graph — which is the supervisor's AI response text. Sub-agent tool calls are internal to the sub-graph and never surface in the parent graph's message list.

```typescript
// What we tried (BROKEN):
function collectDeptTools(messages: BaseMessage[]): string[] {
  return messages
    .filter((m) => m._getType() === "tool")   // <-- never any ToolMessages here
    .map((m) => (m as ToolMessage).name ?? "");
}
```

The tool calls existed — LangSmith confirmed them — but they were invisible to the top-level `invoke()` return.

---

## Fix

Observe tool calls via a **callback handler** on the individual tool objects, rather than reading the post-invoke message trail:

```typescript
// src/eval/runner.ts — the fix

const observedTools: string[] = [];

const toolObserver: CallbackHandlerMethods = {
  handleToolStart(_tool, _input, _runId, _parentRunId, _tags, _metadata, name) {
    if (name) observedTools.push(name);
  },
};

await office.invoke(
  { messages: [new HumanMessage(task.input)] },
  {
    configurable: { thread_id: threadId },
    callbacks: [toolObserver],  // <-- fires on every tool call in every sub-agent
  }
);
```

**Why this works:** `handleToolStart` fires before the tool executes, regardless of where in the graph hierarchy the tool is called. It sees through the `outputMode` abstraction to the actual tool invocations.

**Routing** still reads from messages — `transfer_to_*` messages *do* surface at the top level (supervisor-to-subagent handoffs are graph transitions, not tool calls). Only tool call results are hidden.

---

## Lessons

1. **LangGraph's `outputMode: "last_message"` is correct behavior, not a bug.** It's designed to return a clean response to the caller. The eval harness was wrong to expect ToolMessages in the result.

2. **"The agent called the right tool" and "the result shows a ToolMessage" are different facts.** In a supervisor graph, only the former is guaranteed. If you need tool-call evidence, use the callback interface.

3. **An eval harness that silently reports 0/7 is worse than no eval at all.** It gives false confidence in the opposite direction. The harness itself needs validation — we ran a manual spot-check against LangSmith traces to confirm the fix was measuring the right thing.

4. **LangSmith is the source of truth.** When the code disagrees with LangSmith, LangSmith is right. Use it for debugging before debugging the code.

---

## Outcome

- Tool-select accuracy: 0/7 → **7/7** ✅
- Eval overall: **13/13, 100%** on all three dimensions
- Added `handleToolStart` observation pattern as the canonical way to assert tool usage in a supervisor graph
- `pnpm eval` now produces a fully trustworthy `EVAL.md` report

---

*This post-mortem is part of the FounderOS build-in-public series. See [`EVAL.md`](../../EVAL.md) for current eval results.*
