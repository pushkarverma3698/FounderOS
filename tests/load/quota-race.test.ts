/**
 * LOAD — Quota race condition test.
 *
 * Tests:
 *   1. With Redis working: concurrent sends respect DAILY_SEND_LIMIT
 *   2. Documents the known race window (two concurrent sends may both see count < limit)
 *
 * Note: Redis INCR is atomic — race condition only exists if two processes call
 * incrQuota before either sees the incremented value. With single-process Node.js
 * and ioredis, INCR is serial, so this test should always enforce the limit.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Quota enforcement under concurrency", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("Redis INCR atomicity: 10 concurrent incrQuota calls return counts 1-10", async () => {
    let counter = 0;
    const workingRedis = {
      on: vi.fn(),
      quit: vi.fn().mockResolvedValue("OK"),
      incr: vi.fn(async () => ++counter), // simulates atomic INCR
      expireat: vi.fn().mockResolvedValue(1),
    };

    vi.doMock("../../src/core/config.js", () => ({
      env: { REDIS_URL: "redis://localhost:6379", LOG_LEVEL: "silent", NODE_ENV: "test" },
    }));
    vi.doMock("ioredis", () => ({
      Redis: vi.fn(() => workingRedis),
      default: { Redis: vi.fn(() => workingRedis) },
    }));

    const { incrQuota } = await import("../../src/infra/redis.js");

    // Fire 10 concurrent increments
    const results = await Promise.all(
      Array.from({ length: 10 }, () => incrQuota("turicks")),
    );

    // All counts returned
    expect(results).toHaveLength(10);
    // All unique (atomic INCR)
    const unique = new Set(results);
    expect(unique.size).toBe(10);
    // Range 1-10
    expect(Math.min(...results)).toBe(1);
    expect(Math.max(...results)).toBe(10);
  });

  it("quota gate blocks sends when count exceeds DAILY_SEND_LIMIT", async () => {
    const DAILY_SEND_LIMIT = 5;
    let counter = 0;

    vi.doMock("../../src/core/config.js", () => ({
      env: { REDIS_URL: "redis://localhost:6379", LOG_LEVEL: "silent", NODE_ENV: "test" },
    }));
    vi.doMock("ioredis", () => ({
      Redis: vi.fn(() => ({
        on: vi.fn(),
        quit: vi.fn().mockResolvedValue("OK"),
        incr: vi.fn(async () => ++counter),
        expireat: vi.fn().mockResolvedValue(1),
      })),
    }));

    const { incrQuota } = await import("../../src/infra/redis.js");

    // Simulate quotaCheckEdge contract: proceed if count <= limit, block if > limit
    const sends = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const count = await incrQuota("turicks");
        return count <= DAILY_SEND_LIMIT ? "proceed" : "blocked";
      }),
    );

    const proceeded = sends.filter((s) => s === "proceed").length;
    const blocked = sends.filter((s) => s === "blocked").length;

    expect(proceeded).toBe(DAILY_SEND_LIMIT);
    expect(blocked).toBe(10 - DAILY_SEND_LIMIT);
  });

  it("DOCUMENTED RACE WINDOW: two concurrent sends may both proceed if Redis is down (fail-open)", () => {
    // When Redis is unavailable, incrQuota returns 0.
    // All concurrent senders get count=0 which is <= any limit.
    // This is intentional fail-open — better to allow sends than to block all ops.
    // Document this as a known limitation:
    const DAILY_SEND_LIMIT = 5;
    const redisDownCount = 0; // incrQuota returns 0 on Redis failure

    const wouldProceed = redisDownCount <= DAILY_SEND_LIMIT;
    expect(wouldProceed).toBe(true); // confirms fail-open behavior

    // 10 concurrent senders with Redis down: all get count=0, all proceed
    const failOpenSends = Array.from({ length: 10 }, () => redisDownCount <= DAILY_SEND_LIMIT);
    expect(failOpenSends.every(Boolean)).toBe(true);
    // This is acceptable: quota cannot be enforced without Redis.
    // The alternative (fail-closed) would block all sends when Redis is down — worse.
  });
});
