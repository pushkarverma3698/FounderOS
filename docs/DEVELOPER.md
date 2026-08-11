# FounderOS — Developer Guide

> **Start here before touching the codebase.** This document is the step-by-step
> companion to `docs/rules/PROGRAMMING-RULES.md` — it explains the *why* and shows
> concrete examples of every extension point.

> **Historical note (v2 → v3, 2026-07-08).** If you arrive here from an old branch, an
> archived doc, or an LLM that learned this repo before July: the v2 architecture — an LLM
> supervisor built with `createSupervisor`, a `buildSupervisorPrompt()` routing table, nested
> sub-supervisor "domains", a regex `pre-router.ts`, and natural-language SOPs in
> `src/workflows/` — **no longer exists**. It was audited and replaced (see `ZERO-BASE-AUDIT.md`
> and `JARVIS-ARCHITECTURE.md`); `src/workflows/` was deleted in Phase 6 with zero importers.
> Several of those modules are CI **tombstones** (`scripts/verify-architecture.ts` rule R6):
> re-creating `src/agents/office.ts`, `pre-router.ts`, or `engineering-domain.ts` fails
> `pnpm verify:arch` outright, with no ratchet and no exemption. Nothing below describes v2 —
> this paragraph is the only place it is mentioned.

## Table of Contents

1. [Architecture in 60 seconds](#architecture-in-60-seconds)
2. [Local dev setup](#local-dev-setup)
3. [Adding a Tool](#adding-a-tool)
4. [Adding a Department](#adding-a-department)
5. [Adding a step type (output contract)](#adding-a-step-type-output-contract)
6. [The workflow catalog (`saved_workflows`)](#the-workflow-catalog-saved_workflows)
7. [Adding a Telegram Command](#adding-a-telegram-command)
8. [Adding golden eval tasks](#adding-golden-eval-tasks)
9. [Verification ritual](#verification-ritual)
10. [Key invariants (never break these)](#key-invariants-never-break-these)

---

## Architecture in 60 seconds

```
Telegram message
      │
      ▼
gateway/telegram.ts          ← grammy transport
gateway/kernel-run.ts        ← run loop: lock → gates → invoke → HITL card / reply
      │
      ▼
kernel/graph.ts              ← ONE StateGraph, six nodes, no prebuilt supervisor
      │
      ├── plan         kernel/planner.ts      LLM #1 → PlannerDecision: direct reply OR typed Plan
      ├── dispatch     kernel/supervisor.ts   PURE CODE: plan[cursor] → TaskEnvelope
      ├── agent ⇄ tools  kernel/worker.ts     worker sees ONLY its envelope; capped tools; ToolReceipts
      ├── collect      kernel/graph.ts        PURE: StepResult validated against OUTPUT_CONTRACTS
      └── synthesize   kernel/synthesizer.ts  LLM #2, sees validated results only → reply + receipts
                                              (cursor++ loops back to dispatch until the plan is done)
```

Which worker carries which tools is `DEPARTMENT_TOOLS` in `src/agents/capabilities.ts`
(admin · research · comms · engineering · marketing · sales · personal · jobhunt); their
prompts are one file each under `src/agents/prompts/`.

**Three hard rules about this diagram:**

1. **Contracts are the architecture** — every boundary (`TaskEnvelope`, `Plan`, `StepResult`,
   `FailureReport`, `ToolReceipt`) is Zod-validated in `src/kernel/contracts.ts`. A mismatch is
   a terminal, typed failure — never a retry-and-hope.
2. **One composition root** — models, tools and the checkpointer are injected by
   `src/gateway/kernel-boot.ts`, and only there. That is why the whole graph runs offline in CI
   at $0 (`tests/unit/kernel/kernel-e2e.test.ts`).
3. **Context isolation** — a worker sees its envelope and nothing else: not the conversation,
   not other steps' tool calls. Do NOT widen it.

---

## Local dev setup

```bash
pnpm install
cp .env.example .env                    # fill in GOOGLE_GENERATIVE_AI_API_KEY + TELEGRAM_BOT_TOKEN
docker compose up -d postgres
npx tsx scripts/setup-db.ts             # creates tables, enables pgvector
npx tsx src/index.ts                    # bot starts

# Verify
pnpm test                               # 1098 tests must be green
pnpm lint                               # tsc must be clean
pnpm eval                               # routing golden set (needs live DB + Gemini key)
```

**Required env vars (minimum):**

| Var | What for |
|-----|---------|
| `GOOGLE_GENERATIVE_AI_API_KEY` | All LLM calls (Gemini 2.5 Flash) |
| `TELEGRAM_BOT_TOKEN` | grammy bot |
| `TELEGRAM_CHAT_ID` | Which chat to push proactive messages to |
| `DATABASE_URL` | Postgres (local: `postgresql://…@localhost:5432/founderos`) |
| `FOUNDER_TENANT` | Tenant name (e.g. `turicks`) |

---

## Adding a Tool

A tool is the atomic unit: one external capability (GitHub search, web search, calendar
create). Every tool needs **6 layers wired in order**. Missing any one → silent failure.

### Layer 1 — Tool body (`src/tools/{name}.ts`)

```typescript
// src/tools/my-tool.ts
import { z } from "zod";
import type { UnifiedTool } from "./index.js";

export const myTool: UnifiedTool = {
  name: "my_tool",
  description: "Does X given Y. Returns Z.",
  schema: z.object({
    query: z.string().describe("What to do"),
    limit: z.number().optional().nullable().describe("Max results (default 10)"),
  }),
  async execute(input) {
    const res = await callExternalApi(input.query, input.limit ?? 10);
    // ALWAYS check for soft-failure (200 + no id):
    if (!res.id) return { success: false, error: "API returned no id" };
    return { success: true, data: res.data };
  },
};
```

**Rules for the tool body:**
- Never throws. Return `{ success: false, error: "..." }` on any failure.
- Every optional field in `schema` must be `z.string().optional().nullable()` (Rule #7 in PROGRAMMING-RULES).
- Use the real action slug + field names from a live probe BEFORE writing (contract test first).

### Layer 2 — Unit test (`tests/unit/tools/{name}.test.ts`)

```typescript
// tests/unit/tools/my-tool.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { myTool } from "../../../src/tools/my-tool.js";

// Mock the external API call
vi.mock("../../../src/lib/some-client.js", () => ({
  callExternalApi: vi.fn(),
}));

import { callExternalApi } from "../../../src/lib/some-client.js";
const mockCall = vi.mocked(callExternalApi);

describe("myTool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns data on success", async () => {
    mockCall.mockResolvedValue({ id: "abc", data: "result" });
    const res = await myTool.execute({ query: "test" });
    expect(res).toEqual({ success: true, data: "result" });
  });

  it("soft-fails when API returns no id (200 + empty body pattern)", async () => {
    mockCall.mockResolvedValue({ message: "ok" }); // no id
    const res = await myTool.execute({ query: "test" });
    expect(res).toEqual({ success: false, error: expect.any(String) });
  });

  it("soft-fails on network error (never throws)", async () => {
    mockCall.mockRejectedValue(new Error("timeout"));
    const res = await myTool.execute({ query: "test" });
    expect(res.success).toBe(false);
  });
});
```

**Mandatory test cases:**
1. Happy path — returns the right shape.
2. Soft-fail — API returns HTTP 200 but no `id` (real-world API bug class).
3. Thrown error — network/timeout/5xx must not propagate (tool.execute never throws).
4. Audit NOT written on failure (if the tool has HITL and writes to `action_log`).

### Layer 3 — Agent wrapper (`src/agents/agent-tools/{dept}.ts`)

```typescript
// src/agents/agent-tools/research.ts  (add to existing file)
import { tool } from "@langchain/core/tools";
import { myTool } from "../../tools/my-tool.js";

export const myToolAgent = tool(
  async (input) => {
    const result = await myTool.execute(input);
    if (!result.success) return `Error: ${result.error}`;
    return JSON.stringify(result.data);
  },
  {
    name: myTool.name,
    description: myTool.description,
    schema: myTool.schema,
  }
);
```

**If the tool writes/sends (email, post, push, shell):**

```typescript
import { hitlGate, idempotencyKey } from "./hitl.js";
import { hasBeenAudited, writeAuditEntry } from "../../db/queries.js";

export const myToolAgent = tool(
  async (input) => {
    const ikey = idempotencyKey("my_tool", input.query);
    if (await hasBeenAudited(ikey)) return "Already done (idempotent).";

    // HITL interrupt — pauses here until founder approves
    await hitlGate({
      kind: "approval",
      action: "my_tool",
      payload: input,
      preview: `Will do X with: ${input.query}`,
    });

    const result = await myTool.execute(input);
    if (!result.success || !result.data?.id) return `Error: ${result.error}`;

    await writeAuditEntry({ action: "my_tool", idempotency_key: ikey, payload: input });
    return `Done: ${result.data.id}`;
  },
  { name: myTool.name, description: myTool.description, schema: myTool.schema }
);
```

### Layer 4 — Barrel (`src/agents/agent-tools.ts`)

```typescript
// Add to the existing export block for the dept module:
export {
  searchWebAgent,
  myToolAgent,         // ← add here
} from "./agent-tools/research.js";
```

### Layer 5 — Department (`src/agents/capabilities.ts`)

```typescript
// DEPARTMENT_TOOLS is the single source of truth for who carries what.
export const DEPARTMENT_TOOLS: Record<string, AnyTool[]> = {
  research: [searchWeb, /* … */ myToolAgent],   // ← add here
};
```

### Layer 6 — Prompts (`src/agents/system-prompts.ts`)

**6a — Tell the dept agent it has the tool (in the dept prompt):**

```typescript
// In RESEARCH_PROMPT or whichever dept owns it:
`TOOLS YOU HAVE:
- search_web: Search the web for current information
- my_tool: Does X given Y — use when the founder asks about Z`
```

**6b — Routing (usually nothing to do):**

The planner reads every worker's tool names straight from the catalog, so a tool wired at
Layer 5 is already routable. Add a rule to `buildPlannerPrompt` (`src/kernel/planner.ts`)
ONLY when the trigger phrase is genuinely ambiguous between two workers — and guard it with
a case in `tests/unit/kernel/planner-prompt.test.ts`, the way the FounderOS-self-knowledge
and draft-is-not-send rules are guarded.

### Forget → Error table

| If you forget… | You get… |
|----------------|----------|
| Layer 1 test | Soft-fail bug (wrong field names ship silently) |
| Layer 3 wrapper | Tool exists but agents can't see it — dead code |
| Layer 4 barrel | `tsc` error: `'myToolAgent' is not exported from '...'` (loud, good) |
| Layer 5 `DEPARTMENT_TOOLS` | Tool built but no worker has it — never invoked |
| Layer 6a dept prompt | Worker has the tool but never uses it — "I can't do that" (`pnpm verify:wiring` warns) |

---

## Adding a Department

A department **is** a worker. There is no agent object to construct and no supervisor to
register with: `buildWorkerSpecs()` in `src/gateway/kernel-boot.ts` assembles every worker at
boot from three tables (id, description+prompt, tools), and `src/kernel/graph.ts` runs all of
them through the same six nodes. Adding one means adding rows, not wiring a new topology.

**Rule: only add a department if it owns ≥2 tools no other department owns.** A worker whose
tools all live elsewhere adds a routing decision without adding a capability — the planner now
has two defensible answers to the same request, which is how routing becomes non-deterministic.
*(Convention only. Nothing in CI enforces this — rule #27: say which layer holds a rule.)*

### Step-by-step — 6 required, 3 optional

#### 1. Register the worker id (`src/kernel/contracts.ts`) — do this FIRST

```typescript
export const WORKERS = [
  "admin", "research", "comms", "engineering", "marketing", "sales", "personal", "jobhunt",
  "analytics",   // ← add
] as const;
```

`WorkerIdSchema = z.enum(WORKERS)` validates `TaskEnvelope.worker`, so until the id is here the
planner cannot route to the department at all: the envelope fails Zod and the step comes back as
a typed `validation` FailureReport.

Do this step first on purpose. `DESCRIPTIONS` and `PROMPTS` in `kernel-boot.ts` are typed
`Record<(typeof WORKERS)[number], …>`, so adding the id turns each remaining wiring step below
into a `tsc` error rather than a silent gap.

#### 2. Prompt file (`src/agents/prompts/analytics.ts`)

One file per department — `prompts/admin.ts` is the reference for shape.

```typescript
/**
 * Analytics department prompt — warehouse metrics and reporting.
 * Workers execute; managers route (ADR-028).
 */

export const ANALYTICS_PROMPT = `You are the Analytics department for Turicks / FounderOS.

SCOPE: Metrics queries and reporting.
You do NOT send email, post on LinkedIn, run shell, browse, or modify GitHub.

TOOLS (use the right one — do not guess):
- query_metrics → run a metrics query against the warehouse

OUTPUT: return exactly the JSON shape named by your envelope's expected.schema_ref.
`;
```

Keep an explicit "you do NOT…" line, and never claim a capability that isn't a real tool from
step 4. The capability manifest the planner reads is *generated* from the tool arrays
(`buildCapabilityManifest()`), so hand-written prose that contradicts it is exactly how the bot
came to claim it had no browser on 2026-06-09.

#### 3. Barrel export (`src/agents/system-prompts.ts`)

```typescript
export { ANALYTICS_PROMPT } from "./prompts/analytics.js";
```

#### 4. Tools (`src/agents/capabilities.ts`)

`DEPARTMENT_TOOLS` is the single source of truth for who carries what.

```typescript
export const DEPARTMENT_TOOLS: Record<string, AnyTool[]> = {
  // …
  analytics: [queryMetricsAgent],   // ← add
};
```

If any tool writes or sends, it must *also* call `hitlGate()` inside its wrapper **and** be
listed in `HITL_GATED_TOOLS` in this same file. Those are two different mechanisms — see the
warning under the Forget → Error table.

#### 5. Description + prompt binding (`src/gateway/kernel-boot.ts`)

```typescript
const DESCRIPTIONS: Record<(typeof WORKERS)[number], string> = {
  // …
  analytics: "Warehouse metrics queries, dashboards, and reporting.",
};

const PROMPTS: Record<(typeof WORKERS)[number], string | (() => string)> = {
  // …
  analytics: ANALYTICS_PROMPT,
};
```

`DESCRIPTIONS[id]`, plus the tool names from step 4, **is** the routing table — the planner
builds its worker catalog from them. There is no separate routing prompt to edit, and no regex
router (`pre-router.ts` is a tombstone). Write the description as the thing you want routed to
you.

Pass a **function** rather than a string if the prompt injects the current date, the way `comms`
does with `buildCommsPrompt` — a bare string is evaluated once at boot and freezes the date.

#### 6. Eval type + golden task (`src/eval/types.ts`, `src/eval/golden-tasks.ts`)

```typescript
export type Department =
  | "admin" | "research" | "comms" | "engineering"
  | "marketing" | "sales" | "personal" | "jobhunt"
  | "analytics";   // ← add
```

```typescript
{
  id: "analytics-weekly-metrics",
  input: "Show me the top metrics for last week",
  expectedRoute: "analytics",
  expectedTools: ["query_metrics"],
},
```

`src/eval/kernel-invoker.ts` reads the observed route from `plan.steps[0].worker`, so
`expectedRoute` is scored against real planner output, not a stub.

#### Optional 7 — Output verifier (`src/kernel/verify.ts`)

`VERIFIERS` is keyed by worker id; a worker with no entry is simply not verified. Add one when
the department can produce a plausible-looking output that is actually wrong — a path that
doesn't exist on disk, a draft still holding `{{placeholders}}`, a count that was never taken.

```typescript
export const VERIFIERS: Record<string, StepVerifier> = {
  // …
  analytics: {
    async verify(output) {
      // Reject a "result" with no rows AND no explicit zero — silence is not a finding.
      return { ok: true };
    },
  },
};
```

#### Optional 8 — Startup capability message (`src/gateway/capability-message.ts`)

`buildRestartMessage()` hard-codes `8 departments ready` and the `·`-separated list. This is
hand-maintained prose that nothing generates and nothing checks — update the count *and* the
list, or `/start` under-reports what the founder actually has.

#### Optional 9 — Golden-set rerun

If the new department's description overlaps an existing one, run `pnpm eval` once and confirm
no existing task's route flipped. Overlapping descriptions are the main cause of routing drift.

### Forget → Error table

| If you forget… | You get… |
|----------------|----------|
| `WORKERS` in `contracts.ts` | Planner names the worker, `WorkerIdSchema` rejects the envelope → typed `validation` FailureReport; the step never runs (loud, and it names the component) |
| `DESCRIPTIONS` / `PROMPTS` in `kernel-boot.ts` | `tsc` error: `Record<WorkerId, …>` is missing a key (loud, good — this is why step 1 comes first) |
| Prompt file or its barrel export | `tsc` error at the `kernel-boot.ts` import (loud) |
| `DEPARTMENT_TOOLS` entry | `buildWorkerSpecs()` falls back to `?? []` — the worker boots with **zero tools**. The planner routes to it and it can do nothing but apologise |
| `Department` union in `eval/types.ts` | `tsc` error in the eval harness (loud) |
| A golden task | No regression guard: routing can drift to another department and nothing fails |
| `capability-message.ts` line | `/start` tells the founder a department doesn't exist. Silent — no test covers this string |
| **`hitlGate()` inside a write tool's wrapper** | **The tool fires with no approval.** `HITL_GATED_TOOLS` does *not* gate anything by itself — it only renders the `*` marker in the capability manifest and feeds `pnpm verify:wiring`. The real gate is the `hitlGate()` call in the wrapper (`src/infra/hitl.ts`) |
| Listing a gated tool in `HITL_GATED_TOOLS` | `pnpm verify:wiring` catches only the *reverse* direction — a name listed but carried by no department ("dead gate"). A write tool that is gated nowhere and listed nowhere passes every check. This is the one silent, dangerous failure on this page: check it by hand |

---

## Adding a step type (output contract)

**You do not add nodes to the graph.** `src/kernel/graph.ts` has exactly six —
`plan · dispatch · agent · tools · collect · synthesize` — and that count is the architecture,
not a starting point. Nesting a sub-graph under a node is the v2 mistake this kernel exists to
undo; `src/agents/engineering-domain.ts` is a CI tombstone precisely so it cannot come back.

What you extend instead is the **output contract registry**. A plan step declares
`expected.schema_ref`; `collect` validates the worker's output against the matching Zod schema
in `OUTPUT_CONTRACTS` and turns a mismatch into a typed failure. Adding a step type = adding a
contract. That is the only "new kind of step" the kernel has.

The registry ships with: `text.summary`, `research.findings`, `draft.email`,
`draft.linkedin_post`, `action.summary`, `data.generic`, plus one `signal.<event>` per entry in
`SIGNAL_CONTRACTS`.

### Step-by-step — 4 files

#### 1. The schema (`src/kernel/contracts.ts`)

```typescript
export const OUTPUT_CONTRACTS: Record<string, z.ZodTypeAny> = {
  // …
  "data.metrics": z.object({
    metric: z.string().min(1),
    value: z.number(),
    period: z.string().min(1),
  }),
};
```

The key's **prefix decides the step kind**, deterministically and without the model's help
(`kindFromSchemaRef` in `src/kernel/envelope-repair.ts`):

| `schema_ref` prefix | `expected.kind` | Consequence |
|---|---|---|
| `draft.*` | `draft` | Output is a draft for founder review |
| `action.summary` | `action_receipt` | **`validateStepResult` refuses the step unless at least one `tool_receipt.ok` is true** |
| anything else | `data` | Plain validated data |

Choose the prefix deliberately: `action_receipt` is the zero-hallucination mechanism. A step
that claims work was done but carries no successful receipt is rejected, not trusted.

#### 2. Optional coercion (`src/kernel/output-coercion.ts`)

Weak models return `"just the text"` or `{ result: {...} }` where a schema wants a specific
object. Rather than loosening the schema, normalise first and keep the schema strict:

```typescript
export function coerceMetrics(val: unknown): unknown {
  if (typeof val === "string") return { metric: val, value: 0, period: "unknown" };
  return val;
}
```

Then wrap the entry: `z.preprocess(coerceMetrics, z.object({ … }))`.

Coercion must be **pure and total** — never throw on hostile input, just hand the value back
unchanged and let Zod produce the typed failure.

#### 3. Prompt template (`getSchemaTemplate()` in `src/kernel/contracts.ts`)

```typescript
case "data.metrics":
  return `{\n  "metric": "string",\n  "value": "number",\n  "period": "string"\n}`;
```

This is what the worker is literally shown as the shape to emit. Skip it and the worker gets
`{}`, guesses, and fails validation on a contract it was never told about.

#### 4. Test (`tests/unit/kernel/contracts.test.ts`)

Cover the accept case, one reject case, and — if you added coercion — the raw shape it repairs.

### Special case: a cross-department signal

Signals need no `OUTPUT_CONTRACTS` edit. Add the payload schema to `SIGNAL_CONTRACTS` in
`src/kernel/signals.ts` and it is spread into the registry automatically as `signal.<key>`:

```typescript
export const SIGNAL_CONTRACTS = {
  // …
  metrics_anomaly: MetricsAnomalyPayload,
} satisfies Record<SignalEventType, z.ZodTypeAny>;
```

Add the key to `SIGNAL_EVENT_TYPES` in the same file or the `satisfies` clause fails `tsc`.

### Forget → Error table

| If you forget… | You get… |
|----------------|----------|
| `OUTPUT_CONTRACTS` entry | The planner's envelope fails Zod at `schema_ref.refine` → `unknown output schema_ref`; the step never dispatches (loud) |
| `getSchemaTemplate()` case | Worker is shown `{}`, invents a shape, and `collect` rejects it — looks like a flaky model, is actually a missing template |
| Wrong prefix (`data.*` for a real action) | Action claims are accepted **with no tool receipt**. Silent, and it is the exact failure the receipt rule exists to prevent |
| Coercion that throws | A malformed model output crashes the node instead of becoming a typed `validation` failure |
| `SIGNAL_EVENT_TYPES` when adding a signal | `tsc` error on the `satisfies` clause (loud) |

---

## The workflow catalog (`saved_workflows`)

**Workflows are not authored — they are recorded.** There is no registry file to add a recipe
to, and no `/run <workflow>` command. A workflow row appears when a real job *succeeds*: after
`vps_run` or `claude_code` returns, the wrapper writes the command to `agents.saved_workflows`
so tomorrow's agent can find a proven job and re-run it instead of re-deriving it.

This replaced the hand-written natural-language SOPs that used to live in a registry file, which
were deleted in Phase 6 with zero importers — nothing ever ran them.

### The three pieces

| Piece | Where |
|---|---|
| Table | `savedWorkflows` — `src/db/schema.ts:1302` |
| Write path | `recordWorkflowRun()` — `src/db/queries.ts:1488` |
| Read path | `topWorkflows()` → `list_workflows` tool (admin worker) — `src/agents/agent-tools/workflows.ts` |

Identity is a content hash, not a name: `workflowSignature(tool, command, image)` in
`src/tools/workflow-catalog.ts`. The upsert targets `(tenant_id, signature)`, so re-running the
same command increments `run_count` instead of inserting a duplicate — which is what makes
"our most-used workflows" a plain `ORDER BY run_count DESC` rather than a curated list somebody
has to maintain.

### The extension point: making a new tool catalog its runs

This is the only thing you actually add here. If you write a tool that executes a
founder-reusable job, catalog it — **after** the run has already succeeded.

```typescript
// In the agent-tool wrapper, AFTER writeAuditEntry():
// allow-failopen: workflow cataloging is an index, never a dependency
await recordWorkflowRun({
  tenant_id: TENANT,
  slug: slugifyWorkflow(command, brief ?? undefined),
  signature: workflowSignature("my_tool", command, image ?? undefined),
  tool: "my_tool",
  command,
  ...(brief ? { brief } : {}),
  s3_keys: artifacts.map((a) => a.s3_key),   // [] if the tool produces no S3 artifacts
  last_run_id: runId,
}).catch((err) => log.warn({ err: String(err) }, "my_tool: workflow catalog write failed (non-fatal)"));
```

Four rules, all load-bearing:

1. **After success, never before.** The job is already done and its artifacts are already
   durable. Cataloguing is an index built on top of that fact.
2. **`.catch()` it.** A catalog write must never turn a finished job into a failed one.
3. **Tag the catch `// allow-failopen: <reason>`.** CI rule R3 in
   `scripts/verify-architecture.ts` fails the build on an untagged swallow — a silent `.catch`
   is indistinguishable from a bug.
4. **Spread optionals conditionally** (`...(brief ? { brief } : {})`). `exactOptionalPropertyTypes`
   rejects an explicit `undefined`.

`src/agents/agent-tools/vps-run.ts:68` and `src/agents/agent-tools/engineering.ts:402` are the
two live examples — copy whichever is closer.

### Reading the catalog

`list_workflows` is read-only, needs no approval, and is carried by the **admin** worker. It
renders most-run-first with run count, last-used timestamp, and whether outputs reached S3.
Ask for it in plain language ("what do we run a lot?"); there is no slash command.

### Forget → Error table

| If you forget… | You get… |
|----------------|----------|
| `recordWorkflowRun` in a new executor tool | The job runs fine and vanishes. Nothing breaks, nothing is logged, and the workflow is silently un-findable tomorrow — the failure this table exists to make visible |
| `.catch()` on the call | A DB blip converts a **successful, already-billed** job into a reported failure |
| `// allow-failopen:` tag | `pnpm verify:arch` fails on rule R3 (loud, good) |
| Awaiting it *before* the work | A catalog row that claims a run that never happened |
| Varying the command string run-to-run | A new `signature` every time → `run_count` stays 1 and "most used" ranks nothing |

---

## Adding a Telegram Command

**4 touch points, 2 files.**

### Step 1 — Handler (`src/gateway/commands.ts`)

```typescript
export async function handleStats(ctx: Context): Promise<void> {
  const stats = await getSystemStats();
  await ctx.reply(
    `📊 <b>System stats</b>\n\n${formatStats(stats)}`,
    { parse_mode: "HTML" }
  );
}
```

### Step 2 — Import (`src/gateway/telegram.ts`)

```typescript
import {
  handleCommands,
  handleDirectQ,
  handleStats,       // ← add
} from "./commands.js";
```

### Step 3 — Register (`src/gateway/telegram.ts`)

```typescript
bot.command("stats", (ctx) => handleStats(ctx));
```

### Step 4 — Help text (`src/gateway/commands.ts`)

```typescript
// In handleCommands:
`/stats — show system metrics and uptime`
```

### Forget → Error table

| If you forget… | You get… |
|----------------|----------|
| Import in telegram.ts | tsc error (loud) |
| `bot.command` registration | `/stats` is silently ignored by Telegram |
| Help text entry | Command works but is invisible in `/commands` |

---

## Adding golden eval tasks

Golden tasks are the regression guard for routing and tool selection. Add one per
meaningful new capability.

**File:** `src/eval/golden-tasks.ts`

```typescript
{
  id: "analytics-weekly-metrics",          // unique, kebab-case
  input: "Show me top metrics for last week",
  expectedDept: "analytics",               // must match Department union
  expectedTools: ["query_metrics"],        // at least one required tool
  mustContain: ["metric"],                 // strings the reply must contain
  mustNotContain: ["error", "can't"],      // strings the reply must NOT contain
  maxTurns: 4,                             // abort if agent loops (default 6)
},
```

**Run eval:**

```bash
pnpm eval                  # full suite — needs Gemini key + live DB
pnpm eval --filter analytics   # subset (if supported by your eval runner)
```

A failing golden task after your change means routing or tool selection regressed.
Fix prompts (system-prompts.ts) before committing.

---

## Verification ritual

Run this after **every** change before opening a PR:

```bash
# 1. Type check + tests
pnpm lint          # zero tsc errors
pnpm test          # all must pass

# 2. If prompts, tools, or routing changed:
pnpm eval          # golden set must hold

# 3. Live verification
#    Start bot: npx tsx src/index.ts
#    In Telegram: /reset   (clear thread checkpoint)
#    Send a message that exercises your change
#    Confirm reply is correct + check action_log if HITL
```

**Evidence standard for "it works":**
- The exact bot reply text, AND
- For HITL tools: the matching `action_log` row (or explicit "NO ROW expected").
- "Tests pass" alone is NOT sufficient (see CLAUDE.md Rule #19).

---

## Key invariants (never break these)

| Invariant | Where enforced | What breaks |
|-----------|---------------|-------------|
| A worker sees only its `TaskEnvelope` | `src/kernel/worker.ts` + `contracts.ts` | Context leakage — other steps' tool calls pollute the worker's history |
| Models/tools/checkpointer injected once | `src/gateway/kernel-boot.ts`, the only composition root | Graph re-compiled per request → cold start + checkpoint loss |
| HITL before every external send | `hitlGate()` in agent-tool wrappers | Emails/posts/pushes fire without approval |
| Idempotency before every send | `hasBeenAudited()` + `writeAuditEntry()` | Double-sends on retry |
| Date-injecting prompts passed as references | `createTrimmedPrompt(buildCommsPrompt, …)` | Date frozen at boot time |
| ES module `.js` extension on every import | tsc / NodeNext | Runtime `ERR_MODULE_NOT_FOUND` |
| Zod optional fields include `.nullable()` | Rule #7 | LangChain SDK throws on undefined tool args |
| Tool never throws | `try/catch` in every tool body | Single tool failure crashes the whole ReAct loop |

---

## Cross-references

- `docs/rules/PROGRAMMING-RULES.md` — compact wiring maps (the authoritative reference)
- `docs/rules/TOOL-STANDARDS.md` — quality bar for tool bodies
- `docs/rules/TESTING-RULES.md` — test quality rules + 8-point template
- `docs/guides/ARCHITECTURE.md` — system design and data flows
- `docs/decisions/` — ADRs explaining *why* architectural choices were made
- `src/kernel/graph.ts` — the one orchestration path, end to end
- `src/tools/email.ts` — reference impl for HITL + idempotency in a tool
- `src/tools/web-search.ts` — reference impl for a read-only (no HITL) tool
