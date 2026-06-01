# FounderOS — Claude Instructions

## What This Is
FounderOS is a multi-agent AI operating system for two purposes:
- **Operational**: Run Turicks (AI agency) + Naggar Retreat via Telegram
- **Portfolio**: Production-grade TypeScript + LangGraph architecture

**v2 Stack (current):** Node.js 22 + TypeScript 5.5 strict + LangGraph JS (`createSupervisor` + `createReactAgent`) + grammy + drizzle-orm + Gemini Flash

## Before Touching Code
1. Read `src/agents/office.ts` — the entire multi-agent system
2. Read `src/agents/agent-tools.ts` — tools + HITL interrupt() logic
3. Read `src/agents/system-prompts.ts` — all 4 prompts
4. Read `docs/OPERATIONS.md` — how it runs day-to-day
5. Read `docs/ROADMAP.md` — what's next and what NOT to build

## Content & Asset Delivery Rules

**Always present content inline — never reference .md files only.**
When listing copy, prompts, product descriptions, or any user-facing content exists in .md files:
1. Print the content directly in the response (copy-paste ready)
2. Organise it with clear headers and visual separators
3. Never say "see file X" or "open X.md" as the only instruction — the user may not be able to open it

This applies to: Gumroad listings, LinkedIn posts, email templates, brand guidelines, product descriptions, prompt packs.

---

## Current Phase Status
- ✅ Phases 1–3 (v1): Foundation, pods, gateway, tests, observability (SUPERSEDED by v2)
- ✅ **v2 Rebuild (2026-06-01)**: Prebuilt supervisor + 3 ReAct departments — LIVE ON MAIN
  - research [search_web] · comms [email*, linkedin*] · engineering [github_r, github_w*]
  - (* = HITL-gated via native interrupt())
  - 10,678 LOC → ~500 LOC · 8 test files · 40 tests green · tsc clean
- ✅ **Phase B (2026-06-01)**: Marketing + Sales + Prospecting departments — MERGED (PR #5)
- 🔄 **Phase C (2026-06-01)**: Context memory + knowledge search + proactive scheduler — code complete, 47 tests green (branch `feat/phase-c-memory-scheduler`). Followups: populate turicks-brain (`brain:sync`), live Telegram verify. See `docs/phases/PHASE-C-INTELLIGENCE.md`.
- 🔄 **Phase D (now)**: Revenue Flywheel — Gumroad live + LinkedIn launch sequence + cinematic-web done-for-you tier + weekly outbound rhythm
- ⏳ **Phase E (gated, 4–6 wks reliable use)**: SaaS pivot — web gateway, multi-tenancy, billing (FounderOS SaaS *or* Cinematic Cloud — pick one)

## Git Workflow (Non-Negotiable)

### Branch Rules
- **NEVER commit directly to `main`** — all work happens on feature branches
- Branch naming: `phase{N}/{short-description}` for phase work, `fix/{issue}` for bugs, `feat/{name}` for standalone features
- Every branch gets a PR before merging to main — human approves merge
- Current working branch: `main` (v2 merged 2026-06-01)

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
