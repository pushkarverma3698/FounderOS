# Database Design — FounderOS

> Study guide for the data model decisions, drizzle-orm patterns, and PostgreSQL specifics used in FounderOS.

---

## Schema Overview

FounderOS uses a single PostgreSQL database with two categories of tables:

**1. LangGraph checkpoint tables** (managed by `PostgresSaver.setup()`)
- `langgraph_checkpoints` — serialized state snapshots per thread
- `langgraph_checkpoint_blobs` — binary data (message content, etc.)
- `langgraph_checkpoint_writes` — pending state writes (for atomic updates)

**2. Application tables** (managed by drizzle-orm + drizzle-kit migrations)

| Table | Old name | Purpose |
|-------|----------|---------|
| `hitl_approvals` | interrupt_registry | HITL queue — links LangGraph threads → Telegram messages |
| `ai_call_costs` | llm_costs | Per-call token + cost tracking, tagged with `lead_id` |
| `action_log` | audit_log | Idempotency guard for external actions |
| `outbound_leads` | lead_pipeline | Prospect state machine (researching → won/lost) |
| `do_not_contact` | suppression_list | GDPR/CAN-SPAM suppression list |
| `agent_results` | task_outcomes | Phase 3: few-shot examples for self-improvement |
| `dept_signals` | dept_events | Phase 3: durable cross-department event log |

Tables were renamed in `drizzle/0001_rename_tables.sql` using `ALTER TABLE RENAME`. JS export names updated in `schema.ts`. Backwards-compatible aliases exported for migration safety.

---

## Table Design Decisions

### hitl_approvals (was: interrupt_registry)

```sql
CREATE TABLE hitl_approvals (
  interrupt_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id       TEXT NOT NULL,        -- LangGraph thread: "turicks:telegram:456:run-xyz"
  tenant_id       TEXT NOT NULL DEFAULT 'turicks',
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|expired
  telegram_msg_id BIGINT,               -- message ID for editing the Telegram message
  callback_data   TEXT,                 -- raw data from the inline keyboard button
  expires_at      TIMESTAMPTZ NOT NULL, -- 24h from creation
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  rejection_reason TEXT,
  edits           TEXT                  -- if founder edits the draft before approving
);

CREATE INDEX ha_thread_status_idx ON hitl_approvals(thread_id, status);
```

**Why the index on `(thread_id, status)`:**
The HITL resolution query is: "find the pending interrupt for this thread." This is on the hot path — called every time a Telegram button is tapped. A composite index on `(thread_id, status)` is a covering index for this query:
```sql
SELECT * FROM hitl_approvals
WHERE thread_id = $1 AND status = 'pending'  -- index covers both conditions
LIMIT 1;
```

Without the index, this is a full table scan. With it, it's an O(log n) index lookup.

**Why `expires_at` and not soft-delete:**
Expired interrupts are a special state — the task was sent for approval but never resolved. We want to know this happened (for metrics, for debugging) so we don't delete the row. The `expireStaleInterrupts()` cron job sets `status = 'expired'` for rows past `expires_at`. Expired rows are retained for 30 days then pruned.

---

### ai_call_costs (was: llm_costs)

```sql
CREATE TABLE ai_call_costs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL,
  agent       TEXT NOT NULL,     -- "bdr", "critic", "lead_intel"
  tier        TEXT NOT NULL,     -- "ceo", "md", "nano"...
  model       TEXT NOT NULL,     -- actual model used (may be fallback)
  tokens_in   INTEGER NOT NULL,
  tokens_out  INTEGER NOT NULL,
  cost_usd    NUMERIC(10, 6) NOT NULL,  -- 6 decimal places for sub-cent accuracy
  lead_id     UUID,                     -- FK → outbound_leads: per-lead cost attribution
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

**Why `NUMERIC(10, 6)` not `FLOAT`:**
Floating point arithmetic is approximate. `0.1 + 0.2` in float = `0.30000000000000004`. For financial data (even micro-costs), use `NUMERIC` — exact decimal arithmetic. `(10, 6)` means 10 total digits, 6 after the decimal = max $9999.999999 per entry, sufficient for any single LLM call.

**How it's used:**
```typescript
// In llm.ts — after every successful cascade call
logLlmCost({
  tenant_id: opts.tenantId,
  agent: opts.agent,
  tier,
  model: entry.modelId,
  tokens_in: tokensIn,
  tokens_out: tokensOut,
  cost_usd: String(calculatedCost),
}).catch(() => {}); // non-blocking — don't fail the task if cost logging fails
```

**Budget guard query:**
```typescript
const today = new Date();
today.setHours(0, 0, 0, 0);
const result = await db
  .select({ total: sql<string>`SUM(cost_usd)` })
  .from(aiCallCosts)
  .where(and(
    eq(aiCallCosts.tenant_id, tenantId),
    gte(aiCallCosts.created_at, today)
  ));
const spent = parseFloat(result[0]?.total ?? "0");
```

**Per-lead cost attribution (Phase 2D):**
```sql
-- Which leads cost the most to research + draft?
SELECT ol.company_name,
       SUM(acc.cost_usd)  AS total_cost_usd,
       COUNT(*)           AS llm_calls
FROM ai_call_costs acc
JOIN outbound_leads ol ON acc.lead_id = ol.id
GROUP BY ol.company_name
ORDER BY total_cost_usd DESC;
```
The `lead_id` FK enables this view. Tag it at LLM call time: pass `leadId` through `callCascade()` options.

---

### action_log (was: audit_log)

```sql
CREATE TABLE action_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT NOT NULL,
  action           TEXT NOT NULL,     -- "email_sent", "github_pr", "linkedin_post"
  idempotency_key  TEXT UNIQUE,       -- THE critical constraint
  payload          JSONB,             -- full context for debugging
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
```

**The idempotency pattern:**
```typescript
// Before sending an email:
const key = `email_sent:${interruptId}`;

// This either inserts or does nothing (NEVER errors on duplicate)
await db.insert(auditLog)
  .values({ tenant_id, action: "email_sent", idempotency_key: key, payload })
  .onConflictDoNothing();

// Check if the insert actually happened
const existing = await hasBeenAudited(key);
if (existing) {
  logger.warn("Email already sent — idempotency guard fired");
  return; // skip the send
}

// Safe to send now
await sendEmail(draft);
```

**Why `UNIQUE` constraint on `idempotency_key` instead of a check in code:**
The `UNIQUE` constraint is enforced at the database level — it's immune to race conditions. Two concurrent requests checking "does this key exist?" before inserting would both pass the check. With the constraint, only one INSERT succeeds; the other gets a unique violation (which `.onConflictDoNothing()` converts to a no-op).

**Why JSONB for `payload`:**
JSONB stores JSON in a binary format that supports indexing and queries:
```sql
-- You can query into the JSON
SELECT * FROM audit_log WHERE payload->>'recipient' = 'john@acme.com';
-- Or index a specific key
CREATE INDEX ON audit_log((payload->>'thread_id'));
```
TEXT would also work but you'd lose query capabilities.

---

## drizzle-orm Patterns

### Schema Definition is the Type

```typescript
// src/db/schema.ts
export const actionLog = pgTable("action_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotency_key: text("idempotency_key").unique(),
  payload: jsonb("payload"),
});

// Types are DERIVED — no codegen, no duplication
export type ActionLog    = typeof actionLog.$inferSelect;
export type NewActionLog = typeof actionLog.$inferInsert;

// Backwards-compatible alias — safe to use in code migrated from Phase 1
export const auditLog = actionLog;
```

### Query Building

```typescript
import { eq, and, gte, sql } from "drizzle-orm";

// SELECT with WHERE
const row = await db
  .select()
  .from(hitlApprovals)
  .where(and(
    eq(hitlApprovals.interrupt_id, id),
    eq(hitlApprovals.status, "pending")
  ))
  .limit(1);

// UPDATE
await db
  .update(hitlApprovals)
  .set({ status: "approved", resolved_at: new Date() })
  .where(eq(hitlApprovals.interrupt_id, id));

// INSERT with onConflictDoNothing
await db
  .insert(actionLog)
  .values({ tenant_id, action, idempotency_key: key })
  .onConflictDoNothing();
```

### Two Connections, One Database

FounderOS has two database connections:
1. **`postgres.js` (via drizzle)** — for app tables (hitl_approvals, ai_call_costs, action_log, outbound_leads, do_not_contact)
2. **`pg.Pool`** — for LangGraph PostgresSaver (checkpoint tables)

Why two? LangGraph's PostgresSaver requires the `pg` package specifically. drizzle works better with `postgres.js`. Both connect to the same database — different connection pool instances.

```typescript
// src/db/client.ts
let _db: ReturnType<typeof drizzle> | null = null;
let _pool: pg.Pool | null = null;

export function getDb(): ReturnType<typeof drizzle> {
  if (!_db) {
    const sql = postgres(env.DATABASE_URL);
    _db = drizzle(sql, { schema });
  }
  return _db;
}

export function getPgPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: env.DATABASE_URL, min: 5, max: 20 });
  }
  return _pool;
}
```

---

## Migration Workflow

```bash
# 1. Change schema.ts
# 2. Generate SQL migration
npx drizzle-kit generate
# → creates drizzle/0002_add_expires_at.sql

# 3. Review the SQL (it's in git)
cat drizzle/0002_add_expires_at.sql

# 4. Apply (idempotent — safe to run multiple times)
npx tsx scripts/setup-db.ts
```

The `setup-db.ts` script runs:
```typescript
// Drizzle migrations — app tables
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
await migrate(db, { migrationsFolder: "./drizzle" });

// LangGraph checkpointer setup — checkpoint tables
const checkpointer = new PostgresSaver(pool);
await checkpointer.setup();
```

---

## PostgreSQL Features Used

**`gen_random_uuid()`** — Server-side UUID generation. No dependency on the application to generate UUIDs (though drizzle's `.defaultRandom()` also works).

**`TIMESTAMPTZ`** — Always use timezone-aware timestamps. `TIMESTAMP` (without timezone) stores local time — a nightmare when the server timezone changes or you're querying across timezones.

**Composite indexes** — `CREATE INDEX ha_thread_status_idx ON hitl_approvals(thread_id, status)`. PostgreSQL uses the index when the query filters on both columns (or just the leftmost column — `thread_id` alone also uses this index).

**JSONB vs JSON** — JSONB is binary-stored and supports GIN indexes for efficient key-existence queries. JSON is text-stored — slightly faster write, much slower read for complex queries. Use JSONB for any column you might want to query into.

---

## Redis vs PostgreSQL Decision Matrix

A recurring design question: when does a piece of data live in Redis, and when does it live in Postgres?

**The rule:** Redis for data that self-destructs. Postgres for data you query later.

| Data | Store | Why |
|------|-------|-----|
| Company research results | Redis TTL 7d | Ephemeral — stale after a week. No need to query by column. |
| Daily send quota counters | Redis INCR | Atomic increment + auto-expire at midnight. Race-condition safe. |
| LLM prompt response cache | Redis TTL tier-based | Ephemeral. CEO TTL=0 (never cache). MD TTL=3600. NANO TTL=86400. |
| HITL approval state | Postgres | Needs durability across restarts. JOIN with thread_id. Queryable. |
| Per-lead cost attribution | Postgres | Joined to outbound_leads. SUM() aggregate queries. Permanent audit trail. |
| Suppression list | Postgres | Must survive forever. Compliance audit trail. UNIQUE constraint. |
| Action idempotency keys | Postgres | Permanent deduplication. Must survive process restart. |

**Why not Postgres for send quotas?**
```sql
-- Postgres approach (fragile):
INSERT INTO send_quotas (tenant_id, date, count) VALUES ($1, $2, 1)
ON CONFLICT (tenant_id, date) DO UPDATE SET count = send_quotas.count + 1
RETURNING count;
```
This requires a transaction + UPSERT + a cleanup job to delete old rows.

```typescript
// Redis approach (correct):
const key = `quota:${tenantId}:${today}`;           // "quota:turicks:2025-01-15"
const count = await redis.incr(key);                // atomic — no race condition
if (count === 1) await redis.expireat(key, tomorrowMidnight); // auto-expire
if (count > DAILY_SEND_LIMIT) return "quota_exceeded";
```

Redis INCR is O(1), atomic, and auto-expiry removes stale keys with zero operational overhead.

**Why not Redis for HITL state?**
HITL rows need to survive a process restart (LangGraph resumes from checkpoints). Redis without persistence would lose `pending` approvals on a crash. Postgres is the right store for durability guarantees.

### Atomic Counter Pattern (INCR + EXPIREAT)

The `expireat` call (not `expire`) is important:

```typescript
// WRONG — expire sets a TTL in seconds from now
await redis.expire(key, 86400); // Expires 24h from now, NOT at midnight

// CORRECT — expireat sets absolute UNIX timestamp
const midnight = new Date();
midnight.setHours(24, 0, 0, 0);             // next midnight (local server time)
await redis.expireat(key, Math.floor(midnight.getTime() / 1000));
```

This ensures the quota resets at midnight, not 24h after the first request — which is the user-visible correct behaviour.

**Idempotent expiry setup:**
```typescript
const count = await redis.incr(key);
if (count === 1) {
  // First increment of the day — set the expiry
  // If count > 1, expiry is already set from the first call
  await redis.expireat(key, midnightTimestamp);
}
```

Only set `expireat` on the first increment. Subsequent increments don't need to re-set it (expiry is already in place), and calling `expireat` again would reset the TTL — a bug that could extend quotas past midnight.
