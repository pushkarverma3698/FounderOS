# FounderOS — Architecture

> **One line:** A Telegram bot where you type a task and the right department
> executes it — with your approval before anything is sent or changed.

*v2 production state as of 2026-06-14. 8 departments, Phases 1–6 hardening complete,
1008+ tests green, 90% routing eval.*

---

## How it works (plain English)

1. You send a message to Telegram
2. A **supervisor** reads it and decides which of 8 departments handles it
3. The department executes — using its tools (web search, GitHub, Gmail, etc.)
4. If the action is a write/send (email, calendar event, GitHub PR, shell command), it
   **pauses and shows an approval card** — you tap Approve or Reject
5. After approval, the action runs. After rejection, nothing happens.
6. The reply appears in Telegram

That's it. No hidden state. No automatic sends. Every external action requires you.

---

## System Diagram

```
You (Telegram)
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  Gateway (src/gateway/telegram.ts)                      │
│  - Receives messages, handles /commands                 │
│  - Renders Approve/Reject cards for HITL                │
│  - Formats replies as Telegram HTML                     │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│  Supervisor (LangGraph createSupervisor)                │
│  Model: Gemini Flash via OpenRouter, temperature=0      │
│  Tools: NONE (ADR-028: supervisor routes only)          │
│  outputMode: "last_message" (context isolation, ADR-021)│
│                                                         │
│  Routes to one of 8 departments:                        │
│  admin · research · comms · engineering · marketing     │
│  sales · personal · jobhunt                             │
└──────────┬──────────────────────────────────────────────┘
           │  routes to exactly one dept
           ▼
┌──────────────────────────────────────────────────────────┐
│  Department (LangGraph createReactAgent)                 │
│  Same model as supervisor. Calls tools in a loop.       │
│  Returns answer or pauses for HITL.                     │
└──────────────────────────────────────────────────────────┘
           │
           ▼ (if write/send tool called)
┌──────────────────────────────────────────────────────────┐
│  HITL Gate (LangGraph interrupt())                       │
│  - Graph pauses, state saved to Postgres                │
│  - Telegram shows Approve/Reject card                   │
│  - On Approve: action executes, reply sent              │
│  - On Reject: nothing happens, reply sent               │
└──────────────────────────────────────────────────────────┘
```

---

## The 8 Departments

Each department has a clear scope. No write tool belongs to two departments (reads like
`search_web` and `search_knowledge` are shared — stateless, collision-free).
Source of truth: `src/agents/capabilities.ts`.

| Department | What it does | Tools | HITL? |
|-----------|-------------|-------|-------|
| **admin** | Business context, episodic memory, pending cross-dept signals | read_context, update_context, search_memory, record_event, list_pending_signals | record_event ✓ |
| **research** | Web research, turicks-brain, ICP scoring, publish leads | search_web, search_knowledge, search_turicks_brain, publish_signal | No |
| **comms** | Gmail inbox + send, Google Calendar | send_email, read_emails, create_calendar_event | send_email ✓, create_calendar_event ✓ |
| **engineering** | Code writing, GitHub ops, FounderOS features, cinematic presets, static deploy | github_read, github_write, project_workflow, claude_code, apply_cinematic_preset, deploy_static_site, publish_signal | github_write ✓, project_workflow ✓, claude_code ✓, deploy_static_site ✓ |
| **marketing** | LinkedIn content (sole owner), brand strategy | search_web, linkedin_post, search_knowledge, search_turicks_brain, publish_signal | linkedin_post ✓ |
| **sales** | Cold outreach to unknown companies/contacts | send_email, search_web, search_knowledge, search_turicks_brain | send_email ✓ |
| **personal** | Mac laptop: files, shell commands, Safari browser | read_file, list_dir, send_file, write_file, run_shell, browser, search_personal_rag, search_turicks_brain | write_file ✓, run_shell ✓, send_file ✓, browser ✓ |
| **jobhunt** | Job search, CV reading, application drafts | read_cv, search_jobs, send_email, search_personal_rag | send_email ✓ |

**Key design decisions:**
- `admin` dept owns memory/context tools — supervisor has NO tools (ADR-028)
- `linkedin_post` → marketing ONLY (was in comms → routing collisions removed)
- `read_emails` → comms ONLY (was in research → inbox data stays in its dept)
- `prospecting` dept merged into research (ICP scoring = research mode, no unique tools)
- `personal` and `engineering` are strictly separate (least-privilege, ADR-013)
- `search_personal_rag` → personal + jobhunt ONLY (career data is founder-private)

---

## Tool Architecture

Every tool has two layers:

```
src/tools/{name}.ts           ← Business logic (UnifiedTool interface)
                                   Pure, testable, no LangGraph imports
                                   execute(args) → { success, data, error }

src/agents/agent-tools.ts     ← LangChain wrapper + HITL gate
                                   Zod schema for type safety
                                   hitlGate() before every write/send
                                   Calls tools/{name}.ts internally
```

**Why two layers?**
- `src/tools/` can be tested without LangGraph (unit tests, probe scripts, MCP server)
- `agent-tools.ts` adapts tools for LangGraph agent use (schema, HITL pattern)
- If you mock `src/infra/composio.ts` in tests, you exercise real tool logic

**Adding a new tool:** See `../rules/TOOL-STANDARDS.md` (8-point checklist).

---

## HITL Pattern

Every write/send tool follows this exact pattern:

```typescript
export const myWriteTool = tool(
  async ({ param }) => {
    // 1. Pure validation only (runs TWICE — before and after interrupt)
    //    No HTTP, no DB writes above this line.

    // 2. Show approval card — graph pauses here
    const rejected = hitlGate({
      action: "my_action",
      title: "Do X?",
      summary: "What this will do",
      preview: param,
      args: { param },
    });
    if (rejected) return rejected;

    // 3. All side effects STRICTLY AFTER approval
    const res = await myTool.execute({ param });
    if (!res.success) return `Failed: ${res.error}`;
    return `✅ Done`;
  },
  { name: "my_tool", schema: z.object({ param: z.string() }) }
);
```

**Why interrupt() runs twice:** LangGraph pauses on `interrupt()` by throwing.
On resume, the tool re-executes from the top; `interrupt()` then returns the
resume value. Code above the gate runs twice — keep it pure (read-only).

---

## State Persistence

Every conversation is persisted to Postgres via LangGraph's Postgres checkpointer.
Thread ID = `{tenant}:{chatId}` — one thread per Telegram chat.

This means:
- A crash mid-HITL is safe — on restart, the pending approval is still there
- History is bounded to the last 12 human turns (prevents context drift loops)
- HITL approval state survives restarts

---

## Model

Single model for supervisor + all departments: **Gemini Flash via OpenRouter**

- Default ID: `openrouter:google/gemini-2.5-flash`
- Dev / free tier: `openrouter:google/gemini-2.5-flash:free`
- Temperature: **0** (determinism rule — routing must be reproducible; never change for prod)
- 503 fallback cascade: `flash → flash:free → deepseek-r1:free → llama-70b:free`
- Budget guard: per-run cost cap ($0.50 default), daily cap ($5.00 default)
- Gemini implicit caching: system-prompt prefix (~2.8k tokens) cached server-side automatically
  (≤75% cost reduction for cache hits — kept free by stabilising the prefix byte sequence)
- LangSmith tracing enabled when `LANGCHAIN_API_KEY` is set
- Judge model (Gate 2 outbound quality): `claude-haiku-4-5` via Anthropic API (separate key)

---

## File Map

```
src/
├── agents/
│   ├── office.ts              — buildOffice(): supervisor + 8 dept agents compiled once
│   ├── capabilities.ts        — DEPARTMENT_TOOLS map (single source of truth for tool assignment)
│   ├── model.ts               — getModel() + getModelFallbackMiddleware() (OpenRouter, 503 cascade)
│   ├── agent-tools.ts         — Barrel re-export of all HITL wrappers
│   ├── agent-tools/           — Per-dept HITL wrappers (hitl, research, comms, engineering…)
│   ├── system-prompts.ts      — Barrel re-export of all prompts
│   ├── prompts/               — One file per dept prompt
│   ├── contracts.ts           — Zod schemas for all dept_signals event types (ADR-022)
│   ├── context-isolation.ts   — assertContextIsolation() boot-time guard (ADR-021)
│   ├── tool-result.ts         — toolFailure(stage, msg) + isToolFailure() (ADR-032)
│   ├── state.ts               — LangGraph Annotation schemas + schema versions
│   ├── engineering-domain.ts  — CTO sub-supervisor (coder/qa/devops, off by default)
│   └── revenue-domain.ts      — Revenue sub-supervisor (marketing/sales, off by default)
├── tools/                     — Business logic (no LangGraph imports, fully unit-testable)
│   ├── email.ts               — Gmail send via Composio
│   ├── email-reader.ts        — Gmail read via Composio
│   ├── linkedin.ts            — LinkedIn post via Composio
│   ├── calendar.ts            — Google Calendar via Composio
│   ├── github.ts              — GitHub read/write via Octokit
│   ├── personal.ts            — Mac file/shell/browser I/O (path-guarded)
│   ├── career.ts              — CV read (personal-rag) + job search (Firecrawl)
│   ├── project-workflow.ts    — Shell commands in ~/Projects (HITL-gated)
│   ├── web-search.ts          — Web search via Firecrawl
│   ├── context.ts             — Business context read/write (Postgres, withToolErrorBoundary)
│   ├── knowledge.ts           — Turicks-brain keyword search (Postgres)
│   └── memory.ts              — Episodic memory search + record
├── infra/
│   ├── checkpointer.ts        — Postgres saver singleton
│   ├── context-manager.ts     — createAgentMiddleware() + createTrimmedPrompt()
│   ├── judge.ts               — Claude-as-judge gate 2 (fail-open, memoized, ADR-023)
│   ├── brand-validator.ts     — Gate 1: banned phrases + word-count (deterministic)
│   ├── composio.ts            — Composio API client + connection ID helpers
│   ├── path-guard.ts          — Home-dir confinement, secrets blocked (personal dept)
│   ├── budget.ts              — Per-run + daily cost caps
│   ├── single-instance.ts     — PID-file lock (prevents duplicate bot processes)
│   ├── history-window.ts      — Thread history trimmer (12 human turns, loop prevention)
│   ├── scheduler.ts           — Cron: Monday brief + HITL sweeper + dept_signals sweep
│   ├── telemetry.ts           — LangSmith tracing init + PII scrubber
│   └── health.ts              — /health endpoint
├── gateway/
│   ├── telegram.ts            — grammy bot, HITL card rendering, message loop
│   ├── office-run.ts          — Run-loop: interrupt guard, per-turn slicing, resume idempotency
│   ├── execution-guard.ts     — detectUnbackedMemoryClaim() anti-hallucination (ADR-032)
│   ├── commands.ts            — All /command handlers
│   └── format.ts              — Markdown → Telegram HTML converter
├── workflows/
│   ├── registry.ts            — Built-in SOP definitions
│   ├── runner.ts              — Workflow executor (callback-injected, pure)
│   └── types.ts               — WorkflowDef, WorkflowStep interfaces
├── eval/
│   ├── golden-tasks.ts        — Fixed eval inputs with expected routes/tools/HITL
│   ├── runner.ts              — Eval orchestrator (handleToolStart callbacks, never auto-approves)
│   └── scoring.ts             — Pure scoring functions
└── core/
    ├── config.ts              — Env validation (Zod), TENANT, budget constants, feature flags
    └── registry.ts            — Agent + company definitions
```

---

## What Does NOT Exist (by design)

- **No automatic sends** — every external action requires explicit approval
- **No duplicate tool ownership** — each tool has exactly one department
- **No tool registry** — tools are wired directly in office.ts, not via a Map
- **No YAML workflows** — workflows are typed TypeScript, not config files
- **No separate "prospecting" department** — ICP scoring is a research mode
- **No multi-tenant routing** — single-user system (TENANT = "turicks")
