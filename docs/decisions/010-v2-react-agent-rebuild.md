# ADR-010: Rebuild as Prebuilt Supervisor + ReAct Sub-Agents (v2)

**Date:** 2026-06-01  
**Status:** Accepted  
**Branch:** `feat/v2-react-agent`

---

## Context

An architectural audit on 2026-06-01 found that FounderOS v1 (10,678 LOC) had a critical defect: for 4 of 5 departments, the finalize node wrote an audit log row and returned — it never called the tool that would execute the approved action. The email tool was fully built and connected to nothing. Every approval since Phase 1 led to a database row, not a real action.

Supporting evidence:
- `src/agents/pods/sales.ts:281` — `finalizeNode` calls `writeAuditEntry` only; `emailTool.execute()` never called
- `src/agents/pods/engineering.ts:154` — `qaTesterNode` returns `passed: true` stub; `githubTool` never called
- `src/core/registry.ts:104-191` — `allowed_tools` arrays reference names that don't exist in `src/tools/index.ts`
- `src/infra/llm.ts:659-764` — hand-rolled two-phase tool executor reimplementing LangGraph's native tool-calling

Additionally, the system was fighting LangGraph's prebuilt patterns with custom equivalents (3-layer pre-router, custom HITL lifecycle, custom department resolver) that were less reliable than the framework primitives they replaced.

---

## Decision

Replace the custom multi-pod orchestration with:

1. **`createSupervisor` from `@langchain/langgraph-supervisor`** — prebuilt LangGraph supervisor that routes to department sub-agents
2. **`createReactAgent` from `@langchain/langgraph/prebuilt`** — one per department (research, comms, engineering)
3. **`interrupt()` native HITL** — tools call `interrupt()` directly; approval gates the same tool call; `Command({ resume })` continues it
4. **Single model** — Gemini 2.5 Flash for all agents; env-swappable via `AGENT_MODEL`

---

## Consequences

### What changes
- `src/agents/office.ts` — new file: entire multi-agent system in ~80 lines
- `src/agents/agent-tools.ts` — new file: LangChain tool() wrappers with interrupt() for write tools
- `src/agents/model.ts` — new file: single model factory with Gemini name-stripping subclass
- `src/agents/system-prompts.ts` — new file: 4 tight prompts replacing 983-line `prompts.ts`
- `src/gateway/telegram.ts` — rewired to drive office, handle approvals via `getPendingApproval()`
- `src/index.ts` — simplified to 60 lines: telemetry → office → health → bot

### What is deleted
- `src/agents/pre-router.ts` (222 LOC) — supervisor's native routing replaces it
- `src/agents/supervisor.ts` (172 LOC) — replaced by `createSupervisor`
- `src/agents/pods/` (5 files, ~1,840 LOC) — replaced by 3 `createReactAgent` calls
- `src/agents/critic.ts` (222 LOC) — no longer needed
- `src/agents/state.ts` (complex) — `createSupervisor` manages its own state
- `src/agents/graph.ts` — replaced by `office.ts`
- `src/infra/llm.ts` (826 LOC) — replaced by `model.ts` (50 LOC)
- `src/core/prompts.ts` (983 LOC) — replaced by `system-prompts.ts` (100 LOC)
- `src/core/registry.ts` — replaced by agent `name` + description in `createReactAgent`
- `src/gateway/hitl.ts` (236 LOC) — replaced by native `interrupt()`
- `src/infra/token-optimizer.ts`, `log-observer.ts` — removed (premature optimization)

### What is preserved
- All 4 real tools (`email.ts`, `github.ts`, `web-search.ts`, `linkedin.ts`)
- `src/infra/checkpointer.ts` — Postgres saver
- `src/db/` — schema + queries (audit_log, do_not_contact)
- `src/infra/health.ts`, `telemetry.ts`, `logger.ts`

### Test impact
- Old unit tests for pods/supervisor remain but test now-unused code
- New integration test `tests/integration/office-hitl.test.ts` proves:
  - approve → email sent exactly once
  - reject → email not sent
  - research → no interrupt
- All 210 tests continue to pass

---

## Alternatives Considered

**Option A: Fix finalize nodes in-place**
Wire `emailTool.execute()` into the existing finalize nodes. Faster, but keeps 6,000+ LOC of cascade/circuit-breakers/critic plumbing around a still-fragile routing system. Weak portfolio piece. Rejected.

**Option B: Single `createReactAgent` (no supervisor)**
One agent, all tools, one prompt. Simpler, but doesn't demonstrate multi-agent orchestration — an explicit Turicks portfolio goal. Adding departments later would mean stuffing more tools into one agent rather than adding clean sub-agents. Rejected.

**Option C: Full LangGraph v1.x upgrade + prebuilt supervisor**
`@langchain/langgraph-supervisor@1.x` requires core 1.x and langgraph 1.x — a coordinated major version upgrade of 6 packages. Risk too high for a one-day build. `0.0.20` supports langgraph 0.2.72+ (we have 0.2.74), same prebuilt API, no upgrade needed. Rejected.

---

## Discovered Issues and Fixes During Implementation

1. **`Unknown author: supervisor`** — Google GenAI adapter maps `message.name` to a Gemini author role; "supervisor" isn't a valid role. Fixed by: (a) `includeAgentName: "inline"` to embed names in content, (b) subclassing `ChatGoogleGenerativeAI` to strip the `name` attribute in `_generate` and `_streamResponseChunks` before sending to Gemini. See `src/agents/model.ts`.

2. **`@composio-core/js` doesn't exist** — tools imported a package that was never published. The correct package is `composio-core@0.5.39` which exports `OpenAIToolSet`. Fixed by installing and updating all imports.

3. **Interrupts surface via `getState().tasks`, not `invoke()` return** — in langgraph 0.2.x, `invoke()` returns without `__interrupt__` when a sub-agent interrupts. Interrupts are in `state.tasks[].interrupts[]`. Fixed in `getPendingApproval()`.

4. **Re-execution before `interrupt()`** — when an interrupt fires, the tool runs twice: once on pause (interrupt throws), once on resume (interrupt returns). Any side effects before `interrupt()` happen twice. Solution: keep everything before `interrupt()` pure; all real actions go after.
