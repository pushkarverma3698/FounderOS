# Why We Rebuilt FounderOS: v1 → v2

*The full honest story — what we built, why it didn't work, what we learned, and what we built instead.*

---

## The Headline

**v1 was 10,678 lines of code that could not send a single email.**

Not because it was unfinished. Because its core loop — for 4 of 5 departments — ended at `writeAuditEntry()` instead of calling the tool that would actually do the thing. The tools (email, GitHub, web search) were fully built, fully tested, and wired to nothing.

The approval button existed. The approval was recorded. The action never happened.

---

## What v1 Looked Like

### The Architecture

```
Telegram message
   → Pre-router (Layer 0: regex, Layer 1: nano LLM, Layer 2: CEO LLM)
   → CEO Supervisor (Sonnet/Gemini Pro, returns JSON with agent name)
   → Department Resolver (keyword heuristics: "bdr" → sales, "linkedin" → social)
   → Pod Subgraph (sales | engineering | marketing | social | prospecting)
       → Engineer agent (plans the task in JSON)
       → Executor agent (drafts the output)
       → QA agent (stub: always returned `passed: true`)
       → Critic agent (different model family for anti-sycophancy)
       → HITL node (wrote to `hitl_approvals` table, called `interrupt()`)
       → Finalize node
           → writeAuditEntry()   ← HERE. This was the last line. Nothing after.
```

### The Numbers
| Metric | v1 |
|--------|-----|
| Source files | 36 |
| Lines of code | 10,678 |
| Model cascade tiers | 8 (CEO, deep_research, MD, code, nano, local, video, critic) |
| LLM providers per tier | 3 each = 24 potential providers |
| DB tables | 8 |
| Routing layers before any work | 3 |
| LLM calls just for routing/planning | 2–3 per request |
| Departments that actually executed a real tool | **1 of 5** |
| That one working department | Social — but only the LinkedIn post API, which fell back to a `dry-run-${Date.now()}` fake post ID |

---

## The Five Root Causes

### 1. Approve → Audit Log → Nothing
The finalize node in every pod had the same structure:
```typescript
async function finalizeNode(state) {
  await writeAuditEntry({ action: "email_draft_ready", ... });
  return { final: { plan: ..., code_draft: ..., hitl_status: ... } };
  // emailTool.execute() was NEVER called here
}
```

The email tool was fully built in `src/tools/email.ts`. It had real Composio integration, idempotency, suppression checks. It was imported in `src/tools/index.ts`. It was referenced in the registry's `allowed_tools` arrays. But **nothing in the finalize path called it.** The approval led to a database row, not a sent email.

### 2. The `allowed_tools` Fiction
Every agent in the registry had an `allowed_tools` array:
```typescript
{
  id: "bdr",
  allowed_tools: ["firecrawl", "write_file", "chromadb_write", "send_email", "pipeline_add_lead"]
}
```
None of these names matched the actual tools (`search_web`, not `firecrawl`). And nothing in the codebase ever read `allowed_tools` to bind tools to an agent. It was decorative config that looked functional in a code review.

### 3. Fighting LangGraph Instead of Using It
LangGraph JS ships `createReactAgent` — a prebuilt agent that picks which tool to call using native tool-calling. Our v1 instead:
- Built a custom pre-router with regex + nano LLM + CEO escalation
- Built a custom keyword department resolver
- Built custom pod subgraphs for each department
- Built a custom HITL lifecycle with a database table mirroring LangGraph's own checkpointer

This is 4,000+ lines reimplementing things LangGraph already handles, but worse. The CEO LLM classified the task AND we ran keyword heuristics on the output AND the model sometimes returned empty JSON — each layer added failure surface.

### 4. The 8-Tier Cascade (Cost Without Benefit)
```typescript
CASCADE = {
  ceo: [claude-sonnet, gemini-2.5-pro, llama-70b],
  deep_research: [gemini-2.5-pro, gemini-flash, deepseek-r1],
  md: [gemini-flash, claude-haiku, llama-70b],
  code: [lmstudio/qwen, openrouter/qwen3-coder, gemini-flash],
  nano: [gemini-flash-lite, claude-haiku],
  local: [lmstudio, gemini-flash-lite],
  video: [veo-2.0],
  critic: [claude-haiku, llama-70b, gemini-flash],
}
```
8 tiers × 3 providers × rate limiters × circuit breakers × cost tracking = 826 lines in `llm.ts`. For a one-person tool. The same result (a text response) needed 8 different routing decisions. The local model tier (`lmstudio/qwen`) was producing 3-line stub responses and silently passing.

### 5. Planner Planning for the Planner
Each pod had an "engineer" agent whose job was to write a JSON plan for the "executor" agent. So a request to send a cold email would:
1. Pre-router classifies it (nano LLM)
2. CEO supervisor classifies it (Sonnet/Gemini Pro)
3. sales_engineer plans the approach (MD tier LLM)
4. BDR agent drafts the email (MD tier LLM)
5. Critic reviews it (critic tier LLM)
6. HITL node — but didn't actually send

That's 4–5 LLM calls before anything happened. For one person's email.

---

## The Moment of Clarity

The audit was run on 2026-06-01. The question: "Why does the bot feel dumb?" The finding:

> **`src/agents/pods/sales.ts:281` — `finalizeNode` calls `writeAuditEntry` but never calls `emailTool`. The email tool is wired to nothing. Confirmed: `emailTool` is referenced nowhere outside `src/tools/`.**

The system wasn't dumb. It was building the right answers and then discarding them. The architecture had optimised for *the appearance of doing things* — draft, critique, approve, log — rather than *actually doing things*.

---

## What v2 Changed

### The Architecture

```
Telegram message
   → Supervisor (Chief of Staff — picks which department)
       → research agent    [search_web]                  — read-only, instant
       → comms agent       [send_email*, linkedin_post*] — HITL-gated
       → engineering agent [github_read, github_write*]  — HITL-gated
   → reply to Telegram
   (* = calls interrupt() — graph pauses, you approve, SAME tool runs the real action)
```

### The Numbers
| Metric | v2 |
|--------|----|
| Source files (new) | 6 new files |
| Lines of code (new) | ~500 |
| Model tiers | 1 (Gemini Flash + 1 fallback) |
| Routing layers | 1 (supervisor native tool-calling) |
| Departments that execute real tools | **3 of 3** |
| LLM calls for routing | 1 (supervisor decides) |

### The Key Design Decisions

**1. Tools ARE the actions (not nodes in a graph)**  
In v2, `send_email` is a LangChain tool that calls `interrupt()` inside it. When the agent picks the tool, runs it, and gets the resume value — all in the same tool call — the email sends. There's no separate finalize node. There's no audit-then-nothing path.

**2. Native HITL instead of custom HITL**  
LangGraph's `interrupt()` + `Command({ resume })` is exactly the pattern we hand-built in v1's `hitl.ts` (236 lines) + `hitlApprovals` table. The native version is more robust, uses the checkpointer you're already running, and needs 0 extra code.

**3. One model, not eight tiers**  
Gemini Flash handles all tasks. It's fast, cheap ($0.075/1M tokens), has 1M context, and has strong tool-calling. The cascade logic assumed you'd need different models for different task types — in practice, one good model outperforms eight mediocre ones with routing overhead.

**4. The supervisor picks tools, not departments**  
In v1 we wrote a 3-layer classifier to route to a department, and then the department had its own classifier inside. In v2 the Gemini Flash supervisor simply sees three agent names and three descriptions — it uses its native understanding to pick the right one, the same way it picks a tool. One LLM call, no intermediate routing.

---

## What We Kept from v1

The tools were the right investment. They're all in v2:
- `src/tools/email.ts` — Composio Gmail, idempotency, suppression
- `src/tools/github.ts` — Octokit, full CRUD on repos/issues/READMEs
- `src/tools/web-search.ts` — Firecrawl search API
- `src/tools/linkedin.ts` — Composio LinkedIn post

The Postgres checkpointer: `src/infra/checkpointer.ts` — unchanged.
The logger, telemetry, DB schema: all kept.

---

## What We Deleted (and Why it Was Safe)

| Deleted | Why it was safe |
|---------|----------------|
| `src/agents/pre-router.ts` (222 LOC) | Supervisor's native tool-calling replaces 3-layer classification |
| `src/agents/supervisor.ts` (old, 172 LOC) | `createSupervisor` does this better |
| `src/agents/pods/` (5 files, ~1,840 LOC) | Pod graphs generated drafts that never sent; no working behavior to break |
| `src/agents/critic.ts` (222 LOC) | Anti-sycophancy via separate model was never used end-to-end |
| `src/agents/state.ts` (complex annotations) | `createSupervisor` manages its own state |
| `src/agents/graph.ts` (old) | Replaced by `office.ts` |
| `src/infra/llm.ts` cascade + circuit breakers (826 LOC) | Single model, simple `getModel()` |
| `src/core/registry.ts` (agent registry) | `createReactAgent` names + prompts replace it |
| `src/core/prompts.ts` (983 LOC) | 4 tight prompts in `system-prompts.ts` replace 25+ prompts |
| `src/gateway/hitl.ts` (236 LOC) | Native `interrupt()` replaces it |
| `src/infra/token-optimizer.ts` (296 LOC) | Premature; one model doesn't need token routing |
| `src/infra/log-observer.ts` (333 LOC) | LangSmith covers observability |

Total deleted: ~6,000+ LOC of non-functional plumbing.

---

## Lessons

1. **Build the tool first, then the orchestration around it.** We built extensive orchestration for tools that couldn't fire. Should have been: make `send_email` actually send, then add the approval gate, then add routing. Bottom-up, not top-down.

2. **Use the framework's prebuilt patterns.** LangGraph ships `createReactAgent`, `createSupervisor`, and `interrupt()` for exactly our use case. Building custom versions of these isn't engineering — it's yak shaving.

3. **Test the real outcome, not the intermediate.** We had 186 unit tests. None of them asserted that an approval led to a sent email. The right test: `approve → email.execute() called once`. Had that test existed, the bug would have been caught on day 1.

4. **"Production-grade" is earned by working, not by complexity.** Circuit breakers, 8-tier cascades, and anti-sycophancy critics look impressive in a README. An agent that actually sends emails is production-grade. The other stuff is theatre.

---

*See next: [04-how-founderos-works.md](./04-how-founderos-works.md) — a walkthrough of the v2 codebase you can use while reading the source.*
