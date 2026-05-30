/**
 * Mock Redis helpers for unit + integration tests.
 *
 * Usage:
 *   vi.mock("../../src/infra/redis.js", () => mockRedisModule())
 *   // or for "Redis is down" scenarios:
 *   vi.mock("../../src/infra/redis.js", () => mockRedisDownModule())
 *
 * Design:
 *   - mockRedisModule: returns all helpers functioning normally with in-memory store.
 *     Exposes _store for assertions in tests.
 *   - mockRedisDownModule: all helpers throw / return fail-open values.
 *     Tests that callers handle Redis unavailability gracefully.
 *   - Mirrors the real API surface of src/infra/redis.ts exactly.
 */

import { vi } from "vitest";

// ── In-Memory Store ───────────────────────────────────────────────────────────

/** Internal store shared across mock calls (reset between tests with clearMockStore). */
export const _store: Map<string, { value: string; expiresAt?: number }> = new Map();
export const _quotaCounters: Map<string, number> = new Map();

export function clearMockStore() {
  _store.clear();
  _quotaCounters.clear();
}

// ── Working Redis Mock ────────────────────────────────────────────────────────

/**
 * Returns a module mock where Redis works normally (in-memory).
 * Use with: vi.mock("../../src/infra/redis.js", () => mockRedisModule())
 */
export function mockRedisModule() {
  return {
    getRedis: vi.fn(),
    closeRedis: vi.fn().mockResolvedValue(undefined),

    KEYS: {
      research: (url: string) => `research:${Buffer.from(url).toString("hex").slice(0, 8)}`,
      quota: (tenantId: string, date: string) => `quota:${tenantId}:${date}`,
      llmCache: (hash: string) => `llm:${hash}`,
    },

    hashPrompt: (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString("hex").slice(0, 16),
    todayUtc: () => new Date().toISOString().slice(0, 10),
    tomorrowMidnightUtc: () => Math.floor(Date.now() / 1000) + 86400,

    cacheGet: vi.fn(async <T>(key: string): Promise<T | null> => {
      const entry = _store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        _store.delete(key);
        return null;
      }
      return JSON.parse(entry.value) as T;
    }),

    cacheSet: vi.fn(async (key: string, value: unknown, ttlSeconds: number): Promise<void> => {
      if (ttlSeconds <= 0) return;
      _store.set(key, {
        value: JSON.stringify(value),
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    }),

    incrQuota: vi.fn(async (tenantId: string): Promise<number> => {
      const key = `quota:${tenantId}`;
      const current = _quotaCounters.get(key) ?? 0;
      const next = current + 1;
      _quotaCounters.set(key, next);
      return next;
    }),

    getQuota: vi.fn(async (tenantId: string): Promise<number> => {
      return _quotaCounters.get(`quota:${tenantId}`) ?? 0;
    }),
  };
}

// ── Redis-Down Mock ───────────────────────────────────────────────────────────

/**
 * Returns a module mock where Redis is unavailable.
 * All operations return fail-open values (null / Infinity / silent).
 * Tests that callers degrade gracefully without Redis.
 */
export function mockRedisDownModule() {
  const redisError = new Error("ECONNREFUSED — Redis is down");

  return {
    getRedis: vi.fn(() => { throw redisError; }),
    closeRedis: vi.fn().mockResolvedValue(undefined),

    KEYS: {
      research: (url: string) => `research:${url}`,
      quota: (tenantId: string, date: string) => `quota:${tenantId}:${date}`,
      llmCache: (hash: string) => `llm:${hash}`,
    },

    hashPrompt: (payload: unknown) => String(payload),
    todayUtc: () => new Date().toISOString().slice(0, 10),
    tomorrowMidnightUtc: () => Math.floor(Date.now() / 1000) + 86400,

    /** Fail-open: returns null (cache miss) */
    cacheGet: vi.fn().mockResolvedValue(null),

    /** Fail-open: silently swallows error */
    cacheSet: vi.fn().mockResolvedValue(undefined),

    /** Fail-open: returns 0 so quota check passes (not Infinity — 0 < any limit) */
    incrQuota: vi.fn().mockResolvedValue(0),

    getQuota: vi.fn().mockResolvedValue(0),
  };
}
