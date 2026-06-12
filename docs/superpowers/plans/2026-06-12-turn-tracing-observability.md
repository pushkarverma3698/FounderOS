# Turn-Tracing Observability + Test Streamlining — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Telegram turn a correlation id and a structured, ordered trace of the seams it crosses, then use that trace as the oracle for a new seam-level test tier and a deterministic merge gate.

**Architecture:** A per-turn `TurnTrace` (correlation id + promptHash + ordered events) is created at the gateway boundary in `office-run.ts`. Gateway seam-crossings emit events directly; in-graph tool/LLM steps emit via a `TraceCallback` that mirrors the existing `BudgetGuardCallback`. The same events flow to structured logs (grep one `turnId` = whole turn) and to LangSmith (via run metadata). A test-only sink lets the new **Seam tier** assert the ordered event sequence (golden-trace snapshots). A `pnpm gate` script runs only the deterministic tiers.

**Tech Stack:** TypeScript 5.5 (NodeNext, `.js` imports), Vitest, pino (`logger.ts`), LangChain `BaseCallbackHandler`, LangGraph, node:crypto.

**Reality notes (verified 2026-06-12):**
- The run-loop is ALREADY extracted to `src/gateway/office-run.ts`; `telegram.ts` is already transport-only. So the spec's "Thread 2 extraction" is done — Thread 2 here is *instrumentation of existing seams* + *evidence-gated prune*.
- `BudgetGuardCallback` (`src/infra/budget.ts:144`) already threads into `office.invoke(..., { callbacks: [...] })`. `TraceCallback` follows the identical pattern.
- Env already has `LANGCHAIN_API_KEY`, `LANGCHAIN_PROJECT`, `LANGCHAIN_TRACING_V2` (`config.ts:41-43`) and `buildRunMetadata` (`telemetry.ts:88`) — currently NOT passed into any invoke. Wiring it is part of Task 6.
- PII helpers `scrubObject`/`scrubPii` exist in `telemetry.ts` and must be reused.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `src/infra/trace.ts` | `TurnTrace`, `startTurn`, `activePromptHash`, test sink | **Create** |
| `src/infra/trace-callback.ts` | `TraceCallback extends BaseCallbackHandler` — tool/LLM seam events | **Create** |
| `src/gateway/office-run.ts` | Emit gateway seam events; thread `TurnTrace`; pass `TraceCallback` + metadata into invoke | Modify |
| `src/infra/telemetry.ts` | `buildRunMetadata` gains optional `prompt_hash` | Modify `:88-100` |
| `.env.example` | Document LangSmith activation | Modify |
| `tests/unit/infra/trace.test.ts` | Unit: trace event shape, ordering, non-throwing, scrub | **Create** |
| `tests/unit/infra/trace-callback.test.ts` | Unit: callback emits correct seams | **Create** |
| `tests/unit/gateway/seam-trace.test.ts` | **Seam tier**: golden-trace for clean / HITL / wedge turns | **Create** |
| `package.json` | `gate` + `test:gate` scripts | Modify |
| `docs/rules/TEST-PYRAMID.md` | The four-tier pyramid + which command runs what | **Create** |
| `scripts/qa.ts` | Single dispatcher delegating to existing probe harnesses by mode | **Create** |

---

## Thread 1 — Observability spine

### Task 1: `TurnTrace` core (`src/infra/trace.ts`)

**Files:**
- Create: `src/infra/trace.ts`
- Test: `tests/unit/infra/trace.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/infra/trace.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { startTurn, activePromptHash, setTraceSink, type TraceEvent } from "../../../src/infra/trace.js";

afterEach(() => setTraceSink(null));

describe("TurnTrace", () => {
  it("assigns a turnId and records events in order with elapsed ms", () => {
    const t = startTurn({ chatId: 42, kind: "message", promptHash: "abc123" });
    expect(t.turnId).toMatch(/[0-9a-f-]{10,}/);
    t.event("turn.in", { textLen: 5 });
    t.event("turn.out", { chunks: 1 });
    expect(t.events.map((e) => e.seam)).toEqual(["turn.in", "turn.out"]);
    expect(t.events[0]!.turnId).toBe(t.turnId);
    expect(typeof t.events[0]!.ms).toBe("number");
  });

  it("scrubs PII from event data", () => {
    const t = startTurn({ chatId: 1, kind: "message", promptHash: "x" });
    t.event("tool.call", { input: "email me at jane@acme.com" });
    expect(JSON.stringify(t.events[0]!.data)).toContain("[EMAIL]");
  });

  it("never throws even if the sink throws", () => {
    setTraceSink(() => { throw new Error("sink boom"); });
    const t = startTurn({ chatId: 1, kind: "message", promptHash: "x" });
    expect(() => t.event("turn.in")).not.toThrow();
  });

  it("notifies a test sink with each event", () => {
    const seen: TraceEvent[] = [];
    setTraceSink((e) => seen.push(e));
    const t = startTurn({ chatId: 1, kind: "resume", promptHash: "x" });
    t.event("hitl.resume", { decision: "approved" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.seam).toBe("hitl.resume");
  });

  it("activePromptHash is stable and short", () => {
    expect(activePromptHash("hello")).toBe(activePromptHash("hello"));
    expect(activePromptHash("hello")).toHaveLength(12);
    expect(activePromptHash("a")).not.toBe(activePromptHash("b"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/infra/trace.test.ts`
Expected: FAIL — cannot find module `../../../src/infra/trace.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/infra/trace.ts
/**
 * FounderOS — Turn Trace
 * =======================
 * One correlation id (turnId) per inbound Telegram turn, plus an ordered list of
 * the seams that turn crosses. Every event goes to structured logs (grep the
 * turnId = the whole turn) and, in tests, to an injectable sink (the oracle for
 * the Seam test tier). Emission is fail-safe: a trace error can NEVER break a turn.
 */
import { randomUUID, createHash } from "node:crypto";
import { logger } from "./logger.js";
import { scrubObject } from "./telemetry.js";

export type Seam =
  | "turn.in"
  | "route.decided"
  | "tool.call"
  | "tool.result"
  | "tool.error"
  | "llm.call"
  | "hitl.interrupt"
  | "hitl.resume"
  | "wedge.recovered"
  | "checkpoint.trim"
  | "turn.out"
  | "turn.error";

export interface TraceEvent {
  turnId: string;
  seam: Seam;
  ms: number; // elapsed since turn start
  data?: Record<string, unknown>;
}

export interface TurnTrace {
  turnId: string;
  chatId: string;
  kind: "message" | "resume";
  promptHash: string;
  t0: number;
  events: TraceEvent[];
  event(seam: Seam, data?: Record<string, unknown>): void;
}

// Test sink — lets the Seam tier capture emitted events. Null in production.
export type TraceSink = (event: TraceEvent) => void;
let _sink: TraceSink | null = null;
export function setTraceSink(sink: TraceSink | null): void {
  _sink = sink;
}

const log = logger.child({ module: "trace" });

export function startTurn(opts: {
  chatId: string | number;
  kind: "message" | "resume";
  promptHash: string;
}): TurnTrace {
  const turnId = randomUUID();
  const t0 = Date.now();
  const chatId = String(opts.chatId);

  return {
    turnId,
    chatId,
    kind: opts.kind,
    promptHash: opts.promptHash,
    t0,
    events: [],
    event(seam, data) {
      try {
        const safe = data ? (scrubObject(data) as Record<string, unknown>) : undefined;
        const ev: TraceEvent = { turnId, seam, ms: Date.now() - t0, data: safe };
        this.events.push(ev);
        log.info({ turnId, seam, ms: ev.ms, chatId, kind: opts.kind, ...(safe ?? {}) }, `trace ${seam}`);
        _sink?.(ev);
      } catch {
        /* a trace failure must never break a turn (rule #19.5 fail-safe) */
      }
    },
  };
}

/** 12-char sha256 of the active prompt — stamped into traces to catch prompt regressions. */
export function activePromptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/infra/trace.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/infra/trace.ts tests/unit/infra/trace.test.ts
git commit -m "feat(obs): TurnTrace correlation primitive with fail-safe emission"
```

---

### Task 2: `TraceCallback` for in-graph tool/LLM seams (`src/infra/trace-callback.ts`)

**Files:**
- Create: `src/infra/trace-callback.ts`
- Test: `tests/unit/infra/trace-callback.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/infra/trace-callback.test.ts
import { describe, it, expect } from "vitest";
import { TraceCallback } from "../../../src/infra/trace-callback.js";
import { startTurn } from "../../../src/infra/trace.js";

function fakeTrace() {
  return startTurn({ chatId: 1, kind: "message", promptHash: "x" });
}

describe("TraceCallback", () => {
  it("emits tool.call on handleToolStart with the tool name", async () => {
    const t = fakeTrace();
    const cb = new TraceCallback(t);
    await cb.handleToolStart({ id: ["langchain", "tools", "search_web"] } as any, "query text");
    const ev = t.events.find((e) => e.seam === "tool.call");
    expect(ev?.data?.["tool"]).toBe("search_web");
  });

  it("emits tool.result on handleToolEnd", async () => {
    const t = fakeTrace();
    const cb = new TraceCallback(t);
    await cb.handleToolEnd("result body" as any);
    expect(t.events.some((e) => e.seam === "tool.result")).toBe(true);
  });

  it("emits tool.error on handleToolError", async () => {
    const t = fakeTrace();
    const cb = new TraceCallback(t);
    await cb.handleToolError(new Error("kaboom"));
    const ev = t.events.find((e) => e.seam === "tool.error");
    expect(ev?.data?.["error"]).toContain("kaboom");
  });

  it("emits llm.call on handleLLMStart", async () => {
    const t = fakeTrace();
    const cb = new TraceCallback(t);
    await cb.handleLLMStart({ id: ["x"] } as any, ["prompt"]);
    expect(t.events.some((e) => e.seam === "llm.call")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/infra/trace-callback.test.ts`
Expected: FAIL — cannot find module `trace-callback.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/infra/trace-callback.ts
/**
 * FounderOS — Trace Callback
 * ===========================
 * LangChain callback that turns in-graph steps (tool calls, LLM calls) into
 * TurnTrace events with real timing — the gateway can't see inside office.invoke()
 * otherwise. Mirrors BudgetGuardCallback (src/infra/budget.ts): attach to
 * office.invoke({ callbacks: [new TraceCallback(trace)] }).
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { TurnTrace } from "./trace.js";

/** Best-effort tool name from the Serialized id array LangChain passes. */
function toolName(serialized: Serialized | undefined, runName?: string): string {
  if (runName) return runName;
  const id = (serialized as { id?: string[] } | undefined)?.id;
  return id?.[id.length - 1] ?? "unknown";
}

export class TraceCallback extends BaseCallbackHandler {
  name = "TraceCallback";

  constructor(private readonly trace: TurnTrace) {
    super();
  }

  override async handleToolStart(
    tool: Serialized,
    input: string,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    this.trace.event("tool.call", { tool: toolName(tool, runName), input: String(input).slice(0, 200) });
  }

  override async handleToolEnd(output: unknown): Promise<void> {
    this.trace.event("tool.result", { preview: String(output).slice(0, 200) });
  }

  override async handleToolError(err: unknown): Promise<void> {
    this.trace.event("tool.error", { error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) });
  }

  override async handleLLMStart(llm: Serialized, _prompts: string[]): Promise<void> {
    this.trace.event("llm.call", { model: toolName(llm) });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/infra/trace-callback.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/infra/trace-callback.ts tests/unit/infra/trace-callback.test.ts
git commit -m "feat(obs): TraceCallback emits tool/LLM seam events with real timing"
```

---

### Task 3: `buildRunMetadata` carries `prompt_hash`

**Files:**
- Modify: `src/infra/telemetry.ts:88-100`
- Test: `tests/unit/infra/telemetry-metadata.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/infra/telemetry-metadata.test.ts
import { describe, it, expect } from "vitest";
import { buildRunMetadata } from "../../../src/infra/telemetry.js";

describe("buildRunMetadata", () => {
  it("includes prompt_hash when provided", () => {
    const m = buildRunMetadata({ tenant_id: "turicks", trace_id: "t1", prompt_hash: "deadbeef0000" });
    expect(m["prompt_hash"]).toBe("deadbeef0000");
    expect(m["trace_id"]).toBe("t1");
  });

  it("omits prompt_hash gracefully when absent", () => {
    const m = buildRunMetadata({ tenant_id: "turicks", trace_id: "t1" });
    expect(m["prompt_hash"]).toBe("none");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/infra/telemetry-metadata.test.ts`
Expected: FAIL — `prompt_hash` is `undefined` (not in returned object).

- [ ] **Step 3: Edit the implementation**

In `src/infra/telemetry.ts`, replace the `buildRunMetadata` function (lines 88-100) with:

```typescript
/** Standard metadata attached to every LangGraph run. */
export function buildRunMetadata(opts: {
  tenant_id: string;
  trace_id: string;
  agent?: string;
  prompt_hash?: string;
}): Record<string, string> {
  return {
    tenant_id: opts.tenant_id,
    trace_id: opts.trace_id,
    agent: opts.agent ?? "unknown",
    prompt_hash: opts.prompt_hash ?? "none",
    app_version: process.env["npm_package_version"] ?? "dev",
    node_env: env.NODE_ENV,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/infra/telemetry-metadata.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/infra/telemetry.ts tests/unit/infra/telemetry-metadata.test.ts
git commit -m "feat(obs): stamp prompt_hash into LangSmith run metadata"
```

---

### Task 4: Instrument `runOfficeText` seams

**Files:**
- Modify: `src/gateway/office-run.ts` (imports; inside `runOfficeText` `:322-439`)

No new test in this task — Task 7 (Seam tier) is the test that proves this wiring. This task is pure wiring of already-tested primitives. Run the full suite after to prove no regression.

- [ ] **Step 1: Add imports**

At the top of `src/gateway/office-run.ts`, after the existing imports, add:

```typescript
import { startTurn, activePromptHash, type TurnTrace } from "../infra/trace.js";
import { TraceCallback } from "../infra/trace-callback.js";
import { buildRunMetadata } from "../infra/telemetry.js";
import { SUPERVISOR_PROMPT } from "../agents/system-prompts.js";
```

> Verify the export name first: `grep -n "export const SUPERVISOR_PROMPT" src/agents/system-prompts.ts`. If it is exported under a different name, use that name.

- [ ] **Step 2: Create the trace at the top of `runOfficeText`**

In `runOfficeText`, immediately after `const config = officeConfig(chatId);` (line ~324), add:

```typescript
  const trace = startTurn({ chatId, kind: "message", promptHash: activePromptHash(SUPERVISOR_PROMPT) });
  trace.event("turn.in", { textLen: text.length });
```

- [ ] **Step 3: Emit seam events at the existing guard points**

Inside the `try` block of `runOfficeText`:

- After `if (stale) {` (line ~337), add as the first line inside the block:
  ```typescript
      trace.event("hitl.interrupt", { cancelledStale: true, title: stale.title });
  ```
- After `if (await recoverWedgedThread(...)) {` (line ~351), add as the first line inside the block:
  ```typescript
      trace.event("wedge.recovered", {});
  ```
- Add a routing marker just after `const invokeMessages: BaseMessage[] = buildOfficeInput(text);` (line ~375):
  ```typescript
    trace.event("route.decided", { hint: (invokeMessages[0]?.content ?? "").toString().slice(0, 60) });
  ```

- [ ] **Step 4: Add `TraceCallback` + metadata to the invoke**

Replace the `office.invoke` call (lines ~380-383) with:

```typescript
    const res = (await office.invoke(
      { messages: invokeMessages },
      {
        ...config,
        callbacks: [new BudgetGuardCallback(budget, agentModel), new TraceCallback(trace)],
        metadata: buildRunMetadata({ tenant_id: TENANT, trace_id: trace.turnId, prompt_hash: trace.promptHash }),
      },
    )) as { messages?: OfficeMessage[] };
```

- [ ] **Step 5: Emit the terminal seams**

- After `if (approval) {` (line ~389), add as the first line inside the block:
  ```typescript
      trace.event("hitl.interrupt", { title: approval.title });
  ```
- Just before the `if (freshMessages.length > 0) {` block (line ~400), after `await sendResult(...)`, add:
  ```typescript
    trace.event("turn.out", { toolErrors: collectToolErrors(freshRes).length });
  ```
- Inside the `catch (err)` block, as the very first line after `stopTyping();` (line ~409), add:
  ```typescript
    trace.event("turn.error", { kind: err instanceof Error ? err.name : "unknown" });
  ```

- [ ] **Step 6: Run the full gateway suite to prove no regression**

Run: `pnpm vitest run tests/unit/gateway/`
Expected: PASS — all existing gateway tests still green (wiring added no behaviour change).

- [ ] **Step 7: Typecheck**

Run: `pnpm lint` (or `pnpm tsc --noEmit`)
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/gateway/office-run.ts
git commit -m "feat(obs): trace runOfficeText seams + thread TraceCallback/metadata"
```

---

### Task 5: Instrument `resumeOffice` seams

**Files:**
- Modify: `src/gateway/office-run.ts` (inside `resumeOffice` `:454-539`)

- [ ] **Step 1: Create the trace at the top of `resumeOffice`**

After `const config = officeConfig(chatId);` (line ~456), add:

```typescript
  const trace = startTurn({ chatId, kind: "resume", promptHash: activePromptHash(SUPERVISOR_PROMPT) });
  trace.event("hitl.resume", { decision });
```

- [ ] **Step 2: Emit the rejection terminal seam**

Inside `if (decision === "rejected") {` (line ~475), after `await clearThreadCheckpoints(...)`, add:

```typescript
      trace.event("turn.out", { rejected: true });
```

- [ ] **Step 3: Add `TraceCallback` + metadata to the resume invoke**

Replace the `office.invoke(new Command({ resume: decision }), ...)` call (lines ~503-506) with:

```typescript
    const res = (await office.invoke(
      new Command({ resume: decision }),
      {
        ...config,
        callbacks: [new BudgetGuardCallback(budget, agentModel), new TraceCallback(trace)],
        metadata: buildRunMetadata({ tenant_id: TENANT, trace_id: trace.turnId, prompt_hash: trace.promptHash }),
      },
    )) as { messages?: OfficeMessage[] };
```

- [ ] **Step 4: Emit the re-pause and success terminal seams**

- Inside `if (next) {` (line ~510), add as the first line:
  ```typescript
      trace.event("hitl.interrupt", { title: next.title, rePaused: true });
  ```
- After `await sendResult(ctx, freshRes, chatId);` (line ~516), add:
  ```typescript
    trace.event("turn.out", { resumed: true });
  ```

- [ ] **Step 5: Run gateway suite + typecheck**

Run: `pnpm vitest run tests/unit/gateway/`
Expected: PASS.
Run: `pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/gateway/office-run.ts
git commit -m "feat(obs): trace resumeOffice (approve/reject/re-pause) seams"
```

---

### Task 6: Activate LangSmith (env + docs)

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Document activation in `.env.example`**

Find the LangSmith lines in `.env.example` (search `LANGCHAIN`) and ensure this block is present and commented with instructions:

```bash
# ── Observability (LangSmith) ───────────────────────────────────────────────
# Set both to enable step-level tracing of every office run.
# Leave LANGCHAIN_API_KEY blank to keep tracing OFF (graceful no-op).
LANGCHAIN_TRACING_V2=false
LANGCHAIN_API_KEY=
LANGCHAIN_PROJECT=founderos
```

- [ ] **Step 2: Verify live (manual, requires a real key)**

This is a VERIFICATION step, not code. With a real `LANGCHAIN_API_KEY` set and `LANGCHAIN_TRACING_V2=true`, restart the bot and send one Telegram message. Then:

```bash
# Confirm the correlated trace appears in logs with ONE turnId across all seams:
grep '"module":"trace"' /tmp/founderos.log | tail -20
# Pick the turnId from turn.in and confirm the full turn:
grep '<turnId-from-above>' /tmp/founderos.log
```

Expected: an ordered run `turn.in → route.decided → llm.call/tool.call/tool.result → turn.out`, all sharing one `turnId`. In LangSmith, the run shows `prompt_hash` + `trace_id` (= turnId) in metadata.

If no key is available in this environment, record: **"NOT VERIFIED — no LANGCHAIN_API_KEY"** and proceed (the log-correlation half is still verifiable without a key).

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(obs): document LangSmith activation env"
```

---

## Thread 2 — Seam consolidation + evidence-gated prune

### Task 7: Seam-tier golden-trace tests (`tests/unit/gateway/seam-trace.test.ts`)

This is the missing tier — it asserts the *ordered sequence of seams* for a turn using a fake office, with `setTraceSink` as the oracle. It is the test that would have caught the wedge-loop / reject-loop / stale-reply bugs.

**Files:**
- Create: `tests/unit/gateway/seam-trace.test.ts`

- [ ] **Step 1: Inspect how an existing gateway test fakes the office**

Run: `sed -n '1,60p' tests/unit/gateway/reject-no-redraft.test.ts`
Goal: copy its mocking strategy for `../agents/office.js` (`getOffice`, `getPendingApproval`) and the grammy `ctx`. Reuse that exact pattern below so the fake matches the real module surface.

- [ ] **Step 2: Write the seam-trace test**

```typescript
// tests/unit/gateway/seam-trace.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setTraceSink, type TraceEvent } from "../../../src/infra/trace.js";

// Capture every emitted trace event as the oracle.
let events: TraceEvent[];
const seams = () => events.map((e) => e.seam);

// --- Fake office state machine (canned message trails) ---
const aiMsg = (text: string) => ({ content: text, _getType: () => "ai", tool_calls: [] });

let pendingApproval: { title: string; summary: string; action: string } | null = null;
let stateMessages: unknown[] = [];

const fakeOffice = {
  getState: vi.fn(async () => ({ values: { messages: stateMessages }, next: [] })),
  invoke: vi.fn(async () => ({ messages: [...stateMessages, aiMsg("done")] })),
  updateState: vi.fn(async () => {}),
};

vi.mock("../../../src/agents/office.js", () => ({
  getOffice: async () => fakeOffice,
  getPendingApproval: async () => pendingApproval,
}));

// grammy ctx stub — records nothing we assert; replies are no-ops.
const fakeCtx = () =>
  ({
    chat: { id: 99 },
    from: { id: 99 },
    message: { text: "hello" },
    reply: vi.fn(async () => {}),
    replyWithChatAction: vi.fn(async () => {}),
  }) as any;

let runOfficeText: typeof import("../../../src/gateway/office-run.js")["runOfficeText"];

beforeEach(async () => {
  events = [];
  pendingApproval = null;
  stateMessages = [];
  setTraceSink((e) => events.push(e));
  ({ runOfficeText } = await import("../../../src/gateway/office-run.js"));
});
afterEach(() => {
  setTraceSink(null);
  vi.clearAllMocks();
});

describe("seam trace — golden sequences", () => {
  it("clean turn: turn.in → route.decided → turn.out (no HITL, no wedge)", async () => {
    await runOfficeText(fakeCtx(), "hello");
    expect(seams()).toContain("turn.in");
    expect(seams()).toContain("route.decided");
    expect(seams()).toContain("turn.out");
    expect(seams()).not.toContain("wedge.recovered");
    expect(seams()).not.toContain("turn.error");
    // ordering: turn.in is first, turn.out is last
    expect(seams()[0]).toBe("turn.in");
    expect(seams().at(-1)).toBe("turn.out");
  });

  it("HITL turn: a pending approval after invoke emits hitl.interrupt and NO turn.out", async () => {
    // office.invoke leaves a pending approval
    fakeOffice.invoke.mockImplementationOnce(async () => {
      pendingApproval = { title: "Send email?", summary: "to jane", action: "email_send" };
      return { messages: stateMessages };
    });
    await runOfficeText(fakeCtx(), "email jane");
    expect(seams()).toContain("hitl.interrupt");
    expect(seams()).not.toContain("turn.out"); // paused — turn isn't complete
  });
});
```

- [ ] **Step 3: Run the seam test**

Run: `pnpm vitest run tests/unit/gateway/seam-trace.test.ts`
Expected: PASS (2 tests). If the mock surface mismatches the real `office.js` exports, fix the mock to match (Step 1 pattern) — NOT the production code.

- [ ] **Step 4: Prove the tier catches a regression (negative control)**

Temporarily comment out the `trace.event("wedge.recovered", {})` line you added in Task 4, then add this test and confirm a wedge turn now fails to record the seam — proving the tier has teeth. Restore the line and the assertion after.

Append:

```typescript
  it("wedge turn: a wedged thread emits wedge.recovered before route.decided", async () => {
    // First getState reports a wedged thread (pending node, no interrupt).
    fakeOffice.getState
      .mockImplementationOnce(async () => ({ values: { messages: [] }, next: ["tools"] }));
    await runOfficeText(fakeCtx(), "do a thing");
    const order = seams();
    expect(order).toContain("wedge.recovered");
    expect(order.indexOf("wedge.recovered")).toBeLessThan(order.indexOf("route.decided"));
  });
```

> Note: `isWedgedState` (`src/infra/wedge.ts`) decides what counts as wedged. Read it (`sed -n '1,60p' src/infra/wedge.ts`) and shape the mocked `getState` return so `isWedgedState` returns true (non-empty `next`, zero interrupts). Adjust the mock to satisfy the real predicate.

- [ ] **Step 5: Run + commit**

Run: `pnpm vitest run tests/unit/gateway/seam-trace.test.ts`
Expected: PASS (3 tests).

```bash
git add tests/unit/gateway/seam-trace.test.ts
git commit -m "test(seam): golden-trace tier for clean/HITL/wedge turns"
```

---

### Task 8: Evidence-gated dead-infra prune (optional, gated)

**Files:**
- Modify: depends on evidence. Candidate: `src/infra/redis.ts` (MEMORY.md marks it SaaS-phase, no boot dep).

- [ ] **Step 1: Gather evidence — is it referenced anywhere live?**

Run:
```bash
grep -rn "from \"../infra/redis.js\"\|from \"./redis.js\"\|infra/redis" src/ --include=*.ts | grep -v "redis.ts"
```

- [ ] **Step 2: Decide based on evidence (do NOT delete speculatively)**

- If the grep returns **zero** non-test references → it is genuinely dead. Proceed to Step 3.
- If it returns **any** reference (scheduler, queue, boot) → STOP. Leave it. Record in the plan notes that redis is still referenced; pruning is out of scope. This task is complete with no deletion.

- [ ] **Step 3 (only if dead): Remove and verify**

```bash
git rm src/infra/redis.ts tests/unit/infra/redis.test.ts 2>/dev/null || git rm src/infra/redis.ts
pnpm lint && pnpm vitest run
```
Expected: tsc clean + full suite green (nothing imported it).

- [ ] **Step 4: Commit (only if a deletion happened)**

```bash
git commit -am "chore(prune): remove dead redis infra (evidence: zero live refs)"
```

---

## Thread 3 — Test streamlining

### Task 9: `pnpm gate` — deterministic merge gate

**Files:**
- Modify: `package.json` (scripts)

- [ ] **Step 1: Inspect current test scripts**

Run: `grep -n '"test"\|"lint"\|"eval"\|vitest' package.json`
Goal: learn the exact runner invocation (e.g. `vitest run`) so the gate script matches.

- [ ] **Step 2: Add gate scripts**

In `package.json` `"scripts"`, add (adjust `vitest run` to match Step 1):

```json
    "gate": "pnpm lint && pnpm vitest run --exclude '**/*.integration.test.ts'",
    "test:seam": "vitest run tests/unit/gateway/seam-trace.test.ts"
```

> `gate` = the deterministic tiers (Unit + Seam + Contract), tsc included. It explicitly EXCLUDES integration/live tests (LLM-dependent, non-deterministic per MEMORY.md). If your integration tests use a different suffix than `.integration.test.ts`, set the `--exclude` glob to match them (find with `ls tests/integration 2>/dev/null` or `grep -rl "office.invoke\|live" tests/`).

- [ ] **Step 3: Verify the gate is deterministic across 3 runs**

Run:
```bash
pnpm gate && pnpm gate && pnpm gate
```
Expected: PASS all three times, identical result. If a test flakes, it is LLM/network-dependent and must be moved out of the gate (rename to `*.integration.test.ts` or add to the exclude glob) — the gate stays 100% deterministic.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build(gate): deterministic pnpm gate (Unit+Seam+Contract, no LLM)"
```

---

### Task 10: Document the pyramid + unify probe entrypoint

**Files:**
- Create: `docs/rules/TEST-PYRAMID.md`
- Create: `scripts/qa.ts`

- [ ] **Step 1: Write the pyramid doc**

```markdown
# Test Pyramid (FounderOS)

Four tiers, each owning a named risk. The trace layer (`src/infra/trace.ts`) is the
oracle for the Seam tier.

| Tier | Owns | Where | Command | Gate |
|---|---|---|---|---|
| Unit | pure logic (guards, slicing, parsing, routing keywords) | `tests/unit/**` (non-gateway) | `pnpm vitest run` | must-pass |
| Seam | run-loop ordered trace events (fake office) | `tests/unit/gateway/seam-trace.test.ts` | `pnpm test:seam` | must-pass |
| Contract | each tool's exact action + fields + soft-fail + no-audit-on-fail | `tests/unit/tools/**` | `pnpm vitest run` | must-pass |
| Real-path | live MTProto over the real gateway | `scripts/*` via `scripts/qa.ts` | `pnpm tsx scripts/qa.ts <mode>` | advisory/manual |

**Merge gate:** `pnpm gate` runs Unit + Seam + Contract (deterministic). The eval and
any LLM/network test is ADVISORY — it never blocks merge (non-deterministic at temp 0,
per MEMORY.md). Run real-path QA before shipping behaviour changes (CLAUDE.md rule #19).

**Why the Seam tier exists:** every production P0 (wedge-loop, reject-loop, stale-reply,
duplicate-instance) passed Unit+Contract but crossed a gateway seam no test asserted.
The Seam tier asserts the ordered seams of a turn, so those regressions surface as a
trace diff before merge.
```

- [ ] **Step 2: Write the single QA dispatcher**

> First list the real harness entrypoints: `ls scripts/*.ts | grep -E "qa|telegram|probe"`.
> Map each `<mode>` below to the matching existing script's exported main, or shell out to it with `tsx`. Do NOT rewrite the harnesses — delegate.

```typescript
// scripts/qa.ts
/**
 * Single QA entrypoint. Delegates to the existing real-path harnesses by mode so
 * there is one command to remember instead of three overlapping scripts.
 *
 *   pnpm tsx scripts/qa.ts suite     → full founder-simulation (e2e-telegram-qa.ts)
 *   pnpm tsx scripts/qa.ts send <t>  → single send/approve (telegram-tester.ts)
 *   pnpm tsx scripts/qa.ts probe <t> → office-level probe (probe-real-task.ts)
 */
import { spawnSync } from "node:child_process";

const [, , mode, ...rest] = process.argv;

const map: Record<string, string> = {
  suite: "scripts/e2e-telegram-qa.ts",
  send: "scripts/telegram-tester.ts",
  probe: "scripts/probe-real-task.ts",
};

const target = map[mode ?? ""];
if (!target) {
  console.error(`Usage: tsx scripts/qa.ts <suite|send|probe> [args]\nGot: ${mode ?? "(none)"}`);
  process.exit(1);
}

const r = spawnSync("npx", ["tsx", target, ...rest], { stdio: "inherit" });
process.exit(r.status ?? 1);
```

- [ ] **Step 3: Verify the dispatcher resolves (no live calls)**

Run: `pnpm tsx scripts/qa.ts`
Expected: prints usage + exits non-zero (proves it loads and the mode guard works). Do NOT run `suite`/`send` here — those need the founder MTProto login.

- [ ] **Step 4: Commit**

```bash
git add docs/rules/TEST-PYRAMID.md scripts/qa.ts
git commit -m "docs(test): test pyramid + unified scripts/qa.ts dispatcher"
```

---

## Final verification (definition of done — rule #19 + Verification-First)

- [ ] **Full suite green:** `pnpm vitest run` → all pass.
- [ ] **Typecheck clean:** `pnpm lint` → clean.
- [ ] **Gate deterministic:** `pnpm gate` x3 → identical PASS.
- [ ] **Log correlation works:** restart bot, send one real Telegram message, `grep <turnId> /tmp/founderos.log` → ordered `turn.in → route.decided → … → turn.out`, one turnId. (If no live env: record "NOT VERIFIED — reason".)
- [ ] **Seam tier has teeth:** the Task 7 Step 4 negative control failed before the seam line was restored.
- [ ] **Update MEMORY.md:** one-line index entry + topic file for the tracing system.
- [ ] **Open PR** `obs/turn-tracing` → main; human merges.

---

## Self-Review (filled at write time)

**Spec coverage:**
- Thread 1 (trace.ts + LangSmith + promptHash) → Tasks 1,2,3,4,5,6 ✅
- Thread 2 (seam refactor) → already extracted; instrumentation in Tasks 4,5; prune in Task 8 ✅
- Thread 3 (pyramid + seam tier + gate + probe consolidation) → Tasks 7,9,10 ✅
- Golden-trace snapshots → Task 7 ✅
- Deterministic gate vs flaky lane → Task 9 ✅
- Consolidate 3 probes → Task 10 (delegating dispatcher, preserves working harnesses) ✅
- Non-goals respected: no trace UI, no turn_trace Postgres table, no node tests, no graph rewrite ✅

**Type consistency:** `startTurn`/`TurnTrace`/`TraceEvent`/`Seam`/`setTraceSink`/`activePromptHash`/`TraceCallback`/`buildRunMetadata({prompt_hash})` are named identically across Tasks 1-7. ✅

**Placeholder scan:** No TBD/TODO; every code step shows real code; verification steps that depend on a live key are explicitly marked "record NOT VERIFIED" rather than left vague. ✅
