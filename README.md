# FounderOS

**Your AI operating system — message it in Telegram, it does the real work.**

FounderOS is a multi-agent system that runs your business via Telegram. A prebuilt LangGraph supervisor routes each request to the right department; specialists use real tools to take real actions; nothing leaves without your approval.

Built by [Pushkar Verma](https://turicks.com) to run Turicks (AI agency) and Naggar Retreat.

---

## What it does

```
You:  "Research what Linear does and send them an intro email"

Bot:  [research agent searches web → returns summary]
      [comms agent drafts the email]

      📧 Send email to contact@linear.app?
      Subject: Turicks × Linear — AI workflow automation
      [full email preview]

      ✅ Approve    ❌ Reject

You:  ✅ Approve

Bot:  ✅ Email sent to contact@linear.app
```

Every write action — emails, LinkedIn posts, GitHub writes — pauses and shows you the content first. You approve or reject. No surprises, nothing sent by accident.

---

## Architecture

```
Telegram message
   ↓
Supervisor (Chief of Staff — Gemini Flash)
   ├── research      → search_web                         (read-only, instant)
   ├── comms         → send_email*, linkedin_post*        (approval required)
   └── engineering   → github_read, github_write*         (approval required)
         (* write tools call interrupt() — graph pauses, you approve, tool runs)
```

Built with:
- **LangGraph JS** — `createSupervisor` + `createReactAgent` prebuilts
- **Native HITL** — `interrupt()` + `Command({ resume })`, crash-safe via Postgres checkpointer
- **Gemini 2.5 Flash** — single model for all agents (fast, cheap, strong tool-calling)
- **Node 22 + TypeScript strict** — ES modules throughout

---

## Quick Start

```bash
# 1. Install
pnpm install

# 2. Configure
cp .env.example .env
# Fill in: DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
#          GOOGLE_GENERATIVE_AI_API_KEY, COMPOSIO_API_KEY, FIRECRAWL_API_KEY

# 3. Start Postgres
docker compose up -d postgres

# 4. Set up DB
node --env-file=.env --import tsx/esm scripts/setup-db.ts

# 5. Run
pnpm dev

# 6. Test
pnpm test
```

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | ✅ | Postgres — state + audit log (`postgresql://turicks:turicks@localhost:5432/turicks`) |
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot polling |
| `TELEGRAM_CHAT_ID` | ✅ | Your Telegram chat/DM ID |
| `GOOGLE_GENERATIVE_AI_API_KEY` | ✅ | Gemini Flash — all agents use this |
| `COMPOSIO_API_KEY` | Email + LinkedIn | Composio action execution |
| `FIRECRAWL_API_KEY` | Web search | Firecrawl search API |
| `GITHUB_TOKEN` | GitHub writes | Classic PAT with `repo` scope |
| `AGENT_MODEL` | Optional | Override model (default: `gemini-2.5-flash`) |
| `FOUNDER_TENANT` | Optional | Tenant name (default: `turicks`) |
| `LANGCHAIN_API_KEY` | Optional | LangSmith tracing |
| `LANGCHAIN_TRACING_V2` | Optional | Set `true` to enable LangSmith |

---

## Commands

```bash
pnpm dev          # Start with hot reload (tsx watch)
pnpm test         # Run full test suite
pnpm eval         # Run the agent eval harness → writes EVAL.md (live LLM calls)
pnpm lint         # TypeScript type check (npx tsc --noEmit)
pnpm build        # Compile to dist/
pnpm db:generate  # Generate Drizzle migrations after schema changes
pnpm db:migrate   # Apply migrations to DB
```

---

## Project Structure

```
src/
  index.ts                   Boot: telemetry → office → health → Telegram
  agents/
    office.ts                The entire multi-agent system (80 lines)
    agent-tools.ts           LangChain tools with HITL interrupt() gates
    model.ts                 Single Gemini Flash model factory
    system-prompts.ts        One prompt per role (4 prompts total)
  tools/
    web-search.ts            Firecrawl search (read-only, no approval)
    email.ts                 Composio Gmail (approval-gated)
    github.ts                Octokit — read instant, write approval-gated
    linkedin.ts              Composio LinkedIn (approval-gated)
  gateway/
    telegram.ts              grammy bot: route → approval cards → resume
  db/
    schema.ts                action_log, do_not_contact + LangGraph tables
    queries.ts               Named query functions (no raw SQL elsewhere)
  infra/
    checkpointer.ts          Postgres saver singleton (crash-safe HITL)
    telemetry.ts             LangSmith tracing init
    health.ts                /health + /metrics endpoints
    logger.ts                pino structured logging

docs/
  study/                     Learn how multi-agent systems work (start here ↓)
    01-what-is-multi-agent-orchestration.md
    02-langgraph-patterns.md
    03-v1-to-v2-migration.md
    04-how-founderos-works.md
  decisions/                 Architecture Decision Records
  ROADMAP.md                 Future departments, SaaS pivot plan
  OPERATIONS.md              Day-to-day usage guide

tests/
  integration/
    office-hitl.test.ts      Key test: approve→send, reject→no-send
  unit/                      Component unit tests
```

---

## How Approvals Work

```
1. Agent decides to call a write tool (send_email, github_write, linkedin_post)
2. Tool calls interrupt({ title, preview, args }) → graph PAUSES
3. State saved to Postgres — survives a process restart
4. Telegram shows Approve/Reject card with full preview
5. Tap Approve → graph.invoke(Command({ resume: "approved" }))
6. Same tool continues from interrupt() → executes the real action
7. Tap Reject → tool returns rejection message, nothing sent
```

The key guarantee: the tool runs after approval — not a separate finalize step. "Approve → nothing happens" is structurally impossible.

---

## Adding a Department

Three files, ~15 lines:

**1. `src/agents/agent-tools.ts`** — add tools with `tool()` + `interrupt()` for write actions

**2. `src/agents/system-prompts.ts`** — add `export const SALES_PROMPT = \`...\``

**3. `src/agents/office.ts`** — four lines:
```typescript
const sales = createReactAgent({ llm, tools: [searchWeb, sendEmail], name: "sales", prompt: SALES_PROMPT });
// add `sales` to agents: [..., sales] in createSupervisor
```

**4.** Update `SUPERVISOR_PROMPT` to mention the new department.

---

## Key Design Decisions

| Decision | Why |
|----------|-----|
| Single Gemini Flash model | One model with good tool-calling > 8 tiers with routing overhead |
| `createSupervisor` prebuilt | LangGraph ships this — no custom routing needed |
| `interrupt()` for HITL | Native, crash-safe, no extra DB table needed |
| Tools do the sending | Approval gates the tool — not a separate finalize node |
| One thread per chat | Conversation memory persists; approvals go to the right run |
| `includeAgentName: "inline"` | Gemini rejects `name` attribute on messages; inline embeds it in content |

Full history: `docs/study/03-v1-to-v2-migration.md` — how we went from 10,678 LOC that couldn't send an email to ~500 LOC that can.

---

## Tests

```bash
pnpm test                                                          # all 210 tests
npx vitest run tests/integration/office-hitl.test.ts               # core HITL proof
npx vitest run tests/live/                                         # real API round-trips
```

---

## Evaluation

A deterministic eval harness measures the multi-agent system against a fixed
golden-task set (`src/eval/golden-tasks.ts`) — the regression baseline for agent
behaviour. Each task scores three things:

- **Routing accuracy** — did the supervisor hand off to the right department?
- **Tool selection** — did that department use the expected tools?
- **HITL coverage** — did every write action pause for approval when required?

```bash
pnpm eval        # runs the golden set through the live office → writes EVAL.md
```

The scorer, report renderer, and runner are pure and fully unit-tested with a
deterministic stub invoker (zero LLM cost); `pnpm eval` swaps in the real office
graph. The runner observes each run only up to the approval pause and **never
approves**, so no email / post / GitHub write fires during an eval. See
`src/eval/` and `docs/decisions/011-portfolio-as-product-and-eval-harness.md`
(why an eval harness over a critic).

---

## Stack

- **Runtime:** Node 22, TypeScript 5.5 strict, ES modules
- **AI:** LangGraph JS 0.2.74, langgraph-supervisor 0.0.20, Google GenAI (Gemini), LangChain
- **Bot:** grammy (Telegram long-polling)
- **DB:** Drizzle ORM + PostgreSQL (via Docker in dev)
- **Tools:** Composio (email + LinkedIn), Firecrawl (search), Octokit (GitHub)
- **Infra:** pino logging, LangSmith tracing, Hono health server
- **Tests:** Vitest

---

## Learn More

| What | Where |
|------|-------|
| What is multi-agent orchestration? | `docs/study/01-what-is-multi-agent-orchestration.md` |
| LangGraph patterns used here | `docs/study/02-langgraph-patterns.md` |
| Why we rebuilt from v1 | `docs/study/03-v1-to-v2-migration.md` |
| How to read the codebase | `docs/study/04-how-founderos-works.md` |
| Future plans | `docs/ROADMAP.md` |
| Daily usage | `docs/OPERATIONS.md` |

---

*Turicks — AI that actually does things.*
