# FounderOS — Developer Guide

> **Start here before touching the codebase.** This document is the step-by-step
> companion to `docs/rules/PROGRAMMING-RULES.md` — it explains the *why* and shows
> concrete examples of every extension point.

## Table of Contents

1. [Architecture in 60 seconds](#architecture-in-60-seconds)
2. [Local dev setup](#local-dev-setup)
3. [Adding a Tool](#adding-a-tool)
4. [Adding a Department](#adding-a-department)
5. [Adding a Domain (nested sub-supervisor)](#adding-a-domain-nested-sub-supervisor)
6. [Adding a Workflow (SOP)](#adding-a-workflow-sop)
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
gateway/telegram.ts          ← grammy handler, HITL resume, history trim
      │
      ▼
pre-router.ts (optional)     ← deterministic keyword hint (not LLM)
      │
      ▼
agents/office.ts             ← LangGraph createSupervisor (Gemini 2.5 Flash)
      │
      ├── research dept       ← createReactAgent + tools[search_web]
      ├── comms dept          ← createReactAgent + tools[send_email, read_emails, …]
      ├── engineering dept    ← createReactAgent (or CTO subgraph) + tools[github_r/w, claude_code]
      ├── marketing dept      ← createReactAgent + tools[linkedin_post, search_web]
      ├── sales dept          ← createReactAgent + tools[search_web, send_email]
      ├── personal dept       ← createReactAgent + tools[read_file, write_file, run_shell, …]
      └── jobhunt dept        ← createReactAgent + tools[read_cv, search_jobs, send_email]
```

**Three hard rules about this diagram:**

1. **Compile once** — `buildOffice(checkpointer)` is called ONCE per process. Never inside
   a request handler. The singleton is `getOffice()` in `index.ts`.
2. **Prompts are functions** — `buildSupervisorPrompt()` and `buildCommsPrompt()` return
   strings with `new Date()` injected. Pass them as **function references** to
   `createTrimmedPrompt`, not pre-evaluated strings, or the date freezes at boot.
3. **Context isolation** — `outputMode: "last_message"` is pinned on every supervisor and
   sub-supervisor. A department's internal tool calls never appear in the supervisor's
   history. Do NOT change this.

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

### Layer 5 — Department (`src/agents/office.ts`)

```typescript
// Inside the research dept createReactAgent call:
const research = createReactAgent({
  llm: getModel(),
  tools: [
    searchWebAgent,
    myToolAgent,       // ← add here
  ],
  // ...
});
```

### Layer 6 — Prompts (`src/agents/system-prompts.ts`)

**6a — Tell the dept agent it has the tool (in the dept prompt):**

```typescript
// In RESEARCH_PROMPT or whichever dept owns it:
`TOOLS YOU HAVE:
- search_web: Search the web for current information
- my_tool: Does X given Y — use when the founder asks about Z`
```

**6b — Add the trigger to the SUPERVISOR routing table:**

```typescript
// In buildSupervisorPrompt() routing table:
`| research | "search", "find", "look up", "Z query", "my_tool trigger phrase" |`
```

### Forget → Error table

| If you forget… | You get… |
|----------------|----------|
| Layer 1 test | Soft-fail bug (wrong field names ship silently) |
| Layer 3 wrapper | Tool exists but agents can't see it — dead code |
| Layer 4 barrel | `tsc` error: `'myToolAgent' is not exported from '...'` (loud, good) |
| Layer 5 dept tools array | Tool built but no agent has it — never invoked |
| Layer 6a dept prompt | Agent has the tool but never uses it — "I can't do that" |
| Layer 6b routing table | Supervisor routes the request elsewhere |

---

## Adding a Department

The widest blast radius: **10 files + 1 optional**. Work through them in order.

**Rule: Only add a department if it has ≥2 unique tools that no other dept owns.**
An agent that only calls tools owned by another dept belongs in that dept.

### Step-by-step

#### 1. System prompt (`src/agents/system-prompts.ts`)

```typescript
// a) New dept prompt:
export const ANALYTICS_PROMPT = `
You are the analytics agent for FounderOS.
…
TOOLS YOU HAVE:
- query_metrics: Run a metrics query
`;

// b) Add a row to the SUPERVISOR routing table inside buildSupervisorPrompt():
`| analytics | "metrics", "dashboard", "report", "trend", "analytics" |`

// c) Add the dept's tools to the TOOL OWNERSHIP block:
`analytics: [query_metrics]`
```

#### 2. Department agent (`src/agents/office.ts`)

```typescript
import { ANALYTICS_PROMPT } from "./system-prompts.js";
import { queryMetricsAgent } from "./agent-tools.js";

// Build the agent (BEFORE the supervisor is built):
const analytics = createReactAgent({
  llm: getModel(),
  tools: [queryMetricsAgent],
  messageModifier: createTrimmedPrompt(ANALYTICS_PROMPT, subAgentBudget),
  name: "analytics",
});

// Add to the supervisor:
const supervisor = await createSupervisor({
  agents: [research, comms, engineering, marketing, sales, personal, jobhunt, analytics],
  // …
});

// Update the log.info("Office compiled…") line to include "analytics"
```

#### 3. Eval types (`src/eval/types.ts`)

```typescript
export type Department =
  | "research" | "comms" | "engineering" | "marketing"
  | "sales" | "personal" | "jobhunt"
  | "analytics";   // ← add
```

#### 4. Eval invoker (`src/eval/office-invoker.ts`)

```typescript
const DEPARTMENTS = new Set<Department>([
  "research", "comms", "engineering", "marketing",
  "sales", "personal", "jobhunt",
  "analytics",  // ← add
]);
```

#### 5. Golden tasks (`src/eval/golden-tasks.ts`)

```typescript
{
  id: "analytics-dashboard",
  input: "Show me the top metrics for last week",
  expectedDept: "analytics",
  expectedTools: ["query_metrics"],
  mustContain: ["metric", "last week"],
},
```

#### 6. `/q` command (`src/gateway/commands.ts`)

```typescript
// In handleDirectQ, add to valid dept list:
const VALID_DEPTS = ["research","comms","engineering","marketing","sales","personal","jobhunt","analytics"];

// In handleCommands help text, add:
`analytics — run metrics queries and build dashboards`
```

#### 7. Startup banner (`src/index.ts`)

```typescript
log.info("Office compiled: research · comms · engineering · marketing · sales · personal · jobhunt · analytics");
```

### Forget → Error table

| If you forget… | You get… |
|----------------|----------|
| Routing row in supervisor prompt | Supervisor never routes there — dept is dead code |
| Agent in `createSupervisor` agents array | `RuntimeError: unknown agent "analytics"` on first route |
| `Department` union in `types.ts` | tsc error in eval (loud) |
| `DEPARTMENTS` Set in `office-invoker.ts` | Eval logs `null` dept; every golden task fails silently |
| `/q` valid-depts list | `/q analytics …` returns "unknown department" |

---

## Adding a Domain (nested sub-supervisor)

A domain groups related departments under a sub-supervisor so the root supervisor
only sees the domain, not individual departments. Use when ≥3 departments share
context or need coordinated handoffs.

**Example:** The CTO engineering domain (`src/agents/engineering-domain.ts`) groups
`coder`, `qa`, and `devops` under a sub-supervisor and exposes a single `engineering`
node to the root supervisor.

### When to create a domain

- 3+ departments with related tools and prompts
- Departments need HITL nested inside a workflow (not just at the leaf tool level)
- You want the root supervisor isolated from internal engineering routing decisions

### File to copy and adapt

`src/agents/engineering-domain.ts` is the reference implementation. Mirror its structure:

```typescript
// src/agents/analytics-domain.ts
import { createSupervisor } from "@langchain/langgraph-supervisor";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createTrimmedPrompt } from "../infra/context-manager.js";
import { getModel } from "./model.js";
import { assertContextIsolation } from "./context-isolation.js";

// Domain sub-agents (e.g. dataFetcher, chartBuilder)
const dataFetcher = createReactAgent({ … });
const chartBuilder = createReactAgent({ … });

// Domain supervisor prompt (routes between sub-agents)
const ANALYTICS_DOMAIN_PROMPT = `You are the analytics domain supervisor…`;

export async function buildAnalyticsDomain() {
  const domain = await createSupervisor({
    agents: [dataFetcher, chartBuilder],
    llm: getModel(),
    prompt: ANALYTICS_DOMAIN_PROMPT,
    outputMode: "last_message",   // NEVER change this
  });

  assertContextIsolation(domain, "analytics-domain");
  return domain;
}
```

Then in `office.ts`, replace the flat `analytics` agent with the compiled domain:

```typescript
import { buildAnalyticsDomain } from "./analytics-domain.js";

// In buildOffice() — call once at compile time:
const analyticsDomain = await buildAnalyticsDomain();

const supervisor = await createSupervisor({
  agents: [ …, analyticsDomain.compile() ],
  // …
});
```

**Critical:** `assertContextIsolation()` must be called on every supervisor and
sub-supervisor. It enforces `outputMode: "last_message"` and throws at startup if it
was accidentally omitted.

### Feature flag pattern (env-gated promotion)

For gradual rollout, gate the domain behind an env var (see `ENGINEERING_SUBGRAPH`):

```typescript
// office.ts
const useAnalyticsDomain = process.env["ANALYTICS_SUBGRAPH"] === "true";

const analyticsNode = useAnalyticsDomain
  ? (await buildAnalyticsDomain()).compile()
  : createReactAgent({ … flat analytics … });
```

This keeps the domain behind a flag until verified live, without blocking merging.

---

## Adding a Workflow (SOP)

A workflow is a sequence of natural-language steps that the existing office executes.
No new tools, no new routing — just a recipe that the supervisor already understands.

**3 files only.**

### Step 1 — Register the workflow (`src/workflows/registry.ts`)

```typescript
{
  id: "weekly_outreach_batch",
  name: "Weekly Outreach Batch",
  description: "ICP-score prospects, draft cold outreach, queue for approval",
  params: ["company"],    // ← slot names used in steps
  steps: [
    "Search for recent news about {company} and their tech stack",
    "Score {company} against Turicks ICP (AI-first, 10-200 employees, Series A/B)",
    "Draft a personalised cold email to {company}. Use search_web for contact info.",
    "Queue the draft for founder approval before sending",
  ],
},
```

### Step 2 — Unit test (`tests/unit/workflows/registry.test.ts`)

```typescript
it("weekly_outreach_batch exists with correct params", () => {
  const wf = getWorkflow("weekly_outreach_batch");
  expect(wf).toBeDefined();
  expect(wf!.params).toContain("company");
  expect(wf!.steps).toHaveLength(4);
});
```

### Step 3 — Document it (`MEMORY.md` or `docs/` entry)

One line in MEMORY.md:
```
- Workflow `weekly_outreach_batch`: ICP-score + draft + HITL queue. Params: company.
```

### Forget → Error table

| If you forget… | You get… |
|----------------|----------|
| `id` in registry | `/run weekly_outreach_batch` → "unknown workflow" |
| Param name mismatch | Step template has `{company}` but params declared as `name` → slot never filled |

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
  id: "research-pricing-tiers",              // unique, kebab-case
  input: "Research Stripe's pricing tiers and summarise them.",
  expectedRoute: "research",                 // must match the Department union in src/eval/types.ts
  expectedTools: ["search_web"],             // optional — subset match: every listed tool must be observed
  expectsHitl: false,                        // optional — true only when the task must hit the approval gate
  note: "covers the read-only research path" // optional — shown in the report
},
```

`GoldenTask` (`src/eval/types.ts`) has exactly these fields: `id`, `input`,
`expectedRoute`, and the optional `expectedTools`, `expectsHitl`, `note`. There is
no reply-text assertion — scoring covers routing, tool selection, and HITL
coverage only (`src/eval/scoring.ts`). Omit an optional field rather than
over-specifying it: an expectation you are not confident about makes a failure
noise instead of signal.

**Run eval:**

```bash
pnpm eval                  # full suite — needs Gemini key + live DB
```

`scripts/run-eval.ts` reads no arguments; there is no subset/filter flag. To run a
subset, temporarily narrow `GOLDEN_TASKS` or call `runEval()` directly with your
own array.

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
| `outputMode: "last_message"` on all supervisors | `assertContextIsolation()` called at boot | Context leakage — tool calls pollute parent history |
| `buildOffice()` called ONCE | `getOffice()` singleton in `index.ts` | Graph re-compiled per request → cold start + checkpoint loss |
| HITL before every external send | `hitlGate()` in agent-tool wrappers | Emails/posts/pushes fire without approval |
| Idempotency before every send | `hasBeenAudited()` + `writeAuditEntry()` | Double-sends on retry |
| Prompt functions passed as references | `createTrimmedPrompt(buildSupervisorPrompt, …)` | Date frozen at boot time |
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
- `src/agents/engineering-domain.ts` — reference impl for nested sub-supervisors
- `src/tools/email.ts` — reference impl for HITL + idempotency in a tool
- `src/tools/web-search.ts` — reference impl for a read-only (no HITL) tool
