# FounderOS — Tool Addition Standards

> Every new tool must pass all 8 checks before it is considered done.
> This rule exists because the most common failure mode is NOT logic bugs —
> it's wrong external API field names and undetected soft-failures.
> We hit this with calendar (wrong `start.dateTime`), email (phantom success),
> and linkedin (phantom success). Tests catch all of these in 5 minutes.

---

## The 8-Point Checklist

### ✅ 1. `UnifiedTool` in `src/tools/{name}.ts`

Implement the `UnifiedTool` interface. All external call logic goes here — no LangGraph/LangChain imports.

```typescript
export const myTool: UnifiedTool = {
  name: "my_tool",
  description: "...",
  input_schema: { type: "object", properties: { ... }, required: [...] },
  async execute(input): Promise<ToolResult> {
    // All logic here — pure, testable, framework-free
  }
};
```

`execute()` must **never throw**. Catch all errors and return `{ success: false, error: message }`.

---

### ✅ 2. Unit test in `tests/unit/tools/{name}.test.ts`

Mock the external API layer (Composio, HTTP). Test these three paths minimum:

| Path | What to assert |
|------|---------------|
| **Happy path** | `success: true`, correct id in `data`, audit written |
| **Soft failure** | `success: false`, audit NOT written (retry not blocked) |
| **Network error** (thrown) | `success: false`, error message present |

**Soft failure is mandatory.** Composio (and most HTTP APIs) can return HTTP 200 with an error message body and no success id. If you don't test this, you will not catch it.

```typescript
it("returns success: false when Composio returns 200 + error message with no id", async () => {
  mockExecuteComposioAction.mockResolvedValue({
    data: { message: "Token expired." },  // no id field
  });

  const result = await myTool.execute(BASE_ARGS);

  expect(result.success).toBe(false);
  expect(mockWriteAuditEntry).not.toHaveBeenCalled(); // must not suppress retry
});
```

---

### ✅ 3. Soft-failure detection inside `execute()`

After the external call, assert the success marker exists before returning `success: true`:

```typescript
const eventId = result?.data?.id as string | undefined;

if (!eventId) {
  const msg = result?.data?.message ?? "Failed — no id returned";
  return { success: false, error: msg };
}
// Only write audit and return success AFTER confirming the id
```

Pattern confirmed working in: `calendar.ts` (reference implementation).
Pattern fixed in: `email.ts`, `linkedin.ts` (2026-06-05).

---

### ✅ 4. Idempotency guard for any send/create/mutate

Use `hasBeenAudited()` before calling the external API and `writeAuditEntry()` **only after** confirming the success id:

```typescript
const alreadyDone = await hasBeenAudited(idempotency_key);
if (alreadyDone) return { success: true, data: { skipped: true } };

// ... call external API ...

if (!successId) return { success: false, error: msg }; // soft-failure FIRST

await writeAuditEntry({ ... }); // THEN write audit, ONLY on confirmed success
```

**No idempotency = no production write tool.** Calendar is the only current exception (P1 — add before merging any calendar send).

---

### ✅ 5. LangChain wrapper in `src/agents/agent-tools.ts`

Every write/send/mutate tool needs a HITL gate:

```typescript
export const myTool = tool(
  async ({ param }) => {
    // Pure validation above interrupt() — runs TWICE (pause + resume)
    const rejected = hitlGate({
      action: "my_action",
      title: "Do X?",
      summary: "...",
      preview: param,
      args: { param },
    });
    if (rejected) return rejected;

    // All side effects STRICTLY AFTER the gate
    const res = await myToolImpl.execute({ param });
    if (!res.success) return `X failed: ${res.error}`;
    return `✅ Done`;
  },
  {
    name: "my_tool",
    description: "...",
    schema: z.object({ param: z.string() }),
  }
);
```

Read-only tools (search, list, read) do NOT need `hitlGate`.

---

### ✅ 6. Wire into the correct department in `src/agents/office.ts`

Add the exported tool to the right `createReactAgent({ tools: [...] })` call.
**Do not add to `src/tools/index.ts`** — that registry is dead code and is not used by the agent.

---

### ✅ 7. Live probe script `scripts/probe-{name}.ts`

For Composio-backed tools, write a live probe that:
- Calls the tool directly (bypassing HITL)
- Uses `isRealSuccess()` pattern to detect soft failures
- Cleans up after itself (marks test events with "— delete me")
- Exits 1 on any failure

```bash
npx tsx --env-file=.env scripts/probe-{name}.ts
```

This is your integration test. The unit test (above) tests your code.
The probe test tests that Composio's endpoint actually works.

---

### ✅ 8. `pnpm test` green + `pnpm lint` clean

Non-negotiable before opening a PR.

---

## Quick Reference: Composio Field-Name Traps

Composio abstracts the raw API — field names often differ from vendor docs:

| Tool | Wrong | Right |
|------|-------|-------|
| Gmail send | `to`, `content` | `recipient_email`, `body` |
| LinkedIn post | `text`, `visibility: "PUBLIC"` | `commentary`, `visibility: { "com.linkedin.ugc...": "PUBLIC" }` |
| Google Calendar create | `start.dateTime`, `start.date` | `start_datetime` (flat ISO string) |

**When adding any new Composio tool:** run a minimal probe call first, read the exact error message, find the correct field names — THEN write the implementation. Never guess field names from the vendor API docs.

---

## Department → Tool Mapping (current)

| Department | Tools |
|-----------|-------|
| research | search_web, search_knowledge, read_emails |
| comms | send_email, read_emails, linkedin_post, create_calendar_event |
| engineering | github_read, github_write, project_workflow, claude_code |
| marketing | search_web, linkedin_post, search_knowledge |
| sales | search_web, send_email, search_knowledge |
| prospecting | search_web, search_knowledge |
| personal | read_file, list_dir, send_file, write_file, run_shell, browser |
| jobhunt | read_cv, search_jobs, send_email |

> **Note:** `read_emails` in `research` is a known concern — inbox reads are communication data and arguably belong only in `comms`. Tracked for next architecture clean-up pass.

---

## Known Architecture Gaps (tracked, not yet fixed)

| Gap | Severity | Status |
|-----|----------|--------|
| `tools/index.ts` registry is dead code | P2 | ✅ Fixed 2026-06-05 (registry removed) |
| `prospecting` has no unique tool vs `research` | P2 | ✅ Fixed 2026-06-05 (merged into research) |
| `linkedin_post` lives in both `comms` and `marketing` | P2 | ✅ Fixed 2026-06-05 (marketing-only) |
| Calendar has no idempotency guard | P1 | ✅ Fixed 2026-06-05 (idempotency_key added) |
| `agent-tools.ts` (656 lines) needs splitting | P2 | ✅ Fixed 2026-06-05 (split into agent-tools/) |
