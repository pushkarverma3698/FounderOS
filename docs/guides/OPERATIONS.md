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

# Platform integrations (ADR-029 — direct APIs; Composio = legacy rollback)
# Google: npm install -g @googleworkspace/cli && gws auth login (on VPS)
# GMAIL_BACKEND=gws          # default
# CALENDAR_BACKEND=gws         # default (follows GMAIL_BACKEND)
LINKEDIN_ACCESS_TOKEN=<founder OAuth token>
LINKEDIN_AUTHOR_URN=urn:li:person:...
# LINKEDIN_BACKEND=direct      # default

# Legacy rollback (only if direct APIs fail):
# COMPOSIO_API_KEY=<key>
# GMAIL_BACKEND=composio
# LINKEDIN_BACKEND=composio
# COMPOSIO_GMAIL_CONN_ID=ca_...
# COMPOSIO_LINKEDIN_CONN_ID=ca_...

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

## Adding a Tool

Follow `docs/rules/PROGRAMMING-RULES.md` Wiring Map 1 (all 6 layers) — the single source of
truth for the exact file-touch sequence and the forget→error table. Not re-listed here: an
earlier, shorter version of this list drifted out of sync (it omitted the prompt/routing
layer), which is exactly the failure mode Wiring Map 1 exists to prevent.

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
Handled automatically by the fallback cascade — see `CLAUDE.md` "Model" section for the
current, authoritative chain (production: `gemini-2.5-pro` → `gemini-2.5-flash` →
`claude-haiku-4-5`; local/dev: OpenRouter free-tier models only, never a paid key). If all
fail, the error surfaces to Telegram.

**Google (gws) auth missing:**
```bash
gws auth status   # should show authenticated user
gws auth login    # one-time on VPS as founderos user
node --env-file=.env --import tsx/esm scripts/probe-direct-integrations.ts
```

**LinkedIn token expired:**
Set fresh `LINKEDIN_ACCESS_TOKEN` in `.env` (founder re-OAuth). Or rollback:
`LINKEDIN_BACKEND=composio` + `COMPOSIO_API_KEY`.

**Calendar not creating:**
```bash
node --env-file=.env --import tsx/esm scripts/probe-direct-integrations.ts
```

---

## Probe Scripts

```bash
npx tsx --env-file=.env scripts/probe-direct-integrations.ts  # gws + LinkedIn direct
npx tsx --env-file=.env scripts/probe-providers.ts            # all provider probes
npx tsx --env-file=.env scripts/probe-gcal.ts                 # calendar (legacy Composio)
npx tsx --env-file=.env scripts/probe-real-task.ts            # run task through real office
pnpm graph:gen                                                # regenerate .claude/graph.json
```

---

## Halt & Resume (Emergency Kill Switch)

```bash
# Stop the bot gracefully (request handler checks halt.blocked file)
touch /halt.blocked

# Resume
rm /halt.blocked
```

**Use case:** Critical bug, security incident, service degradation.

**Effect:** Next incoming message will abort gracefully. Pending approvals are not lost (persisted to Postgres).

---

## Monitoring Signals

```bash
# Check unprocessed signals (hourly sweep should consume these)
psql founderos -c "SELECT COUNT(*) FROM dept_signals WHERE consumed = false;"

# View recent signals
psql founderos -c "SELECT event_type, published_at FROM dept_signals ORDER BY published_at DESC LIMIT 10;"

# Manually trigger sweep (if needed)
curl -X POST http://localhost:3001/api/internal/sweep-signals
```

**Watch for:** Signals stuck unconsumed > 24 hours (sweep not running or Telegram unreachable).

---

## Quota & Budget Monitoring

```bash
# Daily spend per department
psql founderos -c "SELECT dept_name, SUM(model_cost) FROM turn WHERE created_at > NOW() - INTERVAL '1 day' GROUP BY dept_name;"

# Total cost (all time)
psql founderos -c "SELECT SUM(model_cost) FROM turn;"

# Cost limits (from config)
cat src/core/config.ts | grep COST_LIMIT
```

**Adjustment:**
```bash
# Edit COST_LIMITS in src/core/config.ts
# Restart bot for changes to take effect
```

---

## Scheduler Jobs

```bash
# What runs:
# - Weekly digest: Monday 6 AM (sweeps decisions, surfaces to Telegram)
# - Signal sweep: 6:01 AM, 6:01 PM (processes dept_signals table)

# View scheduled jobs
grep "scheduler.add\|scheduler.cron" src/infra/scheduler.ts

# Test scheduler (dry run)
npx tsx scripts/test-scheduler.ts
```

---

## Troubleshooting

### Bot Not Responding

```bash
# Check 1: Is it halted?
ls -la /halt.blocked

# Check 2: Is Postgres up?
docker ps | grep postgres

# Check 3: Telegram token valid?
grep TELEGRAM_BOT_TOKEN .env | head -1

# Check 4: Look at recent errors
tail -50 /tmp/founderos.log | grep -i error
```

### Signals Not Processing

```bash
# Check unconsumed signals
psql founderos -c "SELECT COUNT(*) FROM dept_signals WHERE consumed = false;"

# If > 0, check logs for sweep errors
tail -f /tmp/founderos.log | grep "sweep\|signal"

# Manually retry (runs immediately)
curl -X POST http://localhost:3001/api/internal/sweep-signals
```

### High Token Cost

```bash
# Identify expensive departments
psql founderos -c "SELECT dept_name, SUM(model_cost) as total_cost FROM turn GROUP BY dept_name ORDER BY total_cost DESC LIMIT 5;"

# Check last 10 turns (most recent, most expensive)
psql founderos -c "SELECT dept_name, inputTokens, outputTokens, modelCost FROM turn ORDER BY modelCost DESC LIMIT 10;"

# Reduce by: stricter prompts, fewer tool calls, smaller context window
```

### Memory Search Returns Nothing

```bash
# Check if knowledge entries exist
psql founderos -c "SELECT COUNT(*) FROM knowledge_entries;"

# If 0, sync docs
pnpm brain:sync

# Verify sync
psql founderos -c "SELECT COUNT(*) FROM knowledge_entries;"

# Test query
psql founderos -c "SELECT * FROM knowledge_entries LIMIT 1;"
```

---

## Monitoring

```bash
tail -f /tmp/founderos.log           # live logs
curl http://localhost:3001/health    # health check
curl http://localhost:3001/api/v1/health  # JARVIS web gateway
curl http://localhost:3001/metrics   # metrics
grep "seam:" /tmp/founderos.log      # context isolation boundaries

# Live MISO + JARVIS smoke (Postgres + HTTP + mission CRUD)
pnpm test:smoke:miso
```

---

## MISO Mission Control + JARVIS Web UI

FounderOS implements the [MISO](https://clawhub.ai/ShunsukeHayashi/miso) (Mission Inline Skill Orchestration) pattern for multi-agent visibility.

### Telegram commands

| Command | Purpose |
|---------|---------|
| `/miso_start <goal>` | Open a pinned mission dashboard message |
| `/miso_plan` | Show execution plan for the active mission |
| `/miso_status` | Mission phase + pending HITL |
| `/miso_close` | Close mission with summary |

Lifecycle phases: `INIT` → `RUNNING` → `PARTIAL` → `AWAITING APPROVAL` → `COMPLETE` (+ `ERROR`).

Trace events (`turn.in`, `route.decided`, `hitl.interrupt`, `turn.out`) update the mission row and refresh the dashboard.

### Web gateway (JARVIS)

HTTP API mounted on the health port (`3001` by default):

- `POST /api/v1/sessions/:id/messages` — send a task (SSE stream on `/stream`)
- `GET /api/v1/sessions/:id/stream` — SSE event stream (`?token=` when `WEB_GATEWAY_TOKEN` set)
- `POST /api/v1/sessions/:id/hitl/approve|reject` — HITL resume
- `GET /api/v1/missions` — mission board
- `GET /api/v1/sessions/:id/miso/status|plan` — MISO lifecycle
- `POST /api/v1/sessions/:id/miso/close` — close active mission
- `GET /api/v1/audit` — recent `action_log` rows

Optional auth: set `WEB_GATEWAY_TOKEN` in `.env` (Bearer header on fetch; `?token=` on SSE).
When building for production, set the same value as `VITE_WEB_GATEWAY_TOKEN` (deploy script
does this automatically from `WEB_GATEWAY_TOKEN`).

### JARVIS frontend

**Development** (Vite dev server proxies `/api` → `:3001`):

```bash
cd apps/jarvis && pnpm install && pnpm dev
```

Open http://localhost:5173 — proxies `/api` to `localhost:3001`.

**Production** (same port as backend — no separate static host):

After `pnpm build:all`, the health server serves `apps/jarvis/dist` at `/`:

```bash
curl http://localhost:3001/              # JARVIS SPA
curl http://localhost:3001/api/v1/health # web gateway
pnpm test:smoke:jarvis                   # static + auth + API smoke
pnpm test:smoke:miso                     # MISO + mission CRUD smoke
```

**Troubleshooting**

| Symptom | Fix |
|---------|-----|
| UI 404 in prod | Run `pnpm build:jarvis` — dist must exist under `apps/jarvis/dist` |
| API 401 | Set `VITE_WEB_GATEWAY_TOKEN` at build time to match `WEB_GATEWAY_TOKEN` |
| SSE OFFLINE | Check token query on stream URL; verify `:3001` reachable |
| Duplicate replies | Fixed — single `turn.complete` per turn (2026-06-18) |
