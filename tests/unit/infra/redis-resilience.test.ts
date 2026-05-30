/**
 * TDD — Redis fail-open resilience.
 *
 * Tests:
 *   1. cacheGet returns null (not throw) when Redis get throws
 *   2. cacheSet silently swallows error when Redis setex throws
 *   3. incrQuota returns 0 (fail-open) when Redis incr throws
 *   4. cacheSet with ttl=0 skips the write (CEO never-cache rule)
 *   5. cacheGet returns cached value when Redis is working
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock builders ─────────────────────────────────────────────────────────────

/** Build a minimal Redis mock that satisfies getRedis() setup (on/quit/get/setex/incr/expireat). */
function makeRedisInstance(overrides: Record<string, unknown> = {}) {
  return {
    on:       vi.fn(),        // called in getRedis() — must exist
    quit:     vi.fn().mockResolvedValue("OK"),
    get:      vi.fn().mockResolvedValue(null),
    setex:    vi.fn().mockResolvedValue("OK"),
    incr:     vi.fn().mockResolvedValue(1),
    expireat: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

function makeFailingRedisInstance() {
  const error = new Error("ECONNREFUSED — Redis unavailable");
  return makeRedisInstance({
    get:      vi.fn().mockRejectedValue(error),
    setex:    vi.fn().mockRejectedValue(error),
    incr:     vi.fn().mockRejectedValue(error),
    expireat: vi.fn().mockRejectedValue(error),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Redis cache helpers — fail-open resilience", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("cacheGet returns null when Redis get throws (fail-open)", async () => {
    const failingInstance = makeFailingRedisInstance();

    vi.doMock("../../../src/core/config.js", () => ({
      env: { REDIS_URL: "redis://localhost:6379", LOG_LEVEL: "silent", NODE_ENV: "test" },
    }));
    vi.doMock("ioredis", () => ({
      Redis: vi.fn(() => failingInstance),
      default: { Redis: vi.fn(() => failingInstance) },
    }));

    const { cacheGet } = await import("../../../src/infra/redis.js");
    const result = await cacheGet("test-key");

    expect(result).toBeNull();
  });

  it("cacheSet silently resolves when Redis setex throws (fail-open)", async () => {
    const failingInstance = makeFailingRedisInstance();

    vi.doMock("../../../src/core/config.js", () => ({
      env: { REDIS_URL: "redis://localhost:6379", LOG_LEVEL: "silent", NODE_ENV: "test" },
    }));
    vi.doMock("ioredis", () => ({
      Redis: vi.fn(() => failingInstance),
      default: { Redis: vi.fn(() => failingInstance) },
    }));

    const { cacheSet } = await import("../../../src/infra/redis.js");

    // Must not throw — silently degrades
    await expect(cacheSet("test-key", { data: "value" }, 3600)).resolves.toBeUndefined();
  });

  it("incrQuota returns 0 (fail-open) when Redis incr throws", async () => {
    const failingInstance = makeFailingRedisInstance();

    vi.doMock("../../../src/core/config.js", () => ({
      env: { REDIS_URL: "redis://localhost:6379", LOG_LEVEL: "silent", NODE_ENV: "test" },
    }));
    vi.doMock("ioredis", () => ({
      Redis: vi.fn(() => failingInstance),
      default: { Redis: vi.fn(() => failingInstance) },
    }));

    const { incrQuota } = await import("../../../src/infra/redis.js");

    // 0 < any DAILY_SEND_LIMIT → quota check passes → fail-open
    const count = await incrQuota("turicks");
    expect(count).toBe(0);
  });

  it("cacheSet with ttlSeconds=0 does not write (CEO never-cache rule)", async () => {
    const workingInstance = makeRedisInstance();

    vi.doMock("../../../src/core/config.js", () => ({
      env: { REDIS_URL: "redis://localhost:6379", LOG_LEVEL: "silent", NODE_ENV: "test" },
    }));
    vi.doMock("ioredis", () => ({
      Redis: vi.fn(() => workingInstance),
      default: { Redis: vi.fn(() => workingInstance) },
    }));

    const { cacheSet } = await import("../../../src/infra/redis.js");

    await cacheSet("ceo-key", { decision: "strategy" }, 0);

    // setex must NOT have been called — CEO tier must never be cached
    expect(workingInstance.setex).not.toHaveBeenCalled();
  });

  it("cacheGet returns null when Redis hangs (per-operation timeout fires)", async () => {
    // Build Redis instance whose get() hangs indefinitely
    const hangingInstance = makeRedisInstance({
      get: vi.fn(() => new Promise(() => { /* never resolves */ })),
    });

    vi.doMock("../../../src/core/config.js", () => ({
      env: { REDIS_URL: "redis://localhost:6379", LOG_LEVEL: "silent", NODE_ENV: "test" },
    }));
    vi.doMock("ioredis", () => ({
      Redis: vi.fn(() => hangingInstance),
      default: { Redis: vi.fn(() => hangingInstance) },
    }));

    const { cacheGet } = await import("../../../src/infra/redis.js");

    // With 3s timeout in production; use fake timers to avoid slow test
    vi.useFakeTimers();
    const resultPromise = cacheGet("hanging-key");
    vi.advanceTimersByTime(4_000); // advance past 3s timeout
    vi.useRealTimers();

    const result = await resultPromise;
    expect(result).toBeNull();
  }, 10_000);

  it("cacheGet returns cached value when Redis is working", async () => {
    const workingInstance = makeRedisInstance({
      get: vi.fn().mockResolvedValue(JSON.stringify({ name: "Gymshark" })),
    });

    vi.doMock("../../../src/core/config.js", () => ({
      env: { REDIS_URL: "redis://localhost:6379", LOG_LEVEL: "silent", NODE_ENV: "test" },
    }));
    vi.doMock("ioredis", () => ({
      Redis: vi.fn(() => workingInstance),
      default: { Redis: vi.fn(() => workingInstance) },
    }));

    const { cacheGet } = await import("../../../src/infra/redis.js");

    const result = await cacheGet<{ name: string }>("test-key");
    expect(result).toEqual({ name: "Gymshark" });
  });
});
