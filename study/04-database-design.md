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
- `interrupt_registry` — HITL state linking LangGraph threads to Telegram messages
- `llm_costs` — per-call token and cost tracking
- `audit_log` — idempotency guard for external actions

---

## Table Design Decisions

### interrupt_registry

```sql
CREATE TABLE interrupt_registry (
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

CREATE INDEX ir_thread_status_idx ON interrupt_registry(thread_id, status);
```

**Why the index on `(thread_id, status)`:**
The HITL resolution query is: "find the pending interrupt for this thread." This is on the hot path — called every time a Telegram button is tapped. A composite index on `(thread_id, status)` is a covering index for this query:
```sql
SELECT * FROM interrupt_registry
WHERE thread_id = $1 AND status = 'pending'  -- index covers both conditions
LIMIT 1;
```

Without the index, this is a full table scan. With it, it's an O(log n) index lookup.

**Why `expires_at` and not soft-delete:**
Expired interrupts are a special state — the task was sent for approval but never resolved. We want to know this happened (for metrics, for debugging) so we don't delete the row. The `expireStaleInterrupts()` cron job sets `status = 'expired'` for rows past `expires_at`. Expired rows are retained for 30 days then pruned.

---

### llm_costs

```sql
CREATE TABLE llm_costs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL,
  agent       TEXT NOT NULL,     -- "bdr", "critic", "lead_intel"
  tier        TEXT NOT NULL,     -- "ceo", "md", "nano"...
  model       TEXT NOT NULL,     -- actual model used (may be fallback)
  tokens_in   INTEGER NOT NULL,
  tokens_out  INTEGER NOT NULL,
  cost_usd    NUMERIC(10, 6) NOT NULL,  -- 6 decimal places for sub-cent accuracy
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
  .from(llmCosts)
  .where(and(
    eq(llmCosts.tenant_id, tenantId),
    gte(llmCosts.created_at, today)
  ));
const spent = parseFloat(result[0]?.total ?? "0");
```

---

### audit_log

```sql
CREATE TABLE audit_log (
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
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotency_key: text("idempotency_key").unique(),
  payload: jsonb("payload"),
});

// Types are DERIVED — no codegen, no duplication
export type AuditLog    = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
```

### Query Building

```typescript
import { eq, and, gte, sql } from "drizzle-orm";

// SELECT with WHERE
const row = await db
  .select()
  .from(interruptRegistry)
  .where(and(
    eq(interruptRegistry.interrupt_id, id),
    eq(interruptRegistry.status, "pending")
  ))
  .limit(1);

// UPDATE
await db
  .update(interruptRegistry)
  .set({ status: "approved", resolved_at: new Date() })
  .where(eq(interruptRegistry.interrupt_id, id));

// INSERT with onConflictDoNothing
await db
  .insert(auditLog)
  .values({ tenant_id, action, idempotency_key: key })
  .onConflictDoNothing();
```

### Two Connections, One Database

FounderOS has two database connections:
1. **`postgres.js` (via drizzle)** — for app tables (interrupt_registry, llm_costs, audit_log)
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

**Composite indexes** — `CREATE INDEX ON interrupt_registry(thread_id, status)`. PostgreSQL uses the index when the query filters on both columns (or just the leftmost column — `thread_id` alone also uses this index).

**JSONB vs JSON** — JSONB is binary-stored and supports GIN indexes for efficient key-existence queries. JSON is text-stored — slightly faster write, much slower read for complex queries. Use JSONB for any column you might want to query into.
