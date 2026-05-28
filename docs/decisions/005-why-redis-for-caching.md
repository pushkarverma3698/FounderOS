# ADR-005: Why Redis for Caching Instead of PostgreSQL Tables

**Date:** 2026-05-27
**Status:** Accepted
**Context:** Phase 2 — Outbound pipeline introduced research caching, daily send quotas, and LLM prompt caching.

---

## Context

When adding the ProspectingPod and outbound email pipeline, three new data storage needs emerged:

1. **Research cache** — Tavily/web research results per company URL (stale after 7 days)
2. **Daily send quotas** — Per-tenant daily email counter (resets at midnight UTC)
3. **LLM prompt cache** — Reuse identical MD/NANO-tier LLM responses (CEO tier never cached)

The question: should these live in PostgreSQL tables or a Redis cache?

---

## Decision

Use **Redis (ioredis)** for all three, and keep PostgreSQL for durable business data only.

| Need | Redis key | TTL |
|------|-----------|-----|
| Research cache | `research:{md5(url)}` | 7 days |
| Daily quota | `quota:{tenant}:{YYYY-MM-DD}` | Expires midnight UTC |
| LLM prompt cache | `llm:{sha256(prompt)}` | 0 (CEO), 3600s (MD), 86400s (NANO) |

---

## Rationale

### 1. TTL is a native Redis primitive

Research results go stale after 7 days. In Redis: `SETEX key 604800 value`. In Postgres: requires a background cleanup job, `DELETE WHERE created_at < NOW() - INTERVAL '7 days'`, index fragmentation, and VACUUM. Redis TTL is O(1) and self-managing.

### 2. Atomic INCR for quota is race-condition-safe

Daily send quotas need atomic increment-and-check. Redis `INCR` is an O(1) atomic operation — safe under concurrent requests, no transaction overhead. The Postgres equivalent requires `BEGIN ... SELECT FOR UPDATE ... UPDATE ... COMMIT`, adding latency and lock contention under load.

```typescript
// Redis — atomic, lock-free
const count = await redis.incr(key);
if (count === 1) await redis.expireat(key, tomorrowMidnight);
if (count > limit) return "quota_exceeded";
```

### 3. Prompt caching TTLs vary by tier — trivial in Redis

CEO tier: TTL = 0 (never cache, decisions must be fresh).
MD tier: TTL = 3600s.
NANO tier: TTL = 86400s.

Redis SETEX accepts TTL as a parameter — one line per tier. In Postgres, different TTLs require either multiple tables or a `expires_at` column + cleanup job.

### 4. Postgres for durable, Redis for ephemeral

Rule of thumb applied throughout FounderOS:
- **Postgres**: Data you need to query, audit, or JOIN later (lead_pipeline, interrupt_registry, audit_log, task_outcomes)
- **Redis**: Data that self-destructs, counters that reset, caches you'll rebuild if evicted

Research results are rebuilt by the research node if evicted. Quota counters auto-expire. LLM cache misses just call the provider again. None of these need durability guarantees.

### 5. Operational simplicity

Postgres tables for ephemeral data create:
- Cleanup jobs (cron + SQL)
- Table bloat and index fragmentation
- Monitoring burden (are cleanup jobs running? how full is the table?)

Redis TTL handles all of this automatically. The operational surface is smaller.

---

## Consequences

**Positive:**
- ~70% LLM cost reduction on repeated MD/NANO prompts (ICP scoring, content drafts)
- Sub-millisecond quota checks under load
- No table-bloat or cleanup job maintenance

**Negative:**
- Adds Redis as an operational dependency (Uptime, memory limits)
- Cache eviction (Redis LRU policy) means occasional research re-fetch — acceptable since Tavily is cheap and research is re-run transparently
- Redis data is not in Postgres backups — acceptable because all data in Redis is ephemeral by design

**Mitigations:**
- Redis starts in docker-compose alongside Postgres — zero extra setup for local dev
- All Redis calls are fail-open: errors fall through to the live provider or continue execution
- Research cache miss is transparent to users — just slightly slower

---

## Rejected Alternatives

| Alternative | Why rejected |
|-------------|-------------|
| `research_cache` Postgres table | Background cleanup jobs, table bloat, no native TTL |
| `send_quota_log` Postgres table | SELECT COUNT + race conditions vs Redis INCR atomicity |
| `content_queue` Postgres table | Overkill for round-robin topic rotation handled by in-memory array |
| Vector/embedding tables | SQL few-shot from `task_outcomes` is faster + cheaper at < 10k rows; revisit at scale |

---

## Related ADRs

- [ADR-001](001-why-langgraph.md) — LangGraph checkpointer (Postgres, not Redis — durable execution state)
- [ADR-002](002-why-drizzle.md) — Why drizzle-orm (applies to Postgres tables only)
