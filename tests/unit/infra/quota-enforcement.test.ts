/**
 * TDD — Daily send quota enforcement via Redis INCR.
 *
 * Tests:
 *   1. incrQuota increments and returns correct count
 *   2. EXPIREAT called on first increment only
 *   3. Redis down → returns 0 (fail-open)
 *   4. Quota enforcement contract: count > limit → block
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Redis mock builder ─────────────────────────────────────────────────────────

function makeRedisInstance(overrides: Record<string, unknown> = {}) {
  return {
    on:       vi.fn(),
    quit:     vi.fn().mockResolvedValue("OK"),
    get:      vi.fn().mockResolvedValue(null),
    setex:    vi.fn().mockResolvedValue("OK"),
    incr:     vi.fn().mockResolvedValue(1),
    expireat: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("incrQuota — counter and fail-open behaviour", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("increments and returns count on each call", async () => {
    let counter = 0;
    const workingInstance = makeRedisInstance({
      incr: vi.fn(async () => ++counter),
    });

    vi.doMock("../../../src/core/config.js", () => ({
      env: { REDIS_URL: "redis://localhost:6379", LOG_LEVEL: "silent", NODE_ENV: "test" },
    }));
    vi.doMock("ioredis", () => ({
      Redis: vi.fn(() => workingInstance),
      default: { Redis: vi.fn(() => workingInstance) },
    }));

    const { incrQuota } = await import("../../../src/infra/redis.js");

    const first  = await incrQuota("turicks");
    const second = await incrQuota("turicks");
    const third  = await incrQuota("turicks");

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(third).toBe(3);
  });

  it("sets EXPIREAT on first increment (count === 1) but not on subsequent", async () => {
    let counter = 0;
    const expireatFn = vi.fn().mockResolvedValue(1);
    const workingInstance = makeRedisInstance({
      incr: vi.fn(async () => ++counter),
      expireat: expireatFn,
    });

    vi.doMock("../../../src/core/config.js", () => ({
      env: { REDIS_URL: "redis://localhost:6379", LOG_LEVEL: "silent", NODE_ENV: "test" },
    }));
    vi.doMock("ioredis", () => ({
      Redis: vi.fn(() => workingInstance),
      default: { Redis: vi.fn(() => workingInstance) },
    }));

    const { incrQuota } = await import("../../../src/infra/redis.js");

    await incrQuota("turicks"); // count=1 → should call expireat
    await incrQuota("turicks"); // count=2 → should NOT call expireat again

    expect(expireatFn).toHaveBeenCalledTimes(1);
  });

  it("returns 0 when Redis incr throws (fail-open — quota not enforced)", async () => {
    const failingInstance = makeRedisInstance({
      incr:     vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      expireat: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });

    vi.doMock("../../../src/core/config.js", () => ({
      env: { REDIS_URL: "redis://localhost:6379", LOG_LEVEL: "silent", NODE_ENV: "test" },
    }));
    vi.doMock("ioredis", () => ({
      Redis: vi.fn(() => failingInstance),
      default: { Redis: vi.fn(() => failingInstance) },
    }));

    const { incrQuota } = await import("../../../src/infra/redis.js");

    const count = await incrQuota("turicks");

    // 0 < any DAILY_SEND_LIMIT → quota check passes → fail-open
    expect(count).toBe(0);
  });
});

describe("Quota enforcement contract", () => {
  it("count <= DAILY_SEND_LIMIT means send proceeds", () => {
    const DAILY_SEND_LIMIT = 10;
    const shouldProceed = (count: number) => count <= DAILY_SEND_LIMIT;

    expect(shouldProceed(1)).toBe(true);
    expect(shouldProceed(10)).toBe(true);
    expect(shouldProceed(11)).toBe(false);
  });

  it("count > DAILY_SEND_LIMIT means send is blocked", () => {
    const DAILY_SEND_LIMIT = 10;
    const shouldBlock = (count: number) => count > DAILY_SEND_LIMIT;

    expect(shouldBlock(11)).toBe(true);
    expect(shouldBlock(100)).toBe(true);
    expect(shouldBlock(10)).toBe(false);
  });
});
