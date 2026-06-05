# FounderOS — Architecture

> **One line:** A Telegram bot where you type a task and the right department
> executes it — with your approval before anything is sent or changed.

---

## How it works (plain English)

1. You send a message to Telegram
2. A **supervisor** reads it and decides which of 7 departments handles it
3. The department executes — using its tools (web search, GitHub, Gmail, etc.)
4. If the action is a write/send (email, calendar event, GitHub PR), it **pauses and shows
   an approval card** — you tap Approve or Reject
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
│  Model: Gemini Flash, temperature=0 (deterministic)     │
│  Tools: read_context, update_context,                   │
│         search_memory, record_event                     │
│                                                         │
│  Routes to one of 7 departments:                        │
│  research · comms · engineering · marketing             │
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

## The 7 Departments

Each department has a clear scope. No tool belongs to two departments.

| Department | What it does | Tools | HITL? |
|-----------|-------------|-------|-------|
| **research** | Web research, internal knowledge search, ICP scoring | search_web, search_knowledge | No |
| **comms** | Gmail inbox + send, Google Calendar | send_email, read_emails, create_calendar_event | send_email ✓, create_calendar_event ✓ |
| **engineering** | Code writing, GitHub ops, FounderOS features | github_read, github_write, project_workflow, claude_code | github_write ✓, project_workflow (run_command) ✓ |
| **marketing** | LinkedIn content (sole owner), brand strategy | search_web, linkedin_post, search_knowledge | linkedin_post ✓ |
| **sales** | Cold outreach to unknown companies/contacts | search_web, send_email, search_knowledge | send_email ✓ |
| **personal** | Mac laptop: files, shell commands, browser | read_file, list_dir, send_file, write_file, run_shell, browser | write_file ✓, run_shell ✓, send_file ✓, browser ✓ |
| **jobhunt** | Job search, CV reading, application drafts | read_cv, search_jobs, send_email | send_email ✓ |

**Key design decisions:**
- `linkedin_post` → marketing ONLY (was in comms too → routing collisions removed)
- `read_emails` → comms ONLY (was in research too → inbox data stays in its dept)
- `prospecting` dept merged into research (ICP scoring = research mode, no unique tools)

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

**Adding a new tool:** See `docs/TOOL-STANDARDS.md` (8-point checklist).

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

Single model for supervisor + all departments: `Gemini Flash`

- Temperature: **0** (determinism rule — routing must be reproducible)
- Fallback cascade on 503: `gemini-2.5-flash → gemini-2.0-flash → gemini-1.5-flash`
- Budget guard: per-run cost cap ($0.50 default), daily cap ($5.00 default)
- LangSmith tracing enabled when `LANGCHAIN_API_KEY` is set

---

## File Map

```
src/
├── agents/
│   ├── model.ts          — getModel() with 503 fallback cascade
│   ├── office.ts         — buildOffice(): supervisor + 7 dept agents compiled once
│   ├── agent-tools.ts    — LangChain tool() wrappers + hitlGate()
│   └── system-prompts.ts — All 8 prompts (supervisor + 7 depts)
├── tools/                — Business logic (UnifiedTool, no LangGraph)
│   ├── email.ts          — Gmail send via Composio
│   ├── email-reader.ts   — Gmail read via Composio
│   ├── linkedin.ts       — LinkedIn post via Composio
│   ├── calendar.ts       — Google Calendar via Composio
│   ├── github.ts         — GitHub read/write via Octokit
│   ├── personal.ts       — Mac file/shell/browser I/O (path-guarded)
│   ├── career.ts         — CV read (personal-rag) + job search (Firecrawl)
│   ├── project-workflow.ts — Shell commands in ~/Projects (HITL-gated)
│   ├── web-search.ts     — Web search via Firecrawl
│   ├── context.ts        — Business context read/write (Postgres)
│   ├── knowledge.ts      — Turicks-brain keyword search (Postgres)
│   └── memory.ts         — Episodic memory search + record
├── infra/
│   ├── composio.ts       — Composio API client + connection ID helpers
│   ├── path-guard.ts     — Home-dir confinement, secrets blocked
│   ├── budget.ts         — Per-run + daily cost caps
│   ├── single-instance.ts — PID-file lock (prevents duplicate bot processes)
│   └── history-window.ts — Thread history trimmer (loop prevention)
├── gateway/
│   ├── telegram.ts       — grammy bot, HITL card rendering, message loop
│   ├── commands.ts       — All slash command handlers
│   └── format.ts         — Markdown → Telegram HTML converter
├── workflows/
│   ├── registry.ts       — Built-in SOP definitions (onboarding, outbound, weekly_digest)
│   ├── runner.ts         — Workflow executor (callback-injected, pure)
│   └── types.ts          — WorkflowDef, WorkflowStep interfaces
├── eval/
│   ├── golden-tasks.ts   — Fixed eval inputs with expected routes/tools/HITL
│   ├── runner.ts         — Eval orchestrator (never auto-approves)
│   └── scoring.ts        — Pure scoring functions
└── core/
    └── config.ts         — Env validation (Zod), TENANT, budget constants
```

---

## What Does NOT Exist (by design)

- **No automatic sends** — every external action requires explicit approval
- **No duplicate tool ownership** — each tool has exactly one department
- **No tool registry** — tools are wired directly in office.ts, not via a Map
- **No YAML workflows** — workflows are typed TypeScript, not config files
- **No separate "prospecting" department** — ICP scoring is a research mode
- **No multi-tenant routing** — single-user system (TENANT = "turicks")
