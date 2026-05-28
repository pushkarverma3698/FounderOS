/**
 * FounderOS — Redis Client + Key Helpers
 * =======================================
 * Single ioredis connection, shared across the entire process.
 * Key namespaces are defined here — never inline key strings elsewhere.
 *
 * Key namespaces:
 *   research:{url_hash}         TTL 7d   — Tavily/Firecrawl company research blob
 *   quota:{tenant}:{YYYY-MM-DD} INCR     — daily outbound send counter (atomic)
 *   llm:{prompt_hash}           TTL cfg  — LLM prompt response cache (tier-gated)
 *
 * Design decisions:
 * - One connection (not a pool) — Redis is single-threaded, pooling adds overhead
 * - Key helpers as `const` functions — no magic strings scattered in agent files
 * - Graceful degradation: if Redis is down, log and continue (don't crash the app)
 *   Research cache miss → re-scrape. Quota miss → allow send (fail-open).
 *   LLM cache miss → call provider. None of these are fatal.
 *
 * See ADR-005: docs/decisions/005-why-redis-for-caching.md
 */

import { Redis } from "ioredis";
import { createHash } from "crypto";
import { env } from "../core/config.js";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "redis" });

// ── Singleton Connection ──────────────────────────────────────────────────────

let _redis: Redis | null = null;

/**
 * Lazy singleton — connects on first use.
 * Graceful: logs errors but does not throw on connection failure.
 */
export function getRedis(): Redis {
  if (_redis) return _redis;

  _redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times: number) => {
      if (times > 3) {
        log.warn("Redis retry limit reached — operating without cache");
        return null; // stop retrying
      }
      return Math.min(times * 200, 2000);
    },
  });

  _redis.on("connect", () => log.info("Redis connected"));
  _redis.on("error",   (err: Error) => log.warn({ err: err.message }, "Redis error"));
  _redis.on("close",   () => log.info("Redis connection closed"));

  return _redis;
}

/** Graceful shutdown — call in SIGTERM handler. */
export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}

// ── Key Helpers ───────────────────────────────────────────────────────────────

/**
 * All Redis key constructors live here.
 * Import KEYS wherever you need Redis — never write key strings inline.
 */
export const KEYS = {
  /**
   * Company research blob. Hash the URL to keep keys short and safe.
   * TTL: RESEARCH_CACHE_TTL_SECONDS (7 days).
   */
  research: (url: string) =>
    `research:${createHash("md5").update(url.toLowerCase().trim()).digest("hex")}`,

  /**
   * Daily send quota counter for a tenant.
   * INCR + EXPIREAT to midnight UTC.
   * Format: quota:{tenantId}:{YYYY-MM-DD}
   */
  quota: (tenantId: string, date: string) => `quota:${tenantId}:${date}`,

  /**
   * LLM prompt response cache.
   * Hash the full prompt payload (tier + messages) for uniqueness.
   * TTL: LLM_CACHE_TTL[tier] seconds (CEO = 0 = no cache).
   */
  llmCache: (promptHash: string) => `llm:${promptHash}`,
} as const;

// ── Key Utilities ─────────────────────────────────────────────────────────────

/** SHA-256 hash of any JSON-serializable payload — used for llmCache keys. */
export function hashPrompt(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Returns today's date in YYYY-MM-DD format (UTC). */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns Unix timestamp of tomorrow midnight UTC — used for quota key expiry. */
export function tomorrowMidnightUtc(): number {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// ── Cache Helpers ─────────────────────────────────────────────────────────────

/**
 * Get a cached value as parsed JSON.
 * Returns null on miss OR if Redis is unavailable (fail-open).
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await getRedis().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err) {
    log.warn({ key, err: (err as Error).message }, "Redis cacheGet failed — cache miss");
    return null;
  }
}

/**
 * Set a value as JSON with TTL.
 * Silently fails if Redis is unavailable (fail-open).
 * Skips write if ttlSeconds is 0 (e.g. CEO tier — never cache).
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return; // CEO tier: never cache
  try {
    await getRedis().setex(key, ttlSeconds, JSON.stringify(value));
  } catch (err) {
    log.warn({ key, err: (err as Error).message }, "Redis cacheSet failed — skipping");
  }
}

/**
 * Increment a daily quota counter.
 * Sets expiry to tomorrow midnight UTC on first increment (EXPIREAT).
 * Returns current count. Returns Infinity if Redis is unavailable (fail-open → allow).
 */
export async function incrQuota(tenantId: string): Promise<number> {
  const key = KEYS.quota(tenantId, todayUtc());
  try {
    const redis = getRedis();
    const count = await redis.incr(key);
    if (count === 1) {
      // First increment today — set expiry to midnight UTC
      await redis.expireat(key, tomorrowMidnightUtc());
    }
    return count;
  } catch (err) {
    log.warn({ tenantId, err: (err as Error).message }, "Redis quota check failed — fail-open");
    return 0; // allow send on Redis failure
  }
}

/** Get current quota count without incrementing. Returns 0 on miss or error. */
export async function getQuota(tenantId: string): Promise<number> {
  const key = KEYS.quota(tenantId, todayUtc());
  try {
    const raw = await getRedis().get(key);
    return raw ? parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}
