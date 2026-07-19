# FounderOS

**A deterministic agent kernel that takes real business actions — safely, and without hallucinating that it did.**

FounderOS is a contract-first orchestration kernel with a Telegram gateway. You send a task; a planner turns it into a **typed, validated Plan**; a pure-code supervisor dispatches each step to an isolated worker; every external action produces a **code-recorded receipt**; and the reply is synthesized **only from validated results**. Nothing is sent or changed without your explicit approval, and the system can only claim an action happened if a receipt proves it did.

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.json)
[![Node](https://img.shields.io/badge/Node-22-339933.svg)](package.json)
[![LangGraph](https://img.shields.io/badge/LangGraph-StateGraph-orange.svg)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 📚 **Engineering docs** → [docs/README.md](docs/README.md) · **The v1→v2→v3 story** (how we escaped our own AI slop) → [docs/turicks-case-studies/](docs/turicks-case-studies/)

---

## What it does

```
You → Telegram:  "Research what Linear ships, then draft a cold email to their founder."

FounderOS:       plan  → [1] research.search_web   [2] sales.draft_email
                 step 1 → worker runs search, records a ToolReceipt (query, results, cost)
                 step 2 → worker drafts from step-1 results only

                 📧 Send email to founder@linear.app?
                 Subject: Turicks × Linear — 3-day AI workflow build
                 ─────────────────────────────────────────────
                 Hey Karri, saw Linear's agent API announcement last week...
                 ✅ Approve   ❌ Reject

You:             ✅ Approve

FounderOS:       ✅ Sent (idempotent — a retry can never double-send)
                 Receipts: search_web ✓ · send_email ✓ (msg-id captured)
```

Every write action — email, LinkedIn post, GitHub commit, shell command, file write — pauses at a Postgres-checkpointed `interrupt()` and shows you exactly what it will do. If the process crashes mid-approval, the pending action survives the restart.

---

## Architecture (v3 — contract-first, one orchestration path)

```
message
   │
   ▼
 plan ........ LLM #1 → PlannerDecision: a direct reply, OR a typed Plan
   │
   ▼
 dispatch .... PURE CODE supervisor: plan[cursor] → TaskEnvelope
   │
   ▼
 agent ⇄ tools worker: isolated envelope-only context, capped tools,
   │            code-recorded ToolReceipts, HITL interrupt() inside gated tools
   ▼
 collect ..... PURE: StepResult validated against OUTPUT_CONTRACTS
   │
   … cursor++ … repeat per step …
   │
   ▼
 synthesize .. LLM #2: sees validated results ONLY → reply + receipts block
```

**The contracts are the architecture.** Every boundary in the diagram is a Zod-validated type in [`src/kernel/contracts.ts`](src/kernel/contracts.ts) — `TaskEnvelope`, `Plan`, `StepResult`, `FailureReport`, `ToolReceipt`. A mismatch is a *terminal, typed failure* — never a retry-and-hope.

| Property | Mechanism |
|---|---|
| **Zero-hallucination** | Action claims require a successful receipt (`validateStepResult`); the synthesizer only ever sees validated results. |
| **Crash-safe HITL** | DB row written **before** `interrupt()`; side effects run only after approval; idempotency key checked before every external send; audit row only on real success. |
| **Failures name the real component** | `FailureReport = stage + component + evidence + retryable`. The founder always sees them; threads are never silently wiped. |
| **Determinism** | Temperature 0; routing/parsing/guards are pure unit-tested functions, never prompt instructions. CI runs the golden set twice — plans must be byte-identical. |
| **The kernel is a library** | Models, tools, and checkpointer are injected. [`src/gateway/kernel-boot.ts`](src/gateway/kernel-boot.ts) is the only composition root. The full graph runs offline in CI at **$0**. |

### Anti-slop invariants (CI-enforced — `scripts/verify-architecture.ts`)

The v2 system decayed because nothing stopped complexity from creeping back. v3 enforces five machine-checked rules:

1. **Tombstones** — killed modules (`office-run`, `pre-router`, `execution-guard`, `office.ts`, domain subgraphs) **fail CI if re-created**.
2. **Ratchet** — architecture debt (`governance/architecture-baseline.json`) may only shrink. Current: regex-routing `0`, gateway-imports `0`, kernel-purity `0`.
3. **Import direction** — `contracts ← kernel ← gateway`; the kernel may import only kernel/core/db/infra/tools.
4. **LOC budget** — no `src` file over 400 lines.
5. **Fail-open catches** need an explicit `// allow-failopen: <reason>` tag.

---

## Why v3 exists (the honest version)

v1 was a large hand-rolled orchestrator. v2 replaced it with a LangGraph `createSupervisor` + 7 ReAct departments and *felt* modern — but it lost complex tasks within three steps: a 9-regex pre-router mutated the task before any agent saw it, departments received empty-argument handoffs and re-inferred the task from a trimmed history, and a ~77-regex "execution guard" attacked the system's own output — sometimes wiping the Postgres thread as "recovery."

v3 is the response: a plan is a **typed object**, a handoff is a **validated `TaskEnvelope`**, an action is a **receipt**, and a failure is a **`FailureReport` that names the stage and component**. The full autopsy and rebuild rationale live in [`ZERO-BASE-AUDIT.md`](ZERO-BASE-AUDIT.md) (4 live failure traces) and [`JARVIS-ARCHITECTURE.md`](JARVIS-ARCHITECTURE.md). The narrative, marketing-ready version — including where we fell for AI slop and how we dug out — is in [docs/turicks-case-studies/](docs/turicks-case-studies/).

---

## Quick start

```bash
git clone https://github.com/pushkarverma3698/FounderOS.git
cd FounderOS
pnpm install

cp .env.example .env
# Minimum: DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
#          GOOGLE_GENERATIVE_AI_API_KEY

docker compose up -d postgres        # Postgres (+ pgvector, ollama in the prod-parity compose)
pnpm setup                           # apply schema
pnpm dev                             # run the bot
```

### Commands

```bash
pnpm dev / build / start        # run
pnpm test                       # deterministic suite ($0, scripted models)
pnpm lint && pnpm verify:arch   # types + anti-slop gates
pnpm gate                       # full merge gate (lint + build + wiring + arch + test)
pnpm eval                       # live golden-set eval (milestone gate, paid — run once per feature)
pnpm qa:telegram                # 22-task MTProto founder-simulation (production acceptance)
pnpm proof:scoreboard           # regenerate docs/PROOF.md from a fresh run
```

`pnpm test` is **$0** — the kernel runs the full graph offline with scripted models. Live LLM calls happen only at the `pnpm eval` / `pnpm qa:telegram` milestone gates. See [docs/PROOF.md](docs/PROOF.md) for the current, regenerable scoreboard (deterministic suite + kernel guarantees + the debt ratchet).

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Orchestration | [LangGraph JS](https://github.com/langchain-ai/langgraphjs) `StateGraph` (no prebuilt supervisor) | One explicit graph; the supervisor is pure code, not an LLM. |
| LLM | Gemini Flash (`google-genai:gemini-flash-latest`), temp 0 | Fast, cheap, tool-calls cleanly on-box. Fallback chain in [`src/agents/model.ts`](src/agents/model.ts). |
| Checkpointer | `@langchain/langgraph-checkpoint-postgres` | Crash-safe HITL, thread-per-conversation state. |
| Gateway | [grammY](https://grammy.dev/) | Telegram transport; inline Approve/Reject keyboards. |
| Database | PostgreSQL + [Drizzle ORM](https://orm.drizzle.team/) | Type-safe queries, migration-based schema (22 tables across the `agents` + `brain` schemas). |
| Language | TypeScript strict + Node 22 ESM | End-to-end type safety. |
| External surface | [MCP](https://modelcontextprotocol.io/) server (read-only) | `src/mcp/` exposes read tools without a write path. |

---

## Repository map

```
src/kernel/              contracts, signals, state, planner, supervisor (pure),
                         worker, synthesizer, graph, tool-adapter, verify, index
src/gateway/
  kernel-boot.ts         composition root (models + tools + checkpointer → kernel)
  kernel-run.ts          run loop: lock → gates → invoke → HITL card / reply
  telegram.ts            grammY transport;  commands.ts — the essential commands
src/agents/              worker prompts, agent-tools/ (LangChain wrappers),
                         capabilities.ts, model.ts (status-class error taxonomy)
src/tools/               UnifiedTool implementations (ToolResult envelope)
src/infra/               hitl, checkpointer, budget, daily-budget, trace, health
src/db/                  schema (19 tables) + queries
src/eval/                golden tasks, runner, scoring, kernel-invoker
src/mcp/                 read-only MCP server
video-factory/           standalone client social-video engine (not in the workspace)
```

Full details and non-negotiable engineering rules: [CLAUDE.md](CLAUDE.md).

---

## Built by

[Pushkar Verma](https://turicks.com) — building FounderOS to run [Turicks](https://turicks.com), an AI-native studio that ships working software in days, not decks. FounderOS is both the operator *and* the proof.

## License

MIT — see [LICENSE](LICENSE)
