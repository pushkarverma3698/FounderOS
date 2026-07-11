# Turn Progress Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show step-level progress on a single edited Telegram message while a kernel turn runs, instead of silence until the final reply.

**Architecture:** Swap `kernel.invoke()` for `kernel.stream()` (streamMode "values" — full state per node) at the two gateway call sites in `src/gateway/kernel-run.ts`. A pure function reads `mission.cursor`/`mission.status` off each yielded state to produce a progress label; a placeholder message is sent once and edited each time the label changes, then deleted before the final reply/approval-card/error.

**Tech Stack:** TypeScript, LangGraph JS (`CompiledStateGraph.stream`), grammy (Telegram), Vitest.

---

## Task 1: Add the `turn.progress` trace seam

**Files:**
- Modify: `src/infra/trace.ts:13-34` (the `Seam` union type)

- [ ] **Step 1: Add the literal**

In `src/infra/trace.ts`, the `Seam` union currently ends:
```typescript
  | "turn.out"
  | "turn.error";
```
Change to:
```typescript
  | "turn.out"
  | "turn.error"
  | "turn.progress";
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (this is an additive union member; nothing consumes it yet).

- [ ] **Step 3: Commit**

```bash
git add src/infra/trace.ts
git commit -m "feat(trace): add turn.progress seam for step-level progress events"
```

---

## Task 2: `progressLabelFor` — pure function, TDD

**Files:**
- Modify: `src/gateway/kernel-run.ts` (add the function; exact insertion point in Task 4)
- Test: `tests/unit/gateway/kernel-run.test.ts` (new `describe` block)

This function is pure (no I/O), so it gets its own test block ahead of the streaming wiring. It will live in `kernel-run.ts` alongside the code that calls it (Task 4) — write the test now, but the function itself is implemented in Task 4 Step 3 so the file only changes once. For this task, add ONLY the test block; it will fail with "progressLabelFor is not a function" until Task 4.

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `tests/unit/gateway/kernel-run.test.ts`, right after the existing imports (after line 31, before `interface Reply`):

```typescript
import { progressLabelFor } from "../../../src/gateway/kernel-run.js";
import type { KernelStateType } from "../../../src/kernel/index.js";

function baseState(overrides: Partial<KernelStateType["mission"]>): KernelStateType {
  return {
    turn: { id: "t1", chat_id: "1", received_at: "", raw_input: "" },
    mission: { goal: "g", status: "planning", plan: null, cursor: 0, ...overrides },
    results: [],
    attempts: {},
    failure: null,
    scratch: [],
    step_receipts: [],
    reply: "",
    last_turn: null,
    history: [],
  } as unknown as KernelStateType;
}

const PLAN = {
  schema_version: 1,
  goal: "g",
  steps: [
    {
      step_id: "s1",
      worker: "research",
      objective: "Find the founder's five most recent LinkedIn posts and summarize engagement",
      inputs: {},
      expected: { kind: "data", schema_ref: "research.findings" },
      constraints: { max_tool_calls: 3, hitl_required: false },
    },
  ],
} as const;

describe("progressLabelFor", () => {
  it("returns a worker + truncated-objective label while executing", () => {
    const state = baseState({ status: "executing", plan: PLAN as never, cursor: 0 });
    expect(progressLabelFor(state)).toBe(
      "🔧 research: Find the founder's five most recent LinkedIn posts and su…",
    );
  });

  it("returns the writing label while synthesizing", () => {
    const state = baseState({ status: "synthesizing", plan: PLAN as never, cursor: 1 });
    expect(progressLabelFor(state)).toBe("✍️ Writing your reply…");
  });

  it("returns null while planning (nothing worth showing yet)", () => {
    const state = baseState({ status: "planning", plan: null, cursor: 0 });
    expect(progressLabelFor(state)).toBeNull();
  });

  it("returns null when done or failed", () => {
    expect(progressLabelFor(baseState({ status: "done", plan: PLAN as never, cursor: 1 }))).toBeNull();
    expect(progressLabelFor(baseState({ status: "failed", plan: PLAN as never, cursor: 0 }))).toBeNull();
  });

  it("returns null defensively when cursor is out of range (mirrors dispatch's own bounds check)", () => {
    const state = baseState({ status: "executing", plan: PLAN as never, cursor: 5 });
    expect(progressLabelFor(state)).toBeNull();
  });

  it("returns null when executing with no plan (should not happen, but must not throw)", () => {
    const state = baseState({ status: "executing", plan: null, cursor: 0 });
    expect(progressLabelFor(state)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/gateway/kernel-run.test.ts -t progressLabelFor`
Expected: FAIL — `progressLabelFor` is not exported from `kernel-run.ts` (module has no such export).

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/unit/gateway/kernel-run.test.ts
git commit -m "test(gateway): add failing tests for progressLabelFor"
```

---

## Task 3: Update `kernel-run.test.ts`'s existing mocks to `stream`

**Files:**
- Modify: `tests/unit/gateway/kernel-run.test.ts:9-15, 41-54`

The existing `fakeKernel` mocks `.invoke`. Once Task 4 swaps `kernel.invoke` for `kernel.stream`, every existing test needs `fakeKernel.stream` instead. This task converts the fake and the Telegram `ctx` mock BEFORE touching `kernel-run.ts`, so Task 4's implementation has a stable test target (tests will fail for the right reason — missing implementation, not missing mocks).

- [ ] **Step 1: Replace the fakeKernel mock**

Replace lines 9–15:
```typescript
const fakeKernel = {
  invoke: vi.fn(async () => ({ reply: "All done.", mission: { status: "done" } })),
  getState: vi.fn(async () => ({ tasks: [] })),
};
vi.mock("../../../src/gateway/kernel-boot.js", () => ({
  getKernel: vi.fn(async () => fakeKernel),
}));
```
with:
```typescript
const DONE_STATE = { reply: "All done.", mission: { status: "done", plan: null, cursor: 0, goal: "" } };

async function* singleYield(state: unknown) {
  yield state;
}

const fakeKernel = {
  stream: vi.fn((..._args: unknown[]) => singleYield(DONE_STATE)),
  getState: vi.fn(async () => ({ tasks: [] })),
};
vi.mock("../../../src/gateway/kernel-boot.js", () => ({
  getKernel: vi.fn(async () => fakeKernel),
}));
```

- [ ] **Step 2: Update the `beforeEach` reset**

Replace (around line 51):
```typescript
  fakeKernel.invoke.mockResolvedValue({ reply: "All done.", mission: { status: "done" } } as never);
```
with:
```typescript
  fakeKernel.stream.mockImplementation(() => singleYield(DONE_STATE));
```

- [ ] **Step 3: Extend `fakeCtx` with `ctx.api` for edit/delete and a `message_id` on `reply`**

Replace the `fakeCtx` function:
```typescript
function fakeCtx(): { ctx: Context; replies: Reply[] } {
  const replies: Reply[] = [];
  const ctx = {
    chat: { id: 777 },
    reply: vi.fn(async (text: string, opts?: Reply["opts"]) => {
      replies.push({ text, ...(opts !== undefined ? { opts } : {}) });
    }),
  } as unknown as Context;
  return { ctx, replies };
}
```
with:
```typescript
function fakeCtx(): { ctx: Context; replies: Reply[]; edits: string[]; deletedIds: number[] } {
  const replies: Reply[] = [];
  const edits: string[] = [];
  const deletedIds: number[] = [];
  let nextMessageId = 1;
  const ctx = {
    chat: { id: 777 },
    reply: vi.fn(async (text: string, opts?: Reply["opts"]) => {
      replies.push({ text, ...(opts !== undefined ? { opts } : {}) });
      return { message_id: nextMessageId++ };
    }),
    api: {
      editMessageText: vi.fn(async (_chatId: number, _messageId: number, text: string) => {
        edits.push(text);
      }),
      deleteMessage: vi.fn(async (_chatId: number, messageId: number) => {
        deletedIds.push(messageId);
      }),
    },
  } as unknown as Context;
  return { ctx, replies, edits, deletedIds };
}
```

- [ ] **Step 4: Update every `fakeKernel.invoke.mock.calls` reference to `fakeKernel.stream.mock.calls`**

Three call sites reference `fakeKernel.invoke` for assertions:
- `expect(fakeKernel.invoke).toHaveBeenCalledTimes(1);` → `expect(fakeKernel.stream).toHaveBeenCalledTimes(1);`
- `const [input, config] = fakeKernel.invoke.mock.calls[0]!...` → `const [input, config] = fakeKernel.stream.mock.calls[0]!...`
- `const [cmd] = fakeKernel.invoke.mock.calls[0]!...` → `const [cmd] = fakeKernel.stream.mock.calls[0]!...`

- [ ] **Step 5: Update the failure-path test to reject via the generator**

Replace:
```typescript
  it("kernel invoke failure → loud ❌ error reply (never silent, never a wipe)", async () => {
    fakeKernel.invoke.mockRejectedValue(new Error("planner exploded"));
```
with:
```typescript
  it("kernel invoke failure → loud ❌ error reply (never silent, never a wipe)", async () => {
    fakeKernel.stream.mockImplementation(async function* () {
      throw new Error("planner exploded");
    });
```

- [ ] **Step 6: Update the two `getPendingKernelApproval` tests' `fakeKernel.invoke` usage**

Both approval tests call `runKernelText`/`resumeKernel` without touching `fakeKernel.invoke` directly (they rely on the `beforeEach` default and only override `getState`), so no change needed there beyond what Step 2 already did.

- [ ] **Step 7: Run the suite to confirm it now fails on the RIGHT thing**

Run: `npx vitest run tests/unit/gateway/kernel-run.test.ts`
Expected: FAIL — `kernel.stream is not a function` (or similar), because `kernel-run.ts` still calls `.invoke`. This confirms the mocks are correctly wired ahead of the implementation.

- [ ] **Step 8: Commit**

```bash
git add tests/unit/gateway/kernel-run.test.ts
git commit -m "test(gateway): convert kernel-run fakes from invoke to stream"
```

---

## Task 4: Implement streaming in `kernel-run.ts`

**Files:**
- Modify: `src/gateway/kernel-run.ts`

- [ ] **Step 1: Add imports**

At the top of `src/gateway/kernel-run.ts`, add to the existing import block (after the `TraceCallback` import, before `logger`):
```typescript
import type { KernelStateType } from "../kernel/index.js";
```

- [ ] **Step 2: Add the placeholder-lifecycle helper and `progressLabelFor`**

Insert this new section after `sendApprovalCard` (after line 95, before the `// ── One text turn ──` comment):

```typescript
// ── Progress streaming ─────────────────────────────────────────────────────

const PROGRESS_OBJECTIVE_MAX = 60;

/**
 * Step-level progress label for the CURRENT state, or null when nothing is
 * worth showing (planning/failed/done, or a malformed cursor — mirrors
 * dispatch's own bounds check rather than throwing).
 */
export function progressLabelFor(state: KernelStateType): string | null {
  const { mission } = state;
  if (mission.status === "executing") {
    const step = mission.plan?.steps[mission.cursor];
    if (!step) return null;
    const objective =
      step.objective.length > PROGRESS_OBJECTIVE_MAX
        ? `${step.objective.slice(0, PROGRESS_OBJECTIVE_MAX - 1)}…`
        : step.objective;
    return `🔧 ${step.worker}: ${objective}`;
  }
  if (mission.status === "synthesizing") return "✍️ Writing your reply…";
  return null;
}

const PROGRESS_PLACEHOLDER_TEXT = "🤔 Working on it…";

/**
 * Sends one placeholder message, edits it as progressLabelFor(state) changes
 * while streaming the kernel turn, and deletes it once the turn ends
 * (success, HITL pause, or error). Every Telegram call here is best-effort —
 * a progress ping failing must never fail the turn.
 */
async function streamKernelTurn(
  ctx: Context,
  trace: ReturnType<typeof startTurn>,
  streamIter: AsyncIterable<unknown>,
): Promise<KernelStateType> {
  let placeholderId: number | undefined;
  try {
    const placeholder = await ctx.reply(PROGRESS_PLACEHOLDER_TEXT);
    placeholderId = placeholder.message_id;
  } catch (err) {
    log.warn({ err: String(err) }, "Progress placeholder send failed"); // allow-failopen: progress ping is cosmetic; the turn must not die on a Telegram blip
  }

  let lastLabel: string | null = null;
  let lastState: KernelStateType | undefined;

  try {
    for await (const state of streamIter) {
      lastState = state as KernelStateType;
      const label = progressLabelFor(lastState);
      if (label !== null && label !== lastLabel) {
        lastLabel = label;
        trace.event("turn.progress", { label });
        if (placeholderId !== undefined && ctx.chat) {
          try {
            await ctx.api.editMessageText(ctx.chat.id, placeholderId, label);
          } catch (err) {
            log.warn({ err: String(err) }, "Progress placeholder edit failed"); // allow-failopen: progress ping is cosmetic; the turn must not die on a Telegram blip
          }
        }
      }
    }
  } finally {
    if (placeholderId !== undefined && ctx.chat) {
      try {
        await ctx.api.deleteMessage(ctx.chat.id, placeholderId);
      } catch (err) {
        log.warn({ err: String(err) }, "Progress placeholder delete failed"); // allow-failopen: progress ping is cosmetic; the turn must not die on a Telegram blip
      }
    }
  }

  if (!lastState) {
    throw new Error("kernel.stream produced no state — this should be unreachable (graph always yields at least once)");
  }
  return lastState;
}
```

- [ ] **Step 3: Wire `runKernelText` to stream**

Replace this block in `runKernelText` (currently lines 123–137):
```typescript
      const res = await withTurnTimeout(
        kernel.invoke(
          {
            turn: {
              id: trace.turnId,
              chat_id: String(chatId),
              received_at: new Date().toISOString(),
              raw_input: text,
            },
          },
          config,
        ),
        OFFICE_TURN_TIMEOUT_MS,
        "kernel.invoke",
      );
```
with:
```typescript
      const res = await withTurnTimeout(
        streamKernelTurn(
          ctx,
          trace,
          kernel.stream(
            {
              turn: {
                id: trace.turnId,
                chat_id: String(chatId),
                received_at: new Date().toISOString(),
                raw_input: text,
              },
            },
            config,
          ) as AsyncIterable<unknown>,
        ),
        OFFICE_TURN_TIMEOUT_MS,
        "kernel.invoke",
      );
```

- [ ] **Step 4: Wire `resumeKernel` to stream**

Replace this block in `resumeKernel` (currently lines 176–180):
```typescript
      const res = await withTurnTimeout(
        kernel.invoke(new Command({ resume: decision }), config),
        OFFICE_TURN_TIMEOUT_MS,
        "kernel.resume",
      );
```
with:
```typescript
      const res = await withTurnTimeout(
        streamKernelTurn(ctx, trace, kernel.stream(new Command({ resume: decision }), config) as AsyncIterable<unknown>),
        OFFICE_TURN_TIMEOUT_MS,
        "kernel.resume",
      );
```

- [ ] **Step 5: Run the full `kernel-run.test.ts` suite**

Run: `npx vitest run tests/unit/gateway/kernel-run.test.ts`
Expected: All existing tests PASS (single-yield generator behaves like `invoke` did), and all `progressLabelFor` tests from Task 2 PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If `CompiledKernel`'s `.stream()` return type doesn't structurally match `AsyncIterable<unknown>` cleanly, the `as AsyncIterable<unknown>` casts in Steps 3–4 handle it — LangGraph's stream return type is an async generator, which is always assignable to `AsyncIterable`.

- [ ] **Step 7: Commit**

```bash
git add src/gateway/kernel-run.ts
git commit -m "feat(gateway): stream kernel turns and edit a progress message in place"
```

---

## Task 5: Add multi-yield progress tests

**Files:**
- Modify: `tests/unit/gateway/kernel-run.test.ts`

- [ ] **Step 1: Write the new tests**

Add this `describe` block at the end of `tests/unit/gateway/kernel-run.test.ts`:

```typescript
describe("progress streaming", () => {
  const EXECUTING_STEP1 = {
    reply: "",
    mission: {
      status: "executing",
      cursor: 0,
      goal: "g",
      plan: {
        schema_version: 1,
        goal: "g",
        steps: [
          {
            step_id: "s1",
            worker: "research",
            objective: "Look up recent posts",
            inputs: {},
            expected: { kind: "data", schema_ref: "research.findings" },
            constraints: { max_tool_calls: 3, hitl_required: false },
          },
        ],
      },
    },
  };
  const SYNTHESIZING = {
    reply: "",
    mission: { ...EXECUTING_STEP1.mission, status: "synthesizing", cursor: 1 },
  };
  const DONE = { reply: "Here you go.", mission: { ...EXECUTING_STEP1.mission, status: "done", cursor: 1 } };

  it("edits the placeholder as the label changes, then deletes it before the final reply", async () => {
    fakeKernel.stream.mockImplementation(async function* () {
      yield EXECUTING_STEP1;
      yield SYNTHESIZING;
      yield DONE;
    });

    const { ctx, replies, edits, deletedIds } = fakeCtx();
    await runKernelText(ctx, "do the thing");

    expect(edits).toEqual(["🔧 research: Look up recent posts", "✍️ Writing your reply…"]);
    expect(deletedIds).toEqual([1]); // placeholder was message_id 1
    expect(replies.at(-1)!.text).toContain("Here you go.");
  });

  it("does not re-edit when consecutive states produce the same label", async () => {
    fakeKernel.stream.mockImplementation(async function* () {
      yield EXECUTING_STEP1;
      yield EXECUTING_STEP1; // agent/tools loop — same step, same label
      yield DONE;
    });

    const { ctx, edits } = fakeCtx();
    await runKernelText(ctx, "do the thing");

    expect(edits).toEqual(["🔧 research: Look up recent posts"]);
  });

  it("deletes the placeholder even when the stream throws", async () => {
    fakeKernel.stream.mockImplementation(async function* () {
      yield EXECUTING_STEP1;
      throw new Error("worker exploded");
    });

    const { ctx, deletedIds, replies } = fakeCtx();
    await runKernelText(ctx, "do the thing");

    expect(deletedIds).toEqual([1]);
    expect(replies.at(-1)!.text).toContain("❌");
  });

  it("still shows progress on resumeKernel for a multi-step plan continuing after approval", async () => {
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "int-1", created_at: new Date().toISOString() });
    fakeKernel.stream.mockImplementation(async function* () {
      yield SYNTHESIZING;
      yield DONE;
    });

    const { ctx, edits, deletedIds } = fakeCtx();
    await resumeKernel(ctx, "approved");

    expect(edits).toEqual(["✍️ Writing your reply…"]);
    expect(deletedIds).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `npx vitest run tests/unit/gateway/kernel-run.test.ts`
Expected: All PASS, including the 4 new tests in `describe("progress streaming")`.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/gateway/kernel-run.test.ts
git commit -m "test(gateway): cover progress-message editing, dedup, and cleanup-on-error"
```

---

## Task 6: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all files pass, including the updated `tests/unit/gateway/kernel-run.test.ts` and any file importing `kernel-run.ts` (e.g. `tests/integration/kernel-postgres-state.test.ts` — check it does not mock `.invoke` directly; if it does, apply the same `.stream` conversion as Task 3).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Architecture gate**

Run: `npx tsx scripts/verify-architecture.ts`
Expected: all gates at baseline (this change touches only `src/gateway/` and one `Seam` literal in `src/infra/trace.ts` — no kernel files, no regex routing).

- [ ] **Step 4: Commit any fixups**

If Step 1 revealed integration-test breakage, fix and commit:
```bash
git add -A
git commit -m "fix(test): align remaining invoke-mocking tests with kernel.stream"
```

---

## Task 7: Live verification (repo rule #19 — evidence over assertion)

**Files:** none (manual verification against the real Telegram bot)

This task requires prod or a reachable dev deployment with `TELEGRAM_TESTER_SESSION` configured (see `scripts/telegram-tester.ts` header). Do NOT claim this feature works without this step — unit tests prove the wiring, not the live behavior.

- [ ] **Step 1: Send a message that produces a multi-step plan**

Run: `npx tsx --env-file=.env scripts/telegram-tester.ts send "Research our top 3 competitors and draft a one-line positioning comparison" --wait 90`

Expected: the transcript shows the placeholder message text changing (e.g. `🔧 research: …` then `✍️ Writing your reply…`) before the final reply arrives. Capture the transcript output.

- [ ] **Step 2: Confirm no regression on a trivial reply (direct-reply path, no plan)**

Run: `npx tsx --env-file=.env scripts/telegram-tester.ts send "Hi" --wait 30`

Expected: bot replies normally; a placeholder may flash briefly but is cleaned up — no leftover "Working on it…" message in the chat.

- [ ] **Step 3: Record evidence in the PR description**

Paste both transcripts (or a description of the observed message edits) into the PR body per repo rule #19's "evidence over assertion."

---

## Self-Review Notes (for whoever executes this plan)

- **Spec coverage:** Task 1 = trace seam; Task 2/4 = `progressLabelFor` + placeholder lifecycle; Task 3 = test conversion (prerequisite for Task 4, not a spec requirement itself, but required by TDD process); Task 4 = both call sites (`runKernelText` + `resumeKernel`) per the "Resume coverage: Yes, both call sites" decision; Task 5 = dedup + cleanup-on-error tests per spec's testing section; Task 6 = full-suite/tsc/arch-gate per spec's testing section; Task 7 = live verification per spec's success criteria.
- **No token-level streaming, no graph changes, no new module** — matches the spec's non-goals.
- **Type consistency:** `progressLabelFor` is defined once (Task 4 Step 2) and imported once in the test file (Task 2 Step 1) — same name throughout.
