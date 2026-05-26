# FounderOS — Claude Instructions

## What This Is
FounderOS is a multi-agent AI operating system for two purposes simultaneously:
- **Operational**: Run Turicks (AI agency) + Naggar Retreat business operations via Telegram
- **Portfolio**: Demonstrate production-grade TypeScript + LangGraph architecture to hiring managers

Stack: Node.js 22 + TypeScript 5.5 (strict) + LangGraph JS + Vercel AI SDK + grammy + drizzle-orm

## Before Touching Code
1. Read `docs/architecture.md` — system overview and layer responsibilities
2. Read `src/agents/state.ts` — ALL state types live here
3. Read `src/core/registry.ts` — ALL agent + company definitions live here
4. Read `src/core/config.ts` — model cascade tiers + env validation

## Current Phase Status
- ✅ Phase 1A: Foundation — config, types, DB schema, infra layer (COMPLETE)
- 🔄 Phase 1B: Brain — supervisor, sales pod, critic (NEXT)
- ⏳ Phase 1C: Gateway — Telegram bot, HITL callbacks
- ⏳ Phase 1D: Tests + evals

## Key Rules (Non-Negotiable)

### 1. Registry-driven
Never hardcode `"turicks"` or `"naggar"` outside `src/core/registry.ts`.
Reference companies via `getCompany("turicks")`, agents via `getAgent("lead_intel")`.

### 2. Graph compiled once
`src/agents/graph.ts` exports `getGraph()` — call this at startup, reuse forever.
**Never** compile the graph inside a request handler.

### 3. Critic = NODE (not edge)
The critic has side effects (writes CritiqueRecord, logs analytics).
It must be a graph node. Conditional routing happens in a separate pure-function edge.

### 4. HITL = DB-backed
Always write to `interrupt_registry` table BEFORE calling LangGraph `interrupt()`.
This ensures recoverability if the process crashes between writing and calling.

### 5. Idempotency before external actions
Before email_sent / telegram_send / github_push / linkedin_post:
```typescript
if (await hasBeenAudited(idempotencyKey)) return; // Skip
// ... do the action ...
await writeAuditEntry({ action, idempotency_key, payload });
```

### 6. Different model families for generator/critic
- Generator: Gemini family (google provider)
- Critic: Claude family (anthropic provider)
This prevents sycophancy (model agreeing with itself).

### 7. LangSmith from day 1
Call `initTelemetry()` first in `src/index.ts`. PII is scrubbed in `src/infra/telemetry.ts`.

### 8. Async-first
All grammy handlers are `async`. Never block the event loop in a handler.

### 9. Schema versioning
Every state type has `schema_version: Annotation<number>({ default: () => 1 })`.
Bump when shape changes. Migrate old checkpoints in a background job.

### 10. Zod at the boundary
Validate all env vars (config.ts) and external API responses with Zod.
Never `as any` or trust raw API responses.

## Module & Import Rules
- Module system: ES modules (`"module": "NodeNext"`)
- All imports use `.js` extension even for `.ts` files: `import { x } from "./module.js"`
- Bracket notation for env: `process.env["KEY"]` (not `process.env.KEY`)
- No circular imports: core → (no imports from src), db → core, infra → db + core, agents → infra + core, gateway → agents + infra

## Adding a New Agent
1. Add definition to `src/core/registry.ts` `_agentList`
2. Add system prompt to `src/core/prompts.ts` `SYSTEM` dict
3. Add node function to relevant pod: `src/agents/pods/{sales,engineering,marketing}.ts`
4. Wire node into pod graph
5. Add unit test in `tests/unit/`

## Adding a New Tool
1. Create `src/tools/{tool-name}.ts` implementing `UnifiedTool`
2. Import and `registerTool()` in `src/tools/index.ts`
3. Add tool name to agent's `allowed_tools` in `src/core/registry.ts`

## Running Locally
```bash
# Full setup
pnpm install
cp .env.example .env   # fill in your keys
docker compose up -d postgres
npx tsx scripts/setup-db.ts

# Verify Phase 1A
npx tsx -e "import('./src/core/registry.js').then(m => console.log(m.getAgent('lead_intel')))"
npx tsx -e "import('./src/core/config.js').then(m => console.log(Object.keys(m.CASCADE)))"

# Start (Phase 1C+)
npx tsx src/index.ts

# Tests
pnpm test
```

## Model Cascade Tiers
Defined in `src/core/config.ts`. Each tier tries providers in order:

| Tier | Primary | Fallback 1 | Fallback 2 |
|------|---------|-----------|-----------|
| CEO | claude-sonnet-4-5 | gemini-2.5-pro | gemini-flash |
| deep_research | gemini-2.5-pro | gemini-flash | deepseek-r1:free |
| md | gemini-flash | claude-haiku-4-5 | llama-70b:free |
| code | lmstudio/qwen | qwen3-coder:free | gemini-flash |
| nano | gemini-flash-lite | claude-haiku-4-5 | — |
| local | lmstudio/qwen | gemini-flash-lite | — |

## File Locations Quick Reference
```
src/core/registry.ts    — All agent + company definitions
src/core/config.ts      — Env vars + model cascade + budget limits
src/core/prompts.ts     — All system + task prompts
src/agents/state.ts     — All LangGraph Annotation schemas + interfaces
src/agents/graph.ts     — Main FounderGraph (compiled once)
src/db/schema.ts        — All Drizzle table definitions
src/db/queries.ts       — Named query functions (no raw SQL elsewhere)
src/infra/llm.ts        — LLM cascade executor + budget guard
src/infra/checkpointer.ts — TenantAwareCheckpointer + thread ID builder
src/gateway/telegram.ts — grammy bot + topic routing
src/gateway/hitl.ts     — HITL interrupt lifecycle
```
