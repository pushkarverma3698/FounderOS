# FounderOS — Claude Instructions

## What This Is
FounderOS is a multi-agent AI operating system for two purposes:
- **Operational**: Run Turicks (AI agency) + Naggar Retreat via Telegram
- **Portfolio**: Production-grade TypeScript + LangGraph architecture

**v2 Stack (current):** Node.js 22 + TypeScript 5.5 strict + LangGraph JS (`createSupervisor` + `createReactAgent`) + grammy + drizzle-orm + Gemini Flash

## Before Touching Code
1. **Consult the knowledge graph** (`.claude/graph.json`) before searching files
   - Query structure: departments → agents → tools
   - Find connections: "Which tools does X use?" → graph edges
   - Reduces token usage by 70x vs grepping files
   - Graph visualization: `.claude/graph-mermaid.md`
2. Read `src/agents/office.ts` — the entire multi-agent system
3. Read `src/agents/agent-tools.ts` — tools + HITL interrupt() logic
4. Read `src/agents/system-prompts.ts` — all 4 prompts
5. Read `docs/guides/OPERATIONS.md` — how it runs day-to-day
6. Read `docs/ROADMAP.md` — what's next and what NOT to build
7. Read `docs/rules/PROGRAMMING-RULES.md` — wiring maps before adding ANY tool/dept/workflow/command
8. Start at `docs/README.md` — the master index of all docs

## Knowledge Graph (Graphify Integration)

**FounderOS has a queryable knowledge graph** — structured topology of departments, agents, tools, and services.

- **Location:** `.claude/graph.json` (43 nodes, 47 edges)
- **Visualization:** `.claude/graph-mermaid.md` (Mermaid diagram)
- **Integration Guide:** `.claude/GRAPHIFY-INTEGRATION.md`

**How to use:**
- Before any file search, think: "Can I navigate via the graph?"
- Example: "Where is search_web used?" → query graph edges, not grep
- Example: "What tools does personal have?" → read `dept_personal` neighbors
- This **cuts file reads by ~70%** on large codebases

**Regenerate after adding agents/tools:**
```bash
npx tsx scripts/generate-knowledge-graph.ts
```

## Content & Asset Delivery Rules

**Always present content inline — never reference .md files only.**
When listing copy, prompts, product descriptions, or any user-facing content exists in .md files:
1. Print the content directly in the response (copy-paste ready)
2. Organise it with clear headers and visual separators
3. Never say "see file X" or "open X.md" as the only instruction — the user may not be able to open it

This applies to: Gumroad listings, LinkedIn posts, email templates, brand guidelines, product descriptions, prompt packs.

---

## Current Phase Status
- 🟢 **DEPLOYED — LIVE in production since 2026-06-14**: Hetzner VPS, native systemd + Docker(Postgres+Ollama), `main` auto-deploys via GitHub Actions (CI → CD → `/health`). Full pipeline + Day-1 gotchas: `docs/guides/DEPLOYMENT.md`. Remaining wrap-up checklist: `docs/PRODUCTION-WRAP-UP.md`. Live-verified on the real Telegram path incl. recursion-abort recovery (PR #60).
- ✅ Phases 1–3 (v1): Foundation, pods, gateway, tests, observability (SUPERSEDED by v2)
- ✅ **v2 Rebuild (2026-06-01)**: Prebuilt supervisor + 3 ReAct departments — LIVE ON MAIN
  - research [search_web] · comms [email*, linkedin*] · engineering [github_r, github_w*]
  - (* = HITL-gated via native interrupt())
  - 10,678 LOC → ~500 LOC core · now 57 test files · 614 tests green · tsc clean
- ✅ **Phase B (2026-06-01)**: Marketing + Sales + Prospecting departments — MERGED (PR #5)
- ✅ **Personal department (2026-06-03)**: 7th department `personal` — laptop operator (file/shell/browser, HITL-gated, `path-guard` confines to `$HOME`, secrets blocked even on read). MERGED (PR #16). Kept separate from `engineering` by least-privilege (ADR-013); Safari-MCP deferred (ADR-012). 267 tests green · eval 13/13.
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
Always write to the `hitl_approvals` table BEFORE calling LangGraph `interrupt()`.
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

## Adding a Tool / Department / Workflow / Command

**Follow the wiring maps in `docs/rules/PROGRAMMING-RULES.md`.** Each task has an
exact file-touch sequence + a "forget X → error Y" table. The v1 pod/registry
flow is GONE — there is no `registerTool()`, no `allowed_tools`, no `pods/`.

Quick reference (full detail in the wiring maps):
- **Add a tool** (6 layers): `src/tools/{name}.ts` → test → `agent-tools/{dept}.ts` wrapper
  → `agent-tools.ts` barrel export → `office.ts` department → `system-prompts.ts` (dept prompt + supervisor routing).
- **Add a department** (10 files): see Wiring Map 2 — widest blast radius.
- **Add a workflow** (3 files): `workflows/registry.ts` → test → MEMORY.
- **Add a command** (4 points): `commands.ts` handler → `telegram.ts` import + register → help text.

Standards: `docs/rules/TOOL-STANDARDS.md` (tool bar) · `docs/rules/TESTING-RULES.md` (test bar).

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

## Model
**One model for the whole office** (supervisor + all sub-agents): `gemini-2.5-flash` (env: `AGENT_MODEL`).

The old 6-tier multi-provider cascade was removed in v2. See `src/agents/model.ts` for the current truth.

**503 fallback chain** (capacity spikes only): `gemini-2.5-flash → gemini-2.0-flash → gemini-1.5-flash`.  
Non-503 errors are re-thrown immediately — not silently swallowed.

Temperature: **0 by default** (determinism rule #16). Override with `AGENT_TEMPERATURE` env for creative runs.

## File Locations Quick Reference
```
src/core/registry.ts           — Agent + company definitions
src/core/config.ts             — Env vars + constants
src/agents/office.ts           — Supervisor + all 7 departments (the whole multi-agent system)
src/agents/system-prompts.ts   — All department + supervisor prompts
src/agents/agent-tools.ts      — Barrel re-export (HITL wrappers split into agent-tools/ modules)
src/agents/agent-tools/        — Per-department tool wrappers (hitl, research, comms, engineering, personal, jobhunt, memory)
src/agents/state.ts            — LangGraph Annotation schemas
src/agents/model.ts            — Model factory (one model + 503 fallback)
src/db/schema.ts               — All Drizzle table definitions (11 tables; 4 are SaaS-phase, not active)
src/db/queries.ts              — Named query functions (no raw SQL elsewhere)
src/infra/health.ts            — Health HTTP server (/health, /metrics)
src/infra/redis.ts             — Redis client [SaaS-PHASE: not wired, no boot dep]
src/infra/scheduler.ts         — Cron jobs: Monday brief, HITL sweeper
src/infra/single-instance.ts   — PID-file lock (prevents duplicate bot processes)
src/infra/history-window.ts    — Thread history bounding (prevents loop-from-stale-state)
src/gateway/telegram.ts        — grammy bot + message routing + history trim
src/gateway/commands.ts        — All /command handlers
src/gateway/format.ts          — markdownToTelegramHtml formatter
src/workflows/registry.ts      — SOP workflow definitions
src/workflows/runner.ts        — Pure workflow executor (callback-injected, no grammy)
drizzle/                       — Generated migration SQL (run: npx drizzle-kit migrate)
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

### 14. Safety rails (current state — Phase 2 to complete)
Current send path: `research → draft → [HITL approval] → Composio send → idempotency audit`.
Idempotency via `action_log` is live and prevents duplicate sends.

**Phase 2 additions (not yet wired):**
- `suppression_check` — check `do_not_contact` table before every outbound email (GDPR/CAN-SPAM)
- `quota_check` — call `incrQuota()` from redis.ts to enforce daily send limits
Until these are wired, do not claim they are active safety rails.

### 15. Redis for ephemeral, Postgres for durable (see ADR-005)
- Research cache, send quotas, LLM prompt cache → Redis (TTL, atomic INCR)
- Lead pipeline, suppressions, HITL registry, audit log → Postgres (durable, queryable)

### 16. Determinism + stability (non-negotiable — think like a founder)
The founder relies on this daily. Same input must give the same behaviour, and the
eval harness must be able to prove it.
- **LLM temperature defaults to 0** (`src/agents/model.ts`). Routing and tool-calling
  must be reproducible. Only raise it via `AGENT_TEMPERATURE` for a deliberately
  creative run — never as a default. A non-zero default = unstable routing.
- **Push logic out of the LLM into deterministic code.** Anything that can be a pure
  function (routing keywords, scoring, validation, formatting, parsing) is a pure
  function with unit tests — not a prompt instruction the model may ignore.
- **Eval-gated changes.** Any change that can affect agent behaviour (prompts, tools,
  model, routing) must keep `pnpm test` green and should be checked against
  `pnpm eval` (routing / tool-selection / HITL coverage). Don't regress the golden set.
- **`pnpm lint` stays clean.** No permanent known tsc errors — fix or cast-with-comment
  at the boundary. A red typecheck is a stability liability, not a footnote.
- **Fail loud, fail safe.** External calls surface errors to Telegram; side effects only
  ever run AFTER `interrupt()` approval (rule #3/#4); idempotency before every send (#5).

### 17. Reuse & simplicity-first (adopt before build)
Before writing new code, check: does an existing tool / MCP / agent / pattern already solve this?
Prefer the simplest external tool or reuse of existing code. One engine, many workflows — never
fork a parallel product when a new department + prompt will do.

**Feature triple-filter (mandatory before any new feature):** a feature ships only if it
simultaneously:
1. **Produces a real outcome** (revenue, an interview, hours saved, a client, a validated story)
2. **Closes a named 2026 AI/agent engineering hiring gap** (eval harness · HITL · cost control ·
   MCP · RAG · production observability)
3. **Is mostly reuse** of existing code, tools, or adopted OSS (not a net-new subsystem)

If a feature doesn't pass all three, defer it. See ADR-014 and `docs/study/IDEATION-AND-MARKET-RESEARCH.md`.

### 18. Memory is the single source of truth — always keep it current (non-negotiable)
FounderOS is the single source of truth for both `turicks-brain` (business/portfolio knowledge)
and `personal-rag` (career/personal knowledge). Going forward, **every working session, decision,
and capability change must be written back into the memory tiers** — not left only in chat history
with the assistant. The chat is ephemeral; the databases are durable. If the next session would
have to rediscover it, it belongs in the DB.

**Always update, at the end of any session that changed state:**
1. **`turicks-brain`** — run `pnpm brain:sync` after any new/edited doc (ADR, phase doc, study doc,
   brand, strategic vision). This upserts `docs/**` into the `knowledge_entries` table.
2. **Episodic/conversation memory** — significant decisions, outcomes, and session summaries go into
   the `episodic_memory` / `conversations` tables (via the `record_event` tool in-app, or directly
   when working through the assistant). This is what makes "what did we decide about X?" answerable.
3. **`personal-rag`** — when we ship something that is a career/portfolio signal (a new subsystem,
   a shipped feature, a metric, a launched product), update the FounderOS portfolio brief and
   re-ingest: `cd ~/Projects/personal-rag && python scripts/ingest_local_docs.py`. **Boundary
   (ADR-013/015): personal-rag and turicks-brain stay separate stores — never cross-write.**
4. **`MEMORY.md`** — the fast scannable index for the next session (status, gotchas, file locations).

This rule operationalizes the founder's directive: "everything I do with the assistant must be
done with FounderOS, so it becomes the single source of truth." See ADR-016 and
`docs/superpowers/specs/2026-06-04-memory-system-design.md`.

### 19. Test the REAL path, reproduce before fixing, verify live (non-negotiable)
The most damaging bugs this project hit (wedged-interrupt loop, duplicate bot instances, stale-reply
display) all PASSED the unit/eval suite while FAILING in production — because the tests exercised the
office invoker directly and never touched the real Telegram gateway run-loop. A green suite is
necessary, not sufficient. Going forward:

1. **Reproduce before you fix (systematic debugging).** For any reported bug, write a probe or a
   failing test that reproduces it on the REAL code path (gateway → office → HITL → reply), not a
   mock. If you can't reproduce it, you don't understand it yet — keep digging. No fix without a
   red repro first.
2. **Every bug gets a regression test.** The repro becomes a permanent test so the class of bug can
   never silently return. Pure logic (slicing, guards, routing, parsing) must be a pure function with
   a unit test — never a prompt instruction the model may ignore (rule #16).
3. **Test the gateway loop, not just the invoker.** The run-loop in `telegram.ts` (interrupt guard,
   per-turn message slicing, resume idempotency, history bounding) is the highest-risk code. It must
   have direct unit tests with a fake office; do not rely on the eval harness to catch gateway bugs.
4. **Verify live after every behaviour change.** `pnpm test` green → tsc/lint clean → restart the bot
   (single-instance lock makes this safe) → exercise the actual change over a real path (probe script
   or Telegram) → confirm 0× 409 and the expected behaviour in `/tmp/founderos.log`. "Tests pass" is
   not "it works."
5. **Fail loud, never silent.** Tool errors surface to the founder; a swallowed error or a generic
   "Done." that hides a failure is a P0. If a department couldn't complete a task, the reply says so.

6. **The Bot API is NOT the founder — only MTProto is.** Driving QA with curl + the Telegram Bot
   API tests nothing for HITL: `sendMessage` posts *as the bot* (never re-ingested), and
   `answerCallbackQuery` cannot *originate* a button tap. To drive the genuine gateway as the
   founder — send AND tap Approve/Reject — use the MTProto harnesses. A green unit/eval suite never
   substitutes for this on any HITL path.

Reusable harnesses (in priority order for real-path verification):
- `scripts/e2e-telegram-qa.ts` — the full founder-simulation QA suite (22 tasks: read · write ·
  multi-step · adversarial · crash-recovery) over the REAL gateway via MTProto. Captures the exact
  bot reply + the real `action_log` row per task. `run [all|groupN|TNN] [--approve]`, `park`/
  `approve-last` for crash-recovery, `audit`/`read` for evidence. Needs a one-time founder MTProto
  login (see `telegram-tester.ts login`).
- `scripts/telegram-tester.ts` — single send/approve/reject/read over the same MTProto path.
- `scripts/probe-real-task.ts` — runs arbitrary tasks through a fresh office (invoker level) and dumps
  the full message trail + every tool call. Faster, but bypasses grammy — use for office/tool logic,
  not for gateway-loop bugs.

Evidence standard for any "it works" claim: the exact bot reply text PLUS the matching `action_log`
row (or an explicit NO ROW). A friendly "✅ Done." with no audit row is a FAIL. See
`docs/rules/TESTING-RULES.md` Rules 11–14.

### 20. Context isolation — no leakage across any graph boundary (non-negotiable)
The founder's directive ("context leakage shouldn't be from anywhere") is enforced structurally,
not by hope. See ADRs 021–025.
- **Only synthesized results cross a boundary.** The supervisor uses `outputMode:"last_message"`
  (pinned explicitly in `office.ts`) — a department's internal tool calls/results NEVER propagate
  up to the supervisor's history. Same rule holds for any nested sub-supervisor (`revenue-domain.ts`).
  Never switch to `"full_history"`.
- **Trim the suffix, preserve the prefix.** The system+capability-manifest prefix is the
  cacheable, byte-stable head (Gemini 2.5 Flash implicit caching, ≤75% off ≥1024-tok prefixes).
  Trimming bounds the history *suffix* (`context-manager.ts`); never inject per-turn volatile data
  (date, founder_context) ahead of the stable prefix. Implicit caching is the token lever — NO Redis,
  NO explicit caching (tool-incompatible). ADR-021/024.
- **Measured, not claimed.** Per-turn `inputTokens`/`outputTokens`/`usd` are logged on the
  `turn.out` seam (greppable by `turnId`). "Better than openclaw/hermes" = evidence from the budget
  tracker, not a slogan. (`cached_content_token_count` is unavailable until the google-genai adapter
  upgrade — deferred; `scripts/probe-implicit-cache.ts` re-measures after.)

### 21. Typed inter-department handoffs — never raw message dumping (non-negotiable)
- Cross-department handoffs travel as **typed objects validated at the boundary**, not prose the
  next department re-parses. `src/agents/contracts.ts` = one Zod contract per `dept_signals`
  `event_type`; `validateSignalPayload` (deterministic, never throws) gates every payload before it
  is persisted/acted on. Add an event → add its contract (the registry test enforces parity). ADR-022.
- **Least-context-by-default:** only a contract's declared fields cross a boundary — nothing more.
- **Generator ≠ critic (rule #6, now real in code).** Outbound copy passes gate 1 (deterministic
  `brand-validator`) then gate 2 (Claude judge, `src/infra/judge.ts`) — a different model family from
  the Gemini drafter, so the critic can't rubber-stamp its own output. The judge is **fail-open**
  (HITL is the final human gate; it can only add a critique, never silently block). Needs
  `ANTHROPIC_API_KEY`; absent → no-op pass. ADR-023.

## Engineering Protocol — Verification-First (PERMANENT, applies to every change)

Unit tests are not proof. They are a safety net, not evidence that a feature works.
For EVERY feature or fix in this repo, the definition of done is:

1. **Build it.**
2. **Exercise the REAL runtime path end-to-end** — drive it the way the user actually
   would (through the live Telegram bot, the real graph, real model calls, real Postgres).
   Never declare something working off the back of a unit test alone.
3. **Show the real output as evidence** — the actual bot reply, the actual audit-log row,
   the actual converted file, the actual log lines. No "this should work."
4. **Test incrementally** — after each meaningful change, re-exercise that path before
   moving to the next change. Do not stack three untested changes and verify at the end.
5. **If it fails, fix it and re-run the same test.** Only move on when the live path passes.
6. **A small integration check after every change is mandatory**, not optional — this was
   skipped historically and it is the single biggest source of unreliability in this project.

If you cannot verify something live (missing key, no device), say "NOT VERIFIED — reason"
and do not count it as done.
