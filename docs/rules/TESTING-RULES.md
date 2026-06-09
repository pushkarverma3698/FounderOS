# FounderOS — Testing Rules

> Rules learned from real production bugs. Every rule here comes from a bug
> that was NOT caught in tests and DID reach production.
>
> The theme: **tests that always pass are not tests — they are documentation.**

---

## Rule 1: Test the Contract, Not the Outcome

**The bug this catches:** Wrong Composio field names (`text` instead of `commentary`,
`start.dateTime` instead of `start_datetime`).

**The mistake:** Mocking `executeComposioAction` to return success regardless of what
arguments are passed. The test passes even when the real API would reject the call.

**The rule:** Every tool test MUST assert the exact arguments sent to the external API.

```typescript
// ❌ WRONG — tests that the function ran, not that it ran correctly
mockExecuteComposioAction.mockResolvedValue({ data: { id: "post_1" } });
await linkedinPostTool.execute(args);
expect(result.success).toBe(true); // This passes even with wrong field names

// ✅ RIGHT — tests the contract with the external API
mockExecuteComposioAction.mockResolvedValue({ data: { id: "post_1" } });
await linkedinPostTool.execute(args);
const [action, fields] = mockExecuteComposioAction.mock.calls[0];
expect(action).toBe("LINKEDIN_CREATE_LINKED_IN_POST");
expect(fields).toHaveProperty("commentary", "Hello LinkedIn"); // NOT "text"
expect(fields).not.toHaveProperty("text");                     // explicit rejection
```

**Minimum fields to assert per tool:**

| Tool | Must assert |
|------|------------|
| gmail send | action=`GMAIL_SEND_EMAIL`, field=`recipient_email` (not `to`), field=`body` |
| linkedin post | action=`LINKEDIN_CREATE_LINKED_IN_POST`, field=`commentary` (not `text`), `visibility` is object |
| google calendar | action=`GOOGLECALENDAR_CREATE_EVENT`, field=`start_datetime` (not `start.dateTime`) |

---

## Rule 2: Mandatory Soft-Failure Test for Every Composio Tool

**The bug this catches:** Composio (and most HTTP APIs) can return HTTP 200 with an
error message body and no success id. Without a guard, the tool returns `success: true`
with undefined data.

**In production:** We recorded phantom "email sent" and "LinkedIn posted" events in the
audit log. The actual send never happened. All retries were then suppressed forever.

**The rule:** Every tool that calls an external API MUST have this test:

```typescript
it("returns success: false when API returns 200 + error message with no id", async () => {
  // This is what Composio actually returns on auth failures, rate limits, etc.
  mockExecuteComposioAction.mockResolvedValue({
    data: { message: "Authentication token expired. Please reconnect." },
    // Note: no "id" field — this is the soft failure signature
  });

  const result = await myTool.execute(BASE_ARGS);

  expect(result.success).toBe(false);
  // Must contain the actual error message so the agent can surface it
  expect(result.error).toBeTruthy();
});
```

**Why this test was missed:** The natural test pattern is "mock returns success → tool
returns success". Developers forget to also test "mock returns 200 with no data → tool
returns failure". It takes 3 extra lines and prevents a class of production bugs.

---

## Rule 3: Mandatory Retry-Suppression Test

**The bug this catches:** If a soft failure writes an audit entry, every future retry is
blocked by the idempotency guard even though the action never succeeded.

**The rule:** Every tool with an audit log MUST test that soft-failure does NOT write
the audit entry.

```typescript
it("does NOT write audit entry on soft failure — so retry is not suppressed", async () => {
  mockExecuteComposioAction.mockResolvedValue({
    data: { message: "Rate limit exceeded" },
  });

  await myTool.execute(BASE_ARGS);

  // The audit entry gates all future retries.
  // If it's written on failure, the action can never be retried.
  expect(mockWriteAuditEntry).not.toHaveBeenCalled();
});
```

**Corollary:** The audit entry must be written AFTER the success id is confirmed, never before.

```typescript
// ❌ WRONG — writes audit before checking if the action succeeded
const result = await executeComposioAction(...);
await writeAuditEntry({ ... });          // written even if result has no id
const id = result?.data?.id;
if (!id) return { success: false };      // audit already written, retry blocked

// ✅ RIGHT — guards first, then writes
const result = await executeComposioAction(...);
const id = result?.data?.response_data?.id;
if (!id) return { success: false };      // bail before writing audit
await writeAuditEntry({ ... });          // only written on confirmed success
```

---

## Rule 4: Mock State Isolation

**The bug this catches:** A mock from one test leaks into the next, making tests
order-dependent and randomly flaky.

**The rule:** Always reset mocks in `beforeEach`.

```typescript
beforeEach(() => {
  vi.clearAllMocks();  // reset call counts AND return values
  // Re-set the happy-path default so each test starts clean
  mockGetComposioApiKey.mockReturnValue("test-key");
  mockHasBeenAudited.mockResolvedValue(false);
  mockWriteAuditEntry.mockResolvedValue(undefined);
});
```

**Use `vi.clearAllMocks()` not `vi.resetAllMocks()`** — reset removes implementations,
clear only clears call history. You want to clear history but keep the default
implementations set up in the outer describe block.

---

## Rule 5: Mock at the Boundary, Test Real Logic

**The rule:** Mock external calls (`executeComposioAction`, `hasBeenAudited`). Do NOT
mock internal functions. The test must exercise the real code path.

```typescript
// ❌ WRONG — mocking your own logic defeats the purpose
vi.mock("../../../src/tools/email.js", () => ({
  emailTool: { execute: vi.fn().mockResolvedValue({ success: true }) }
}));

// ✅ RIGHT — mock only the external boundary
vi.mock("../../../src/infra/composio.js", () => ({
  executeComposioAction: vi.fn(),
  getComposioApiKey: vi.fn(() => "test-key"),
  getGmailConnectionId: () => "ca_test",
  getGmailUserId: () => "user_test",
}));
// The real emailTool.execute() runs — only the HTTP call is controlled
```

---

## Rule 6: Three-Path Coverage for Every Write Tool

Every tool that calls an external API and writes an audit entry requires at minimum
these three tests. No tool ships without all three.

```
1. Happy path:    API returns id → success: true, audit written, id in data
2. Soft failure:  API returns 200 + message, no id → success: false, audit NOT written
3. Thrown error:  API throws network error → success: false, audit NOT written
```

Table showing coverage status per tool:

| Tool | Happy | Soft fail | Thrown | Notes |
|------|-------|-----------|--------|-------|
| email.ts | ✅ | ✅ | ✅ | Fixed 2026-06-05 |
| linkedin.ts | ✅ | ✅ | ✅ | Fixed 2026-06-05 |
| calendar.ts | ✅ | ✅ | ✅ | Added 2026-06-05 |
| github.ts | ✅ | — | ✅ | GitHub API throws on error, no soft-fail |
| career.ts | ✅ | — | ✅ | Read-only, no audit |
| personal.ts | ✅ | — | ✅ | Local I/O, no HTTP |
| project-workflow.ts | ✅ | — | ✅ | Local exec, no HTTP |

---

## Rule 7: Realistic Mock Response Shapes

**The bug this catches:** Composio wraps responses in nested objects
(`result.data.response_data.id`, `result.data.display_url`). If your mock uses a
flat `{ id: "123" }`, you're testing a response shape that never actually happens.

**The rule:** Mock responses must match the actual API response structure.

```typescript
// ❌ WRONG — simplified mock that doesn't match real Composio response
mockExecuteComposioAction.mockResolvedValue({ id: "event_123" });

// ✅ RIGHT — matches actual GOOGLECALENDAR_CREATE_EVENT response shape
mockExecuteComposioAction.mockResolvedValue({
  data: {
    display_url: "https://www.google.com/calendar/event?eid=abc",
    response_data: {
      id: "event_abc123",
      htmlLink: "https://www.google.com/calendar/event?eid=abc",
      summary: "Test event",
    },
  },
});
```

**How to find the real response shape:** Run the probe script
(`scripts/probe-{tool}.ts`) once with verbose logging and note the full
`result` structure. Put that exact shape into a helper like `successResult("id")`.

---

## Rule 8: One Assertion Per Test Behaviour

**The rule:** Each test description names exactly one behaviour. If you're tempted to
use "and" in the test name, split it.

```typescript
// ❌ WRONG — two behaviours, one test
it("publishes a post and writes audit entry on success", ...);

// ✅ RIGHT — two tests, one behaviour each
it("returns success: true with post_id when LinkedIn accepts the post", ...);
it("writes audit entry only after confirming the post id exists", ...);
```

---

## Standard Test File Template

Copy this for any new Composio-backed tool:

```typescript
/**
 * Unit tests for myTool (COMPOSIO_ACTION_NAME via Composio).
 *
 * Coverage: happy path, soft failure (200 + message, no id),
 * thrown error, idempotency skip, missing API key, correct field names.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecuteComposioAction = vi.fn();
const mockGetComposioApiKey = vi.fn(() => "test-key");

vi.mock("../../../src/infra/composio.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    executeComposioAction: mockExecuteComposioAction,
    getComposioApiKey: mockGetComposioApiKey,
    getMyConnectionId: () => "ca_test",
    getMyUserId: () => "user_test",
  };
});

const mockHasBeenAudited = vi.fn(async () => false);
const mockWriteAuditEntry = vi.fn(async () => undefined);

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, hasBeenAudited: mockHasBeenAudited, writeAuditEntry: mockWriteAuditEntry };
});

const { myTool } = await import("../../../src/tools/my-tool.js");

const BASE_ARGS = { /* minimum valid args */ };

function successResult(id = "id_123") {
  // Match the ACTUAL Composio response shape from probe script
  return { data: { id } };
}

describe("myTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetComposioApiKey.mockReturnValue("test-key");
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue(undefined);
  });

  it("returns success: true with id when action succeeds", async () => { ... });
  it("calls Composio with correct action name and field names", async () => { ... });
  it("returns success: false when Composio returns 200 + message with no id", async () => { ... });
  it("does NOT write audit entry on soft failure", async () => { ... });
  it("returns success: true (skipped) when already audited", async () => { ... });
  it("returns success: false when COMPOSIO_API_KEY is missing", async () => { ... });
  it("returns success: false when Composio throws", async () => { ... });
});
```

---

## What Makes a Test Suite Complete

A tool test suite is complete when you can answer YES to all of these:

- [ ] Does the test verify the EXACT action name sent to Composio?
- [ ] Does the test verify at least one critical field name (the one most likely to be wrong)?
- [ ] Is there a test where the API returns 200 + error message and the tool returns `success: false`?
- [ ] Is there a test proving the audit entry is NOT written on soft failure?
- [ ] Is `vi.clearAllMocks()` called in `beforeEach`?
- [ ] Do the mock response shapes match the real Composio response structure?
- [ ] Are there separate tests for: happy path, soft failure, thrown error?

If any answer is NO, the test suite has a coverage gap.

---

## Rule 9: LangChain ChatResult Shape (HITL-path critical)

**The bug this catches:** `syntheticResponseFromLastTool` returned `generations: [[{...}]]`
(double-nested). `_generateUncached` iterates `result.generations` and accesses
`generation.message.id`. When double-nested, `generation` is an array → `.message` is
`undefined` → crash.

**Root type:** `ChatResult.generations` is `ChatGeneration[]` — always single-nested.

**The rule:** Any function that builds a synthetic `ChatResult` MUST return:

```typescript
return {
  generations: [
    {
      text: "content",
      message: new AIMessage({ content: "content" }),
      generationInfo: { model: "synthetic-fallback", provider: "founderos" } as Record<string, unknown>,
    },
  ],
  llmOutput: { provider: "founderos-synthetic" },
};
```

**Tests:** Always assert `result.generations[0].text`, NEVER `result.generations[0][0].text`.
A mock that returns `generations: [[{...}]]` will make the test pass while the production
path crashes.

---

## Rule 10: Zod .optional() Must Always Include .nullable()

**The bug class:** LangChain SDK emits a deprecation warning for `.optional()` without
`.nullable()` on tool schema fields. This WILL become a hard error in a future SDK version.

**The rule:** Every optional Zod field in any tool schema MUST be:

```typescript
// ✅ CORRECT
z.string().optional().nullable()
z.number().optional().nullable()
z.enum(["a", "b"]).optional().nullable()

// ❌ WRONG — will break in future LangChain SDK
z.string().optional()
```

**Null coercion at call-site:** If the downstream function accepts `T | undefined` (not
`T | null | undefined`), coerce at the call-site:

```typescript
const r = await runShellSafe(command, cwd ?? undefined); // cwd is string|null|undefined → string|undefined
```

**Where to check:** Every `src/agents/agent-tools/{dept}.ts` and `src/tools/*.ts` file.
Any `tool()` call with an `.optional()` field needs `.nullable()` added.
