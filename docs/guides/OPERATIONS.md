# FounderOS — Operations Guide

> Day-to-day commands, troubleshooting, and runbook for running FounderOS.

---

## Starting / Stopping

```bash
# Start (runs in background, logs to /tmp/founderos.log)
nohup node --env-file=.env --import tsx/esm src/index.ts > /tmp/founderos.log 2>&1 &
echo $! > /tmp/founderos.pid

# Stop
kill $(cat /tmp/founderos.pid)

# Restart (single-instance lock kills old process automatically)
kill $(cat /tmp/founderos.pid) 2>/dev/null; sleep 2
nohup node --env-file=.env --import tsx/esm src/index.ts > /tmp/founderos.log 2>&1 &
echo $! > /tmp/founderos.pid

# Check if running
cat /tmp/founderos.pid && ps aux | grep src/index
tail -f /tmp/founderos.log
```

**The single-instance lock** (`src/infra/single-instance.ts`) means restarts are safe —
the new process kills the old one automatically. No duplicate polling processes.

---

## Required Services

```bash
# PostgreSQL (must be running before starting the bot)
docker compose up -d postgres

# Redis (optional — bot degrades gracefully if unavailable)
docker compose up -d redis

# Verify Postgres is up
docker ps | grep postgres
```

---

## Environment Variables (.env)

```bash
# Required
DATABASE_URL=postgresql://turicks:password@localhost:5432/founderos
TELEGRAM_BOT_TOKEN=<your bot token>
TELEGRAM_CHAT_ID=<your numeric chat id>
GOOGLE_GENERATIVE_AI_API_KEY=<Gemini key>

# Composio connections (Gmail + LinkedIn + Google Calendar)
COMPOSIO_API_KEY=<key>
COMPOSIO_GMAIL_CONN_ID=ca_nlLqda4MBFaA
COMPOSIO_GMAIL_USER_ID=pg-test-750dbecb-ef9d-4ef7-a76d-d1de1fd0190f
COMPOSIO_LINKEDIN_CONN_ID=ca_CDaqpUfRJ7vl
COMPOSIO_LINKEDIN_USER_ID=turicks-internal
# Google Calendar defaults are hardcoded in composio.ts — set to override:
# COMPOSIO_GCAL_CONN_ID=ca_wbg4nQjAnw9o
# COMPOSIO_GCAL_USER_ID=pg-test-750dbecb-ef9d-4ef7-a76d-d1de1fd0190f

# Optional
FIRECRAWL_API_KEY=<key>   # web search
GITHUB_TOKEN=<PAT>        # GitHub tools
LANGCHAIN_API_KEY=<key>   # LangSmith tracing
LANGCHAIN_TRACING_V2=true
```

---

## Telegram Commands

| Command | What it does |
|---------|-------------|
| `/start` | Welcome message with example tasks |
| `/commands` | Full command list |
| `/status` | System health: Postgres, Redis, services |
| `/reset` | Clear conversation history (fixes stuck context) |
| `/workflows` | List available SOPs |
| `/run <workflow> [key=value]` | Run a multi-step workflow |
| `/q <dept> <task>` | Route directly to a department (bypass supervisor) |
| `/context` | Show current business context |
| `/departments` | What each department does |

**Dept shortcuts for /q:**
```
/q research What is Anthropic's latest model?
/q comms check my unread emails
/q engineering list my GitHub repos
/q marketing draft a LinkedIn post about shipping FounderOS
/q sales cold email the founder of Acme Corp
/q personal list files on my Desktop
/q jobhunt find AI engineer jobs in Amsterdam
```

**Workflows:**
```
/run onboarding company=Acme Corp
/run outbound company=Stripe
/run weekly_digest
```

---

## Running Tests

```bash
pnpm test                    # full suite (562 tests)
pnpm test --reporter=verbose # verbose output
pnpm lint                    # TypeScript type check
pnpm eval                    # live eval against golden tasks (~75s, real model)
```

**Before every PR:** `pnpm test` + `pnpm lint` must both pass.

---

## Database

```bash
# Run migrations
npx drizzle-kit migrate

# Reset conversation history for a chat (when bot is stuck)
psql $DATABASE_URL -c "DELETE FROM checkpoints WHERE thread_id LIKE 'turicks:6775330211%';"

# Sync docs to turicks-brain knowledge base
pnpm brain:sync
```

---

## Adding a Tool (Quick Reference)

Full checklist: `../rules/TOOL-STANDARDS.md`

1. `src/tools/{name}.ts` — implement `UnifiedTool`
2. `tests/unit/tools/{name}.test.ts` — mock Composio, test soft-failure path
3. `src/agents/agent-tools.ts` — add LangChain wrapper with `hitlGate()`
4. `src/agents/office.ts` — wire into the right department's `tools: []` array
5. `pnpm test` + `pnpm lint` green

---

## Troubleshooting

**Bot not responding:**
```bash
# Should show exactly 1 process
ps aux | grep "src/index" | grep -v grep | wc -l

# Check for errors
grep ERROR /tmp/founderos.log | tail -10
```

**Bot replies "Hey there!" to everything (context loop):**
`/reset` — clears thread history. The 12-turn history bound usually prevents this.

**HITL approval not working:**
- Only ONE pending approval per thread. New messages cancel stale ones.
- If stuck: `/reset` clears the thread including pending approvals.

**503 Gemini errors:**
Handled automatically by the fallback cascade (2.5 → 2.0 → 1.5). If all fail,
error surfaces to Telegram.

**Composio auth expired:**
`Error: LinkedIn token expired. Please reconnect.`
Go to app.composio.dev → Connections → reconnect. Connection ID stays the same.

**Calendar not creating:**
```bash
npx tsx --env-file=.env scripts/probe-gcal.ts
```

---

## Probe Scripts

```bash
npx tsx --env-file=.env scripts/probe-gcal.ts    # test Google Calendar
npx tsx --env-file=.env scripts/probe-real-task.ts  # run task through real office
npx tsx scripts/generate-knowledge-graph.ts      # regenerate .claude/graph.json
```

---

## Monitoring

```bash
tail -f /tmp/founderos.log           # live logs
curl http://localhost:3001/health    # health check
curl http://localhost:3001/metrics   # metrics
```
