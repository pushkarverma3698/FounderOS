# FounderOS

**A production-grade multi-agent AI system that takes real business actions — safely.**

FounderOS runs your agency, handles your inbox, posts to LinkedIn, manages GitHub, and operates your laptop — via Telegram. A LangGraph supervisor routes each message to the right department; specialist agents do the real work with real tools; and **nothing leaves without your explicit approval**.

[![CI](https://github.com/pushkarverma3698/FounderOS/actions/workflows/ci.yml/badge.svg)](https://github.com/pushkarverma3698/FounderOS/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5_strict-3178c6.svg)](tsconfig.json)
[![LangGraph](https://img.shields.io/badge/LangGraph-JS_0.2.74-orange.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-730_passing-brightgreen.svg)](tests/)

---

## What it does

```
You → Telegram:  "Research what Linear does and draft a cold email to their founder"

FounderOS:       [sales agent searches web → finds specific hook → drafts email]

                 📧 Send email to linear-founder@linear.app?
                 Subject: Turicks × Linear — 3-day AI workflow build
                 ─────────────────────────────────────────────
                 Hey Karri,
                 Saw Linear's agent API announcement last week...
                 [full 147-word email, under the 150-word ICP rule]

                 ✅ Approve   ❌ Reject

You:             ✅ Approve

FounderOS:       ✅ Email sent (idempotent — won't re-send if you retry)
```

Every write action — email, LinkedIn post, GitHub commit, shell command, file write — pauses and shows you exactly what it's about to do. You approve or reject. If the process crashes mid-approval, the pending action survives a restart (Postgres-checkpointed).

---

## Architecture

```
Telegram message
        │
        ▼
┌───────────────────────────────────────────────┐
│  Supervisor  (Chief of Staff — Gemini Flash)  │
│  · read_context / update_context              │
│  · routes to exactly ONE department per turn  │
└───────────┬───────────────────────────────────┘
            │
    ┌───────┴────────────────────────────────────────────────┐
    │                                                        │
    ├── research      search_web · search_knowledge          │ read-only
    │                 read_emails                            │ instant
    ├── comms         send_email* · linkedin_post*           │
    ├── engineering   github_read · github_write*            │ * = HITL
    ├── marketing     search_web · linkedin_post*            │   gated
    ├── sales         search_web · send_email*               │
    ├── prospecting   search_web · search_knowledge          │
    └── personal      read_file · list_dir                   │
                      write_file* · run_shell*               │
                      browser*                               │
```

**Production hardening (the layer most agent projects skip):**

| Property | Implementation |
|---|---|
| **Crash-safe HITL** | `interrupt()` + Postgres checkpointer — pending approvals survive restarts |
| **Idempotency** | SHA-1 key before every email/post/push — same action can never fire twice |
| **Path-guard** | `$HOME`-confined file access; `.ssh`, `.env`, `*.pem`, `/etc` blocked even on read |
| **Determinism** | Temperature = 0; routing logic in pure code, not prompt instructions |
| **Eval harness** | 13 golden tasks, reproducible `pnpm eval` → `EVAL.md` with routing/tool/HITL scores |
| **Brand validator** | Banned-phrase check before every LinkedIn post and outreach email |
| **Context manager** | Rolling 6K-token window — no context overflow on long conversations |
| **Audit log** | Every action written to Postgres `audit_log` table with tenant + idempotency key |

---

## Eval results

| Metric | Score | Date |
|---|---|---|
| Routing accuracy | **23/24 — 96%** | 2026-06-08 |
| Tool selection | **20/20 — 100%** | 2026-06-08 |
| HITL coverage | **21/23 — 91%** | 2026-06-08 |
| **Overall** | **88%** | 2026-06-08 |

Methodology: golden tasks run at temperature 0 via `pnpm eval` against a live office with a
MemorySaver checkpointer. No approvals fire (HITL is observed, not executed). See [`EVAL.md`](EVAL.md).

> Metrics auto-updated by CI on every merge to main.

---

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/pushkarverma3698/FounderOS.git
cd FounderOS
pnpm install

# 2. Configure
cp .env.example .env
# Edit .env — minimum required:
#   DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
#   GOOGLE_GENERATIVE_AI_API_KEY (or ANTHROPIC_API_KEY)
#   COMPOSIO_API_KEY + COMPOSIO_GMAIL_CONN_ID, COMPOSIO_GMAIL_USER_ID
#   COMPOSIO_LINKEDIN_CONN_ID, COMPOSIO_LINKEDIN_USER_ID
#   FIRECRAWL_API_KEY

# 3. Start Postgres + Redis
docker compose up -d postgres redis

# 4. Set up database schema
node --env-file=.env --import tsx/esm scripts/setup-db.ts

# 5. Run
pnpm dev

# 6. Test
pnpm test

# 7. Eval (requires live Postgres + LLM API key)
pnpm eval
```

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Agent orchestration | [LangGraph JS](https://github.com/langchain-ai/langgraphjs) `createSupervisor` + `createReactAgent` | Stateful graphs, native `interrupt()` HITL, Postgres checkpointing |
| LLM | Gemini 2.5 Flash (primary) | Fast, cheap, excellent tool-calling |
| Checkpointer | Postgres via `@langchain/langgraph-checkpoint-postgres` | Crash-safe HITL, thread-per-conversation state |
| Integrations | [Composio](https://composio.dev/) | Managed OAuth for Gmail, LinkedIn, GitHub, Instagram |
| Web search | [Firecrawl](https://firecrawl.dev/) | Deep scraping beyond Google snippets |
| Tracing | [LangSmith](https://smith.langchain.com/) | Step-level traces, per-span cost, eval experiments |
| Database | PostgreSQL + [Drizzle ORM](https://orm.drizzle.team/) | Type-safe queries, migration-based schema |
| Cache | Redis | Research cache (24h TTL), send quotas, LLM cache (6h TTL) |
| Gateway | [grammY](https://grammy.dev/) Telegram bot | Async handlers, inline keyboards for Approve/Reject |
| Language | TypeScript 5.5 strict + Node 22 ESM | End-to-end type safety |

---

## Repository structure

```
src/
├── agents/
│   ├── office.ts          # Compiled once: supervisor + 7 ReAct departments
│   ├── agent-tools.ts     # LangChain tool wrappers with HITL interrupt()
│   ├── system-prompts.ts  # All prompts (supervisor + 7 departments)
│   └── model.ts           # Model factory — temperature 0, Gemini Flash
├── tools/
│   ├── web-search.ts      # Firecrawl wrapper
│   ├── email.ts           # Composio Gmail send
│   ├── email-reader.ts    # Composio Gmail read
│   ├── github.ts          # Octokit GitHub read/write
│   ├── linkedin.ts        # Composio LinkedIn post
│   ├── personal.ts        # File / shell / browser (path-guarded)
│   ├── context.ts         # Persistent business context store
│   └── knowledge.ts       # Internal knowledge search
├── infra/
│   ├── path-guard.ts      # Pure path safety — 19 unit tests, blocks secrets on read
│   ├── brand-validator.ts # Banned-phrase + channel-spec enforcer
│   ├── context-manager.ts # Rolling-window token trimmer
│   ├── checkpointer.ts    # TenantAwareCheckpointer (thread-per-tenant)
│   ├── composio.ts        # Composio helper (env-only, no hardcoded credentials)
│   └── telemetry.ts       # LangSmith PII scrubber + tracer
├── eval/
│   ├── golden-tasks.ts    # 13 golden tasks (routing · tool · HITL assertions)
│   ├── runner.ts          # Deterministic runner — never approves, observes via callback
│   ├── scoring.ts         # Pure scoring functions
│   └── report.ts          # Markdown report generator → EVAL.md
├── gateway/
│   ├── telegram.ts        # grammY bot + topic routing + Approve/Reject callbacks
│   └── hitl.ts            # HITL interrupt lifecycle
└── db/
    ├── schema.ts          # Drizzle table definitions
    └── queries.ts         # Named query functions (no raw SQL elsewhere)
```

---

## Architecture decisions

Key decisions documented as ADRs in [`docs/decisions/`](docs/decisions/):

| ADR | Decision |
|---|---|
| [001](docs/decisions/001-why-langgraph.md) | LangGraph JS over CrewAI / AutoGen — stateful graphs, native HITL |
| [002](docs/decisions/002-why-drizzle.md) | Drizzle ORM — type-safe, migration-based, no ORM magic |
| [004](docs/decisions/004-why-telegram-hitl.md) | Telegram as HITL gateway — inline keyboards, crash-safe via checkpointer |
| [010](docs/decisions/010-v2-react-agent-rebuild.md) | v2 rebuild: 10,678 LOC → ~500 LOC via prebuilt supervisor + ReAct |
| [011](docs/decisions/011-portfolio-as-product-and-eval-harness.md) | Eval harness over self-critique node — deterministic, reproducible |
| [012](docs/decisions/012-personal-department.md) | Personal laptop operator: AppleScript browser, path-guard, HITL on every write |
| [013](docs/decisions/013-keep-personal-and-engineering-separate.md) | Keep personal ≠ engineering — least privilege, blast radius, OWASP/Sophos/CAF |

---

## How HITL works

```
Agent calls tool (e.g. send_email)
    │
    ├── [BEFORE interrupt()] Build approval payload: title, summary, preview, args
    │
    ├── interrupt({ kind: "approval", ... })
    │       │
    │       ▼  LangGraph pauses the graph here.
    │           State checkpointed to Postgres. Process can crash — no data lost.
    │
    │   Telegram delivers an approval card:
    │       "📧 Send email to alex@acme.com?"
    │       [Subject + full body preview]
    │       [✅ Approve] [❌ Reject]
    │
    ├── Founder taps ✅ Approve
    │       │
    │       ▼  Graph resumes. interrupt() returns "approved".
    │
    ├── [AFTER interrupt()] Side effects run:
    │       - suppression_check (do-not-contact list)
    │       - emailTool.execute(idempotency_key, ...)
    │       - audit_log write
    │
    └── "✅ Email sent to alex@acme.com"
```

Key invariant: **all side effects run AFTER `interrupt()` returns**. Code before the interrupt runs twice (on pause and on resume) — it must be pure.

---

## Running tests

```bash
pnpm test:unit      # Unit tests only (no API keys required)
pnpm test:integration  # Integration tests (needs GOOGLE_GENERATIVE_AI_API_KEY)
pnpm test           # All 730+ tests
pnpm eval           # Deterministic golden-task eval → EVAL.md (needs live Postgres + LLM key)
pnpm lint           # TypeScript typecheck
```

---

## What's next

Build-in-public roadmap (each on its own branch → PR):

1. **Budget guard** — per-run token/$ cap, breach → Telegram alert, extract as `@founderos/budget-guard` npm
2. **MCP server** — expose FounderOS tools via Model Context Protocol (Claude Code / Cursor can drive it)
3. **Job-Hunt department** — reads your CV, researches the company, HITL-drafts tailored applications
4. **Real RAG** — pgvector + `ts_tsvector` hybrid search over the knowledge base

Follow the build at [turicks.com](https://turicks.com) or [LinkedIn](https://www.linkedin.com/in/pushkarverma3698/).

---

## Built by

[Pushkar Verma](https://turicks.com) — AI automation engineer. Building FounderOS to run [Turicks](https://turicks.com), an AI-native agency that ships working code (not decks) in 3–5 days.

*"Safe, evaluated, budget-capped agent actions — the production-hardening layer most agent projects skip."*

---

## License

MIT — see [LICENSE](LICENSE)
