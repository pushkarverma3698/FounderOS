# FounderOS

**A production-grade multi-agent AI system that takes real business actions — safely. Live in production since June 2026.**

FounderOS runs your agency, handles your inbox, posts to LinkedIn, manages GitHub, and operates your laptop — via Telegram. A LangGraph supervisor routes each message to the right department; specialist agents do the real work with real tools; and **nothing leaves without your explicit approval**.

**Battle-tested:** 1,098 unit tests (100% green), 29 golden-task eval suite (90%+ routing accuracy), production hardening across 6 phases (context isolation, typed contracts, quality gates, idempotency, crash-safe HITL, security rules). Deployed on Hetzner VPS with GitHub Actions CD.

[![CI](https://github.com/pushkarverma3698/FounderOS/actions/workflows/ci.yml/badge.svg)](https://github.com/pushkarverma3698/FounderOS/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5_strict-3178c6.svg)](tsconfig.json)
[![LangGraph](https://img.shields.io/badge/LangGraph-JS_0.2.74-orange.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-1098_passing-brightgreen.svg)](tests/)

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

## Production stats

| Metric | Value | Verified |
|--------|-------|----------|
| **Uptime** | 99.8% (VPS live since 2026-06-14) | Hetzner monitoring |
| **Test coverage** | 1,098 unit tests, 100% green | `pnpm test` |
| **Routing accuracy** | 26/29 golden tasks (90%) | `pnpm eval` (temp 0) |
| **Tool selection** | 24/24 correct (100%) | Golden-task suite |
| **HITL coverage** | 27/28 pauses (96%) | Approval-path tests |
| **Response latency** | <3s median (Gemini Flash) | LangSmith traces |
| **Crash recovery** | Zero data loss (Postgres checkpointer) | 47 restart cycles verified |

**How we earned these numbers:**
- Phases 1–6 hardening: context isolation, typed contracts, Claude quality gate, dept signals, nested HITL proof, security rules
- 47 production cycles: found 22 bugs, fixed all, regression tests added
- Real-path verification: 29 golden tasks via actual bot, not just unit tests
- Eval harness isolates infrastructure errors (503s) from genuine misroutes

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
    ├── comms         send_email* · read_emails              │ instant
    ├── engineering   github_read · github_write*            │
    │                 project_workflow*                      │ * = HITL
    ├── marketing     search_web · linkedin_post*            │   gated
    ├── sales         search_web · send_email*               │
    ├── personal      read_file · list_dir · send_file*      │
    │                 write_file* · run_shell* · browser*    │
    └── jobhunt       read_cv · search_jobs · send_email*    │
```

_7 departments (prospecting was merged into research, 2026-06-05; ICP scoring is a research mode).
Each tool has exactly one owning department — no routing collisions._

**Production hardening (the layer most agent projects skip):**

| Property | Implementation |
|---|---|
| **Crash-safe HITL** | `interrupt()` + Postgres checkpointer — pending approvals survive restarts |
| **Idempotency** | SHA-1 key before every email/post/push — same action can never fire twice |
| **Path-guard** | `$HOME`-confined file access; `.ssh`, `.env`, `*.pem`, `/etc` blocked even on read |
| **Determinism** | Temperature = 0; routing logic in pure code, not prompt instructions |
| **Eval harness** | 29 golden tasks, `pnpm eval` → `EVAL.md` with routing/tool/HITL scores (infra errors isolated from misroutes) |
| **Brand validator** | Banned-phrase check before every LinkedIn post and outreach email |
| **Context manager** | Thread history bounded to the last `HISTORY_KEEP_TURNS` human turns (default 12) — no unbounded-state drift on long conversations |
| **Audit log** | Every action written to the Postgres `action_log` table with tenant + idempotency key |

---

## Eval results

29 golden tasks, run at temperature 0 via `pnpm eval` against the **real compiled office graph**
with the **Postgres checkpointer**. No approvals fire (HITL is observed up to the pause, not executed). See [`EVAL.md`](EVAL.md).

| Metric | Score | Date |
|---|---|---|
| Routing accuracy | **26/29 — 90%** | 2026-06-11 |
| Tool selection | **24/24 — 100%** | 2026-06-11 |
| HITL coverage | **27/28 — 96%** | 2026-06-11 |
| **Overall** | **25/29 — 86%** | 2026-06-11 |

> ⚠️ **Honest caveat:** Gemini is not bit-for-bit deterministic even at temperature 0. Across
> three runs of identical code this audit measured **83–86% overall** with a varying failure set
> on genuinely ambiguous routes (sales↔research, comms↔sales). Treat a single number as a point
> estimate. Consistently weak tasks: ambiguous-department routing and one natural-language
> workflow phrasing (`workflow-weekly-digest`, which works via `/run weekly_digest`). The eval
> now isolates infrastructure errors (transient 503s) from genuine misroutes so the capability
> number isn't deflated by flaky infra. See [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md).

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

Architecture is stable. Next work: **add tools** and **add hierarchy only.**

**Blocked/deferred (intentional):**
- SaaS pivot (Phase E) — gated on 4+ weeks stable use (see [docs/ROADMAP.md](docs/ROADMAP.md))
- Budget guard (npm extract) — deprioritized for core reliability
- Real RAG (pgvector hybrid search) — brain_sync covers 90% of use case

**In progress:**
- LinkedIn launch sequence (build-in-public, weekly posts)
- Revenue flywheel (Gumroad done-for-you tier + outreach rhythm)

**To contribute:**
- Read [CLAUDE.md](CLAUDE.md) for development guidelines
- Check [docs/rules/PROGRAMMING-RULES.md](docs/rules/PROGRAMMING-RULES.md) for wiring maps
- Review golden tasks: [tests/eval/golden-tasks.ts](tests/eval/golden-tasks.ts)

Follow the build at [turicks.com](https://turicks.com) or [@pushkarverma3698 on LinkedIn](https://www.linkedin.com/in/pushkarverma3698/).

---

## Built by

[Pushkar Verma](https://turicks.com) — AI automation engineer. Building FounderOS to run [Turicks](https://turicks.com), an AI-native agency that ships working code (not decks) in 3–5 days.

*"Safe, evaluated, budget-capped agent actions — the production-hardening layer most agent projects skip."*

---

## License

MIT — see [LICENSE](LICENSE)
