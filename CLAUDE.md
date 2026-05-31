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
- ✅ Phase 1B: Brain — supervisor, sales pod, critic (COMPLETE)
- ✅ Phase 1C: Gateway — Telegram bot, HITL callbacks (COMPLETE)
- ✅ Phase 1D: Tests + evals (COMPLETE)
- ✅ Phase 2A: Redis + caching layer (COMPLETE)
- ✅ Phase 2B: ProspectingPod + `/prospect` command (COMPLETE)
- ✅ Phase 2C: Suppression + quota safety rails, LinkedIn tools, scheduler (COMPLETE)
- ✅ Phase 2D: Observability + docs update (COMPLETE)
- ✅ Phase 2E: Engineer agents per department (eng_engineer, sales_engineer, mktg_engineer — all live)
- 🔄 Phase 3A: Brand guidelines, social pod, senior_engineer, token economy, turicks-brain sync (IN PROGRESS — branch: phase3/brand-guidelines-social-pod-token-economy)
- ⏳ Phase 3B: Social pod graph + batch content pipeline
- ⏳ Phase 3C: senior_engineer live GitHub integration
- ⏳ Phase 3D: turicks-brain full sync + web app gateway (Next.js)

## Git Workflow (Non-Negotiable)

### Branch Rules
- **NEVER commit directly to `main`** — all work happens on feature branches
- Branch naming: `phase{N}/{short-description}` for phase work, `fix/{issue}` for bugs, `feat/{name}` for standalone features
- Every branch gets a PR before merging to main — human approves merge
- Current working branch: `phase3/brand-guidelines-social-pod-token-economy`

### After Completing Work
1. `pnpm test` must be green
2. `pnpm brain:sync` — sync docs/decisions to turicks-brain (run after DB is up)
3. Push branch + open PR via `gh pr create`
4. senior_engineer agent can create PRs autonomously; **only humans merge**

### Decision Sync Rule
Every architectural decision, brand update, phase completion, or strategy change must be:
1. Written to `docs/decisions/` (as ADR) or `docs/study/CASE-STUDY-LOG.md`
2. Synced to turicks-brain via `pnpm brain:sync`
3. Committed on a feature branch + merged via PR

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
src/core/registry.ts       — All agent + company definitions
src/core/config.ts         — Env vars + model cascade + budget limits
src/core/prompts.ts        — All system + task prompts
src/agents/state.ts        — All LangGraph Annotation schemas + interfaces
src/agents/graph.ts        — Main FounderGraph (compiled once)
src/agents/pods/prospecting.ts — ProspectingPod (disambiguate → research → ICP score → route)
src/db/schema.ts           — All Drizzle table definitions (7 tables)
src/db/queries.ts          — Named query functions (no raw SQL elsewhere)
src/infra/llm.ts           — LLM cascade executor + budget guard
src/infra/redis.ts         — Redis singleton + key helpers (research, quota, llmCache)
src/infra/scheduler.ts     — Cron jobs: LinkedIn posts, reply poller, HITL sweeper
src/infra/checkpointer.ts  — TenantAwareCheckpointer + thread ID builder
src/gateway/telegram.ts    — grammy bot + topic routing + /prospect command
src/gateway/hitl.ts        — HITL interrupt lifecycle
src/tools/linkedin.ts      — LinkedIn post + reply tools (Composio)
drizzle/                   — Generated migration SQL (run: npx drizzle-kit migrate)
```

## Phase 3E Rules (Testing + Engineer Responsibility)

### 11. Test before done
`pnpm test` must be green before any task is marked complete.
If a change touches existing files, run affected tests first.
If tests fail, fix them — never skip or disable unless they were already failing (confirm with `git stash`).

### 12. Self-critique before architectural plans
Write 3 critique points of your own approach before finalising any design.
Answer each critique point explicitly. This prevents obvious failure modes from shipping.

### 13. Engineer agents own their department
`eng_engineer`, `sales_engineer`, `mktg_engineer` make autonomous technical decisions within their pod.
HITL gates guard only external sends (email, LinkedIn, GitHub push).
Never route to HITL for internal analysis, draft generation, or code review steps.

### 14. Safety rails order is non-negotiable
Sales pod flow: `lead_intel → suppression_check → quota_check → bdr → critic → [HITL] → finalize`
Never bypass suppression_check or quota_check, even in testing (mock them instead).

### 15. Redis for ephemeral, Postgres for durable (see ADR-005)
- Research cache, send quotas, LLM prompt cache → Redis (TTL, atomic INCR)
- Lead pipeline, suppressions, HITL registry, audit log → Postgres (durable, queryable)
