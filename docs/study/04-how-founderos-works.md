# How FounderOS Works — A Codebase Walkthrough

*Read this alongside the source in VSCode. Every file path is clickable.*

---

## The Request Journey (Start Here)

When you send "Email alex@acme.com about our services" in Telegram:

```
1. src/gateway/telegram.ts       → receives grammy message, calls routeToOffice()
2. src/agents/office.ts          → getOffice() returns the compiled supervisor graph
3. office.invoke({ messages })   → supervisor LLM picks "comms" department
4. src/agents/agent-tools.ts     → comms agent calls send_email tool
5. interrupt({ title, preview }) → graph pauses, returns to telegram.ts
6. telegram.ts                   → getPendingApproval() detects the pause
7. telegram.ts                   → sends Approve/Reject card to Telegram
8. You tap Approve
9. telegram.ts                   → office.invoke(Command({ resume: "approved" }))
10. src/agents/agent-tools.ts    → interrupt() returns "approved", code continues
11. src/tools/email.ts           → emailTool.execute() sends real email via Composio
12. telegram.ts                  → sendResult() formats and sends reply to you
```

---

## File by File

### Entry Point
**`src/index.ts`** — 60 lines. Starts in order: telemetry → office → health server → Telegram bot. Nothing else. No custom HITL wiring, no scheduler, no log observer. The old index was 106 lines with 6 setup steps. If it's not in this file, it's not being booted.

---

### The Office
**`src/agents/office.ts`** — The entire multi-agent system. 8 departments, compiled once.

```typescript
export function buildOffice(checkpointer) {
  const llm = getModel();
  const deptModel = getModel();

  // agentMiddleware injects: 503-fallback chain + token trimming + tool-call caps
  const agentMiddleware = (prompt, opts?) => [
    ...getModelFallbackMiddleware(),
    ...createAgentMiddleware(prompt, { maxTokens: 4000, ...opts }),
  ];

  const admin       = createAgent({ model: deptModel, tools: DEPARTMENT_TOOLS["admin"],       name: "admin",       description: "...", includeAgentName: "inline", middleware: agentMiddleware(ADMIN_PROMPT) }).graph;
  const research    = createAgent({ model: deptModel, tools: DEPARTMENT_TOOLS["research"],    name: "research",    description: "...", includeAgentName: "inline", middleware: agentMiddleware(RESEARCH_PROMPT, SEARCH_TOOL_LIMITS) }).graph;
  const comms       = createAgent({ model: deptModel, tools: DEPARTMENT_TOOLS["comms"],       name: "comms",       description: "...", includeAgentName: "inline", middleware: agentMiddleware(buildCommsPrompt) }).graph;
  const engineering = ENGINEERING_SUBGRAPH_ENABLED ? buildEngineeringDomain() : createAgent({ ... }).graph;
  const marketing   = createAgent({ model: deptModel, tools: DEPARTMENT_TOOLS["marketing"],   name: "marketing",   description: "...", includeAgentName: "inline", middleware: agentMiddleware(MARKETING_PROMPT) }).graph;
  const sales       = createAgent({ model: deptModel, tools: DEPARTMENT_TOOLS["sales"],       name: "sales",       description: "...", includeAgentName: "inline", middleware: agentMiddleware(SALES_PROMPT) }).graph;
  const personal    = createAgent({ model: deptModel, tools: DEPARTMENT_TOOLS["personal"],    name: "personal",    description: "...", includeAgentName: "inline", middleware: agentMiddleware(PERSONAL_PROMPT) }).graph;
  const jobhunt     = createAgent({ model: deptModel, tools: DEPARTMENT_TOOLS["jobhunt"],     name: "jobhunt",     description: "...", includeAgentName: "inline", middleware: agentMiddleware(JOBHUNT_PROMPT) }).graph;

  const revenueAgents = REVENUE_SUBGRAPH_ENABLED ? [buildRevenueDomain()] : [marketing, sales];

  return createSupervisor({
    agents: [admin, research, comms, engineering, ...revenueAgents, personal, jobhunt],
    llm,
    prompt: createTrimmedPrompt(buildSupervisorPrompt, { maxTokens: 6000 }),
    outputMode: assertContextIsolation(CONTEXT_ISOLATION_OUTPUT_MODE),  // "last_message"
    includeAgentName: "inline",
  }).compile({ checkpointer });
}
```

**Key patterns:**
- `DEPARTMENT_TOOLS` from `capabilities.ts` — single source of truth for tool assignments
- `agentMiddleware` — wraps every department with fallback + trimming + caps
- `assertContextIsolation()` — boot-time crash if `outputMode` ever becomes `"full_history"`
- `ENGINEERING_SUBGRAPH_ENABLED` / `REVENUE_SUBGRAPH_ENABLED` — feature flags for nested supervisors

`buildOffice(checkpointer)` is the real constructor — takes a checkpointer so tests inject
`MemorySaver`. `getOffice()` is the production singleton using the real Postgres saver.
**Never call `buildOffice` in production** — always `getOffice()`.

`getPendingApproval(office, config)` — inspects `getState().tasks` for interrupts. Returns
the `ApprovalRequest` payload or `null`. The gateway calls this after every `invoke()`.

---

### The Model
**`src/agents/model.ts`** — Provider-agnostic model factory via OpenRouter.

```typescript
// Default: "openrouter:google/gemini-2.5-flash"
// Dev:     "openrouter:google/gemini-2.5-flash:free"
// Override: AGENT_MODEL env var with "openrouter:<provider>/<model>"
export function getModel(): BaseChatModel {
  const modelId = process.env["AGENT_MODEL"] ?? DEFAULT_AGENT_MODEL;
  // modelId prefix ("openrouter:", "anthropic:", "openai:") → correct LangChain class
  return buildModelFromId(modelId, { temperature: 0 });
}

export function getModelFallbackMiddleware() {
  // On 503: retries flash → flash:free → deepseek-r1:free → llama-70b:free
  // On non-503: re-throws immediately
  return buildFallbackMiddleware(FALLBACK_MODELS);
}
```

**Temperature is 0 (non-negotiable).** Same input → same routing decision. Determinism
in routing is a correctness requirement, not a preference (rule #16).

**The `openrouter:` prefix is mandatory** — `model.ts` infers the provider from it and
instantiates the correct LangChain class (`ChatOpenAI` with base URL override). Never
set `google-genai:gemini-*` locally — that routes through the paid Google API key.

---

### System Prompts
**`src/agents/system-prompts.ts`** — Barrel re-export. One prompt file per role.

| Export | Who uses it | Purpose |
|--------|-------------|---------|
| `buildSupervisorPrompt` | Supervisor | Auto-generated from capabilities.ts — never drifts from actual tool assignments |
| `ADMIN_PROMPT` | Admin agent | Business context, episodic memory, pending signals |
| `RESEARCH_PROMPT` | Research agent | Web search, turicks-brain, ICP scoring, cite sources |
| `buildCommsPrompt` | Comms agent | Gmail + Calendar, date-injected dynamically |
| `ENGINEERING_PROMPT` | Engineering agent | GitHub ops, claude_code executor, complete working code |
| `MARKETING_PROMPT` | Marketing agent | LinkedIn content in Turicks brand voice |
| `SALES_PROMPT` | Sales agent | Cold outreach, ICP scoring, HITL on every email |
| `PERSONAL_PROMPT` | Personal agent | Laptop operator — files/shell/browser, path-guard aware |
| `JOBHUNT_PROMPT` | Jobhunt agent | Job search, CV reading, application drafts |
| `BRAND_BANNED_SECTION` | comms/sales/marketing | Shared banned phrases + voice rules |

**Key change from v1:** The supervisor's capability manifest is *auto-generated* from
`capabilities.ts` and the `description` field on each `createAgent()` call. Hand-maintained
prompt prose is gone — the bot can no longer claim it "doesn't have browser" when it does.

**How to tune:** if an agent is doing the wrong thing, the prompt is the first thing to
change. Keep prompts concrete — specify what "good" looks like, not just the role name.

---

### Agent Tools (The Important File)
**`src/agents/agent-tools.ts`** — Where tools meet HITL.

**Read-only tools** (no approval):
- `searchWeb` → calls `webSearchTool.execute()`, formats results as text

**Write tools** (approval required):
```typescript
export const sendEmail = tool(
  async ({ to, subject, body }) => {
    // 1. interrupt() — runs twice (pause + resume), must be pure
    const decision = interrupt({
      kind: "approval", action: "send_email",
      title: `📧 Send email to ${to}?`,
      preview: body,
    }) as string;

    if (decision !== "approved") return "Email not sent — rejected.";

    // 2. Side effects ONLY after approval
    if (await isSuppressed(TENANT, to)) return "BLOCKED: on do-not-contact list.";
    const res = await emailTool.execute({ to, subject, body, ... });
    return res.success ? `✅ Email sent to ${to}` : `Failed: ${res.error}`;
  },
  { name: "send_email", schema: z.object({ to, subject, body }) }
);
```

`idemKey(prefix, ...parts)` — generates a deterministic idempotency key from the content. Same email content always produces the same key → the audit_log check prevents double-sends even if `invoke()` is called twice.

---

### The Real Tools
These are unchanged from v1 — they were always good:

**`src/tools/email.ts`** — Composio Gmail via `OpenAIToolSet.executeAction("GMAIL_SEND_EMAIL")`. Idempotency check via `hasBeenAudited()` before the send. Writes to `action_log` after success.

**`src/tools/web-search.ts`** — POST to Firecrawl `/v1/search`. Returns `{ title, url, snippet }[]`. Fail-open (returns error string, never throws).

**`src/tools/github.ts`** — Octokit wrapper. Actions: `list_repos`, `get_readme`, `update_readme`, `get_stats`, `create_issue`, `create_repo`. `GITHUB_TOKEN` required.

**`src/tools/linkedin.ts`** — Composio LinkedIn via `LINKEDIN_CREATE_SHARE_POST`. Idempotency-checked. `COMPOSIO_API_KEY` required + LinkedIn OAuth connection in Composio dashboard.

---

### Gateway
**`src/gateway/telegram.ts`** — grammy bot wired to the office.

Key functions:
- `routeToOffice(ctx)` — sends `HumanMessage` to office, handles approval or final reply
- `resumeOffice(ctx, decision)` — resumes after Approve/Reject button tap
- `sendResult(ctx, res, chatId)` — extracts final AI message + scans for tool errors
- `collectToolErrors(res)` — scans message trail for tool failure patterns (they return strings, not throws)
- `sendApprovalCard(ctx, approval)` — renders title + preview + Approve/Reject buttons

Thread ID: `turicks:{chatId}` — one stable conversation per Telegram chat.

---

### Infrastructure

**`src/infra/checkpointer.ts`** — Postgres saver singleton. Validates `DATABASE_URL`.
Calls `.setup()` to create LangGraph checkpoint tables if they don't exist.

**`src/infra/context-manager.ts`** — Token trimming + prompt middleware.
- `createTrimmedPrompt(promptFn, { maxTokens })` — trims the message history suffix
  before each LLM call, keeping the system-prompt prefix stable for Gemini caching
- `createAgentMiddleware(prompt, opts)` — wraps a department with trimming + tool-call caps

**`src/agents/context-isolation.ts`** — `assertContextIsolation(mode)` guard.
Throws at boot time if `outputMode` is ever changed from `"last_message"`.

**`src/agents/capabilities.ts`** — `DEPARTMENT_TOOLS` map. Single source of truth for
which tools each department carries. The supervisor's manifest is auto-generated from here.

**`src/agents/contracts.ts`** — Zod schemas for every `dept_signals` event type.
`validateSignalPayload(eventType, payload)` validates before every cross-dept write.

**`src/agents/tool-result.ts`** — `toolFailure(stage, message)` and `isToolFailure()`.
Structured failure envelope with a machine-readable `[[TOOL_FAILURE stage=X]]` marker.

**`src/gateway/execution-guard.ts`** — `detectUnbackedMemoryClaim(messages, toolsUsed)`.
Deterministic guard that forces memory tool calls on internal-knowledge questions (ADR-032).

**`src/infra/judge.ts`** — Claude-as-judge for outbound copy quality (ADR-023).
Gate 2 in the three-layer quality gate. Fail-open, memoized, temperature 0.

**`src/infra/budget.ts`** — Per-run ($0.50) + daily ($5.00) cost caps.
Budget callback injected into every `office.invoke()`.

**`src/infra/path-guard.ts`** — Home-dir confinement for the personal department.
Blocks paths outside `$HOME`, secret files (`.ssh`, `.env`, `id_rsa`), system dirs.

**`src/infra/single-instance.ts`** — PID-file lock prevents duplicate bot processes.

**`src/infra/history-window.ts`** — Bounds thread history to 12 human turns.

**`src/db/schema.ts`** — Drizzle schema. Active tables: `action_log`, `do_not_contact`,
`dept_signals` (now live with publish/consume), `episodic_memory`, `context`,
`knowledge_entries` + LangGraph checkpoint tables.

**`src/db/queries.ts`** — `hasBeenAudited()`, `writeAuditEntry()`, `isSuppressed()`,
`publishDeptEvent()`, `consumePendingEvents()`. All DB access goes through here.

**`src/infra/health.ts`** — `/health` endpoint. Used by uptime monitors.

**`src/infra/telemetry.ts`** — LangSmith tracing init + PII scrubber.
Set `LANGCHAIN_TRACING_V2=true` to enable tracing.

---

### The Tests
**`tests/integration/office-hitl.test.ts`** — The most important test file. Proves:
- `reject → email NOT sent` (approvals work)
- `approve → email sent exactly once` (no double-sends)
- `research → no interrupt` (read-only tools never ask for approval)

Run with: `npx vitest run tests/integration/office-hitl.test.ts`

**`tests/unit/`** — Unit tests for old v1 components (still green, still valid).

---

## Common Operations

### Add a new department
1. Add tools to `src/agents/agent-tools.ts`
2. Add prompt to `src/agents/system-prompts.ts`  
3. Add 4 lines to `src/agents/office.ts` (`createReactAgent` + add to array)
4. Update `SUPERVISOR_PROMPT` with the new department name

### Change what the supervisor routes to where
Edit `SUPERVISOR_PROMPT` in `src/agents/system-prompts.ts`. The supervisor is just an LLM reading that prompt — updating the text changes its behavior immediately.

### Test locally without sending real emails
```typescript
import { vi } from "vitest";
vi.mock("../../src/tools/email.js", () => ({
  emailTool: { execute: vi.fn(async () => ({ success: true })) }
}));
```

### Check if email actually sent (vs just approved)
```bash
# look for the real send log
grep "Email sent via agent" /tmp/founderos.log
# or check the audit log in Postgres
docker exec -it turicks-postgres psql -U turicks -d turicks -c "SELECT * FROM action_log WHERE action = 'send_email' ORDER BY created_at DESC LIMIT 5;"
```

### Tail live logs
```bash
tail -f /tmp/founderos.log | grep -v "level\|time\|app\|env"
```

---

## Environment Variables Quick Reference

| Variable | Required | What for |
|----------|----------|---------|
| `DATABASE_URL` | ✅ | Postgres connection (checkpointer + all tables) |
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot polling |
| `OPENROUTER_API_KEY` | ✅ | All LLM calls via OpenRouter (Gemini, fallbacks) |
| `AGENT_MODEL` | Optional | Model override (default: `openrouter:google/gemini-2.5-flash`) |
| `AGENT_FALLBACK_MODELS` | Optional | 503-fallback chain (comma-separated OpenRouter model IDs) |
| `AGENT_TEMPERATURE` | Optional | Override temperature (default: `0` — never change for prod) |
| `COMPOSIO_API_KEY` | For email/LinkedIn/Calendar | Composio integration execution |
| `FIRECRAWL_API_KEY` | For web search | Firecrawl search API |
| `GITHUB_TOKEN` | For GitHub operations | Octokit auth (classic PAT) |
| `ANTHROPIC_API_KEY` | For judge gate | Claude judge (Gate 2, fail-open if absent) |
| `JUDGE_MODEL` | Optional | Claude model for judge (default: `claude-haiku-4-5`) |
| `BUDGET_PER_RUN_USD` | Optional | Per-run cost cap (default: `0.50`) |
| `BUDGET_DAILY_USD` | Optional | Daily cost cap (default: `5.00`) |
| `ENGINEERING_SUBGRAPH` | Optional | `1` = nested CTO sub-supervisor (default: flat) |
| `REVENUE_SUBGRAPH` | Optional | `1` = nested revenue sub-supervisor (default: flat) |
| `LANGCHAIN_API_KEY` | Optional | LangSmith tracing key |
| `LANGCHAIN_TRACING_V2` | Optional | Enable LangSmith tracing (`true`/`false`) |
| `LANGCHAIN_PROJECT` | Optional | LangSmith project name |
