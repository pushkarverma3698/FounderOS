# FounderOS — Local Development

> Setup from zero to running bot in ~10 minutes.

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 22 LTS | `nvm install 22` |
| pnpm | latest | `npm i -g pnpm` |
| Docker | 24+ | [docker.com](https://docker.com) |
| PostgreSQL | via Docker | see below |
| Redis | via Docker | see below |
| Ollama | latest | [ollama.com](https://ollama.com) (for local model) |

---

## 1 — Clone & Install

```bash
git clone <repo-url> founderos
cd founderos
pnpm install
```

---

## 2 — Environment Variables

```bash
cp .env.example .env
```

Open `.env` and fill in the required values:

```bash
# REQUIRED — at minimum you need DATABASE_URL and TELEGRAM_*
DATABASE_URL=postgresql://founderos:founderos@localhost:5432/founderos
TELEGRAM_BOT_TOKEN=<get from @BotFather>
TELEGRAM_CHAT_ID=<your group chat ID>

# REQUIRED — at least one LLM provider
ANTHROPIC_API_KEY=sk-ant-...     # CEO tier + Critic
GOOGLE_GENERATIVE_AI_API_KEY=... # MD, Nano, Deep Research tiers

# OPTIONAL but recommended
LANGCHAIN_API_KEY=...            # LangSmith tracing
LANGCHAIN_TRACING_V2=true
```

**Minimum viable config for first run:** `DATABASE_URL` + `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` + at least one LLM key.

### Getting Telegram IDs

1. Create a bot: message `@BotFather`, type `/newbot`
2. Copy the token → `TELEGRAM_BOT_TOKEN`
3. Add the bot to your group with admin rights
4. Get chat ID: send a message to the group, then visit:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   Look for `"chat": { "id": -1001234... }` → `TELEGRAM_CHAT_ID`
5. For topic IDs: enable Topics in group settings, create topics, then check `getUpdates` for `"message_thread_id"`

---

## 3 — Start PostgreSQL + Redis

```bash
docker compose -f docker/docker-compose.yml up postgres redis -d
```

Wait for both to be healthy:

```bash
docker compose -f docker/docker-compose.yml ps
# postgres → "(healthy)"
# redis   → "(healthy)"
```

Redis is used for:
- `research:{url_hash}` — cached company research (TTL 7 days, avoids re-scraping)
- `quota:{tenant}:{date}` — daily send quota counter (atomic INCR)
- `llm:{prompt_hash}` — LLM response cache for MD/NANO tiers

---

## 4 — Run Database Migrations

```bash
npx tsx scripts/setup-db.ts
```

This is idempotent — safe to run multiple times. It:
- Runs all Drizzle migrations from `./drizzle/`
- Runs `PostgresSaver.setup()` for LangGraph checkpoint tables
- Prints confirmation of each step

---

## 5 — Generate Drizzle Migrations (first time only)

If the `drizzle/` folder is empty:

```bash
npx drizzle-kit generate
npx tsx scripts/setup-db.ts
```

---

## 6 — Start the App

```bash
npx tsx src/index.ts
```

You should see:
```
[FounderOS] Telemetry initialised (LangSmith tracing: false)
[FounderOS] LangGraph compiled — nodes: supervisor, sales, engineering, marketing
[FounderOS] Telegram bot started (polling)
[FounderOS] FounderOS ready ✓
```

Send a message to your Telegram group → bot responds.

---

## Development Workflow

### Hot Reload

```bash
npx tsx --watch src/index.ts
```

### Run Tests

```bash
pnpm test              # all tests (vitest)
pnpm test --watch      # watch mode
pnpm test tests/unit/  # unit tests only
```

### Inspect a Thread's Checkpoints

```bash
npx tsx scripts/inspect-thread.ts <thread_id>
# e.g.: npx tsx scripts/inspect-thread.ts turicks:telegram:456:run-xyz
```

### Check Today's LLM Costs

```bash
npx tsx -e "
import { getCostBreakdown } from './src/db/queries.js';
getCostBreakdown('turicks', 7).then(r => console.table(r));
"
```

### Check Cost Per Lead

```bash
npx tsx -e "
import { getDb } from './src/db/client.js';
import { aiCallCosts, outboundLeads } from './src/db/schema.js';
import { sql, eq } from 'drizzle-orm';
const db = getDb();
const rows = await db
  .select({
    company: outboundLeads.company_name,
    total_cost: sql\`SUM(\${aiCallCosts.cost_usd})\`.mapWith(Number),
    calls: sql\`COUNT(*)\`.mapWith(Number),
  })
  .from(aiCallCosts)
  .innerJoin(outboundLeads, eq(aiCallCosts.lead_id, outboundLeads.id))
  .groupBy(outboundLeads.company_name)
  .orderBy(sql\`SUM(\${aiCallCosts.cost_usd}) DESC\`);
console.table(rows);
"
```

### Set Up Local Model (Ollama)

```bash
# Pull the base model (4.7GB — one-time download)
ollama pull qwen2.5:7b

# Build the FounderOS custom model (deterministic, JSON-focused)
ollama create founderos -f docker/Modelfile.founderos

# Verify it works
ollama run founderos '{"task":"ping"}'
# Expected: {"status":"pong","model":"founderos"}

# Run E2E journey tests against local model
npx vitest run tests/e2e/founderos-journey.test.ts
```

---

## Full Docker Stack

To run everything (app + postgres) in Docker:

```bash
docker compose -f docker/docker-compose.yml up --build
```

Note: This builds the TypeScript first, then runs the compiled `dist/`. For development, use `npx tsx` directly (faster iteration).

---

## Troubleshooting

### "env validation failed: DATABASE_URL"
Make sure `.env` exists and has all required vars. Run: `cat .env | grep DATABASE_URL`

### "connect ECONNREFUSED 127.0.0.1:5432"
PostgreSQL isn't running. Start it: `docker compose -f docker/docker-compose.yml up postgres -d`

### "No LM Studio server found" (code tier cascade fail)
The `code` tier tries LM Studio first. Either:
- Start LM Studio and load a model
- Or just ignore it — the cascade will fall back to OpenRouter/Gemini

### LangGraph checkpointer "table does not exist"
Run `npx tsx scripts/setup-db.ts` again. The PostgresSaver tables need explicit setup.

### "Redis connection refused" / "ECONNREFUSED 6379"
Redis isn't running. Start it: `docker compose -f docker/docker-compose.yml up redis -d`
The app runs without Redis (caching degrades gracefully) but quota checks and research caching won't work.

### Telegram bot not receiving messages
- Check bot is admin in the group
- Check `TELEGRAM_CHAT_ID` matches the group (not a user)
- In dev, only one process can poll at a time — stop any other running instances

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `TELEGRAM_BOT_TOKEN` | ✅ | From @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | Group chat ID (negative number) |
| `ANTHROPIC_API_KEY` | One of these | Claude Sonnet (CEO + Critic) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | One of these | Gemini (MD, Nano, Research) |
| `OPENROUTER_API_KEY` | One of these | Free tier fallbacks |
| `TOPIC_BOARDROOM` | Optional | Thread ID for general tasks |
| `TOPIC_TURICKS` | Optional | Thread ID for Turicks tasks |
| `TOPIC_NAGGAR` | Optional | Thread ID for Naggar tasks |
| `TOPIC_THINK_TANK` | Optional | Thread ID for social/cross-company |
| `LANGCHAIN_API_KEY` | Optional | LangSmith observability |
| `LANGCHAIN_TRACING_V2` | Optional | `"true"` to enable tracing |
| `FIRECRAWL_API_KEY` | Optional | Web scraping for lead intel |
| `COMPOSIO_API_KEY` | Optional | Gmail + LinkedIn tools |
| `LM_STUDIO_URL` | Optional | Local model server (default: localhost:1234) |
| `BUDGET_DAILY_USD` | Optional | Daily LLM spend cap (default: $5.00) |
| `LOG_LEVEL` | Optional | `debug`/`info`/`warn` (default: `info`) |
| `REDIS_URL` | Optional | Redis connection (default: `redis://localhost:6379`) |
| `OLLAMA_URL` | Optional | Ollama local model server (default: `http://localhost:11434`) |
