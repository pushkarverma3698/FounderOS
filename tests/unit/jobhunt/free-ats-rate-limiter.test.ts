import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ATS_RATE_PROFILES,
  createPlatformLimiter,
  createPlatformLimiters,
  getSharedLimiters,
  resetSharedLimiters,
} from "../../../src/tools/jobhunt/free-ats-rate-limiter.js";
import type { FreeAts } from "../../../src/tools/jobhunt/free-boards.js";

beforeEach(() => {
  resetSharedLimiters();
});

describe("ATS_RATE_PROFILES", () => {
  it("defines rate limiting and concurrency parameters for all ATS platforms", () => {
    const requiredPlatforms: FreeAts[] = [
      "greenhouse",
      "lever",
      "ashby",
      "smartrecruiters",
      "workable",
      "personio",
      "recruitee",
      "workday",
      "teamtailor",
      "bamboohr",
    ];

    for (const ats of requiredPlatforms) {
      const profile = ATS_RATE_PROFILES[ats];
      expect(profile).toBeDefined();
      expect(profile.maxConcurrent).toBeGreaterThan(0);
      expect(profile.minTimeMs).toBeGreaterThan(0);
      expect(profile.burst).toBeGreaterThanOrEqual(profile.maxConcurrent);
      expect(profile.refillRatePerSec).toBeGreaterThan(0);
    }
  });

  it("assigns Greenhouse the specified 8 req/s, 12 burst, 4 maxConcurrent profile", () => {
    expect(ATS_RATE_PROFILES.greenhouse).toEqual({
      maxConcurrent: 4,
      minTimeMs: 125,
      burst: 12,
      refillRatePerSec: 8,
    });
  });

  it("assigns Recruitee the conservative 1.5 req/s, 3 burst, 1 maxConcurrent profile", () => {
    expect(ATS_RATE_PROFILES.recruitee).toEqual({
      maxConcurrent: 1,
      minTimeMs: 666,
      burst: 3,
      refillRatePerSec: 1,
    });
  });
});

describe("createPlatformLimiter", () => {
  it("enforces maxConcurrent in zeroDelay mode without adding artificial delays", async () => {
    const limiter = createPlatformLimiter("greenhouse", { zeroDelay: true });
    let inFlight = 0;
    let peak = 0;

    const tasks = Array.from({ length: 10 }, () =>
      limiter.schedule(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
      }),
    );

    await Promise.all(tasks);

    expect(peak).toBeLessThanOrEqual(ATS_RATE_PROFILES.greenhouse.maxConcurrent);
  });

  it("enforces strict serial execution for Recruitee (maxConcurrent = 1)", async () => {
    const limiter = createPlatformLimiter("recruitee", { zeroDelay: true });
    let inFlight = 0;
    let peak = 0;

    const tasks = Array.from({ length: 5 }, () =>
      limiter.schedule(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      }),
    );

    await Promise.all(tasks);

    expect(peak).toBe(1);
  });
});

describe("createPlatformLimiters & getSharedLimiters", () => {
  it("creates a map containing limiters for all platforms", () => {
    const limiters = createPlatformLimiters({ zeroDelay: true });
    expect(Object.keys(limiters)).toHaveLength(Object.keys(ATS_RATE_PROFILES).length);
    expect(limiters.greenhouse).toBeDefined();
    expect(limiters.lever).toBeDefined();
    expect(limiters.recruitee).toBeDefined();
  });

  it("reuses the same shared instance until reset", () => {
    const l1 = getSharedLimiters();
    const l2 = getSharedLimiters();
    expect(l1).toBe(l2);

    resetSharedLimiters();
    const l3 = getSharedLimiters();
    expect(l3).not.toBe(l1);
  });
});
