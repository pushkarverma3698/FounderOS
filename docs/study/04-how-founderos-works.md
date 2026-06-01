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
**`src/agents/office.ts`** — The entire multi-agent system.

```typescript
export function buildOffice(checkpointer) {
  const llm = getModel();
  
  const research   = createReactAgent({ llm, tools: [searchWeb],              name: "research",    prompt: RESEARCH_PROMPT });
  const comms      = createReactAgent({ llm, tools: [sendEmail, linkedinPost], name: "comms",       prompt: COMMS_PROMPT });
  const engineering = createReactAgent({ llm, tools: [githubRead, githubWrite], name: "engineering", prompt: ENGINEERING_PROMPT });
  
  return createSupervisor({
    agents: [research, comms, engineering],
    llm,
    prompt: SUPERVISOR_PROMPT,
    includeAgentName: "inline",    // ← makes Gemini happy (see study/02)
  }).compile({ checkpointer });
}
```

`buildOffice(checkpointer)` is the real constructor — it takes a checkpointer so tests can inject `MemorySaver`. `getOffice()` is the production singleton that uses the real Postgres saver. **Never call `buildOffice` in production** — always `getOffice()`.

`getPendingApproval(office, config)` — inspects `getState().tasks` for interrupts. Returns the `ApprovalRequest` payload or `null`. The gateway calls this after every `invoke()`.

---

### The Model
**`src/agents/model.ts`** — One model, intelligently.

```typescript
class FounderChatGoogle extends ChatGoogleGenerativeAI {
  // strips `name` attribute from messages before sending to Gemini
  // because Gemini maps message.name → author and throws on "supervisor"
  override async _generate(messages, options, runManager) {
    return super._generate(stripNames(messages), options, runManager);
  }
}

export function getModel() {
  const model = process.env["AGENT_MODEL"] ?? "gemini-2.5-flash";
  return new FounderChatGoogle({ model, temperature: 0.3, maxRetries: 2 });
}
```

To switch to Claude when you get a valid Anthropic key: set `AGENT_MODEL=claude-sonnet-4-5` in `.env` and swap the class to `ChatAnthropic`. No other code changes needed.

---

### System Prompts
**`src/agents/system-prompts.ts`** — 4 prompts, one per role.

| Export | Who uses it | Purpose |
|--------|-------------|---------|
| `SUPERVISOR_PROMPT` | Supervisor | Describes Pushkar, the 3 departments, and when to route vs answer directly |
| `RESEARCH_PROMPT` | Research agent | Focus on web search, cite sources, never fabricate |
| `COMMS_PROMPT` | Comms agent | Email + LinkedIn voice, real content not placeholders, approval required |
| `ENGINEERING_PROMPT` | Engineering agent | Complete working code, real GitHub calls, no stubs |

**How to tune:** if an agent is doing the wrong thing, the prompt is the first thing to change. Keep prompts concrete — specify what "good" looks like, not just what the role is.

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

### Infrastructure (Kept from v1)
**`src/infra/checkpointer.ts`** — Postgres saver singleton. Validates `DATABASE_URL` format. Calls `.setup()` to create LangGraph checkpoint tables if they don't exist.

**`src/db/schema.ts`** — Drizzle schema. Only tables we actually use: `action_log`, `do_not_contact`, plus the LangGraph checkpoint tables (managed by the saver). The old tables (`hitl_approvals`, `ai_call_costs`, `dept_signals`, `agent_results`) remain in the schema but are not used by v2 — they'll be cleaned in a migration.

**`src/db/queries.ts`** — `hasBeenAudited()`, `writeAuditEntry()`, `isSuppressed()`. Called directly from tools. No pod dependencies.

**`src/infra/health.ts`** — `/health` endpoint returns 200. Used by uptime monitors.

**`src/infra/telemetry.ts`** — LangSmith tracing init. Set `LANGCHAIN_TRACING_V2=true` to enable.

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
| `DATABASE_URL` | ✅ | Postgres connection (checkpointer + audit_log) |
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot polling |
| `TELEGRAM_CHAT_ID` | ✅ | Send proactive messages (not used in v2 — legacy) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | ✅ | Gemini Flash (all agents) |
| `COMPOSIO_API_KEY` | For email/LinkedIn | Composio action execution |
| `FIRECRAWL_API_KEY` | For web search | Firecrawl search API |
| `GITHUB_TOKEN` | For GitHub writes | Octokit auth (classic PAT) |
| `AGENT_MODEL` | Optional | Swap model (default: `gemini-2.5-flash`) |
| `FOUNDER_TENANT` | Optional | Tenant name (default: `turicks`) |
| `LANGCHAIN_API_KEY` | Optional | LangSmith tracing |
| `LANGCHAIN_TRACING_V2` | Optional | Enable LangSmith (`true`/`false`) |
