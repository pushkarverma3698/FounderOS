/**
 * FounderOS — Redis Client + Key Helpers
 * =======================================
 * SaaS-PHASE: fail-open cache/quota primitives. Wiring is opt-in per feature:
 *   - research/scrape cache — WIRED (infra/research-memory.ts → apify/research tools)
 *   - LLM response cache    — WIRED, flag-gated (gateway/model-cache.ts;
 *                             LLM_CACHE_ENABLED, planner + synthesizer only)
 *   - daily send quota enforcement — NOT wired (incrQuota/getQuota unused)
 *
 * All helpers fail open: no REDIS_URL → getRedis() returns null → cacheGet=null,
 * cacheSet=no-op, incrQuota=0. Redis is optional; a Redis instance must exist for
 * the wired features to actually cache (else they silently pass through).
 *
 * To enable the LLM cache in prod: provision Redis, set REDIS_URL (already in
 * PRESERVE_IF_MISSING) + LLM_CACHE_ENABLED=true.
 *
 * Key namespaces (ready for use):
 *   research:{url_hash}         TTL 7d   — Tavily/Firecrawl company research blob
 *   quota:{tenant}:{YYYY-MM-DD} INCR     — daily outbound send counter (atomic)
 *   llm:{tenant}:{prompt_hash}  TTL cfg  — LLM prompt response cache (tier-gated, tenant-isolated)
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
 * Returns null if REDIS_URL is not configured (SaaS-phase: Redis is optional).
 * Callers must handle null → fail-open (cacheGet returns null, incrQuota returns 0).
 */
export function getRedis(): Redis | null {
  if (_redis) return _redis;
  if (!env.REDIS_URL) {
    log.debug("REDIS_URL not set — Redis disabled");
    return null;
  }

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
   * Scrape-result cache (dedup). Keyed by a hash of the url OR the deep_research
   * query so repeat research is instant and never re-pays Apify credits.
   * TTL: RESEARCH_CACHE_TTL_SECONDS (default 24h).
   */
  scrape: (key: string) =>
    `scrape:${createHash("md5").update(key.toLowerCase().trim()).digest("hex")}`,

  /**
   * Daily send quota counter for a tenant.
   * INCR + EXPIREAT to midnight UTC.
   * Format: quota:{tenantId}:{YYYY-MM-DD}
   */
  quota: (tenantId: string, date: string) => `quota:${tenantId}:${date}`,

  /**
   * LLM prompt response cache — TENANT-NAMESPACED.
   * Hash the full prompt payload (tier + messages) for uniqueness, then prefix
   * with tenant_id so two tenants with an identical prompt NEVER share a cached
   * response (data-isolation requirement at SaaS scale).
   * Format: llm:{tenantId}:{promptHash}
   * TTL: LLM_CACHE_TTL[tier] seconds (CEO = 0 = no cache).
   */
  llmCache: (tenantId: string, promptHash: string) => `llm:${tenantId}:${promptHash}`,

  /**
   * Query-embedding cache (RAG, spec §1.1 F3). Keyed by a hash of the embed
   * model + text so the same query never re-embeds. Embeddings are deterministic,
   * so this is NOT tenant-namespaced (a vector for "what is our ICP" is identical
   * for everyone) and caching cannot change retrieval outputs — only latency.
   * TTL: EMBED_CACHE_TTL_SECONDS (30 days).
   */
  embed: (model: string, text: string) =>
    `embed:${createHash("sha256").update(`${model}\n${text}`).digest("hex")}`,
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

/** Timeout for individual Redis operations (3 seconds). Prevents slow Redis from hanging callers. */
const REDIS_OP_TIMEOUT_MS = 3_000;

/**
 * Wraps a Redis promise with a hard timeout.
 * On timeout: rejects with a descriptive error, triggering the caller's catch → fail-open.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Redis ${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * Get a cached value as parsed JSON.
 * Returns null on miss OR if Redis is unavailable (fail-open).
 * Times out after 3s to prevent slow Redis from blocking callers.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await withTimeout(redis.get(key), REDIS_OP_TIMEOUT_MS, "GET");
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
 * Times out after 3s.
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return; // CEO tier: never cache
  const redis = getRedis();
  if (!redis) return;
  try {
    await withTimeout(
      redis.setex(key, ttlSeconds, JSON.stringify(value)),
      REDIS_OP_TIMEOUT_MS,
      "SETEX",
    );
  } catch (err) {
    log.warn({ key, err: (err as Error).message }, "Redis cacheSet failed — skipping");
  }
}

/**
 * Increment a daily quota counter.
 * Sets expiry to tomorrow midnight UTC on first increment (EXPIREAT).
 * Returns current count. Returns 0 if Redis is unavailable (fail-open → allow send).
 * Times out after 3s.
 */
export async function incrQuota(tenantId: string): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  const key = KEYS.quota(tenantId, todayUtc());
  try {
    const count = await withTimeout(redis.incr(key), REDIS_OP_TIMEOUT_MS, "INCR");
    if (count === 1) {
      // First increment today — set expiry to midnight UTC (fire-and-forget, non-critical)
      redis.expireat(key, tomorrowMidnightUtc()).catch((e: Error) =>
        log.warn({ tenantId, err: e.message }, "Redis EXPIREAT failed — quota key may not auto-expire"),
      );
    }
    return count;
  } catch (err) {
    log.warn({ tenantId, err: (err as Error).message }, "Redis quota check failed — fail-open");
    return 0; // allow send on Redis failure
  }
}

/** Get current quota count without incrementing. Returns 0 on miss or error. */
export async function getQuota(tenantId: string): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  const key = KEYS.quota(tenantId, todayUtc());
  try {
    const raw = await redis.get(key);
    return raw ? parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}
