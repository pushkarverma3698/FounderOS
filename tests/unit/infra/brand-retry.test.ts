/**
 * Unit tests for the brand-validation retry bound.
 *
 * Why: the brand validator returns an error string so the ReAct agent re-drafts.
 * That loop was unbounded — an oscillating model never converged and ran to the
 * recursion limit (GraphRecursionError). This tracker is the deterministic cap.
 *
 * Pure in-memory functions with an injectable clock → no mocks, no real timers.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  BRAND_MAX_RETRIES,
  BRAND_RETRY_TTL_MS,
  brandRetryKey,
  recordBrandFailure,
  clearBrandRetries,
  brandRetryCount,
  _resetBrandRetries,
} from "../../../src/infra/brand-retry.js";

beforeEach(() => _resetBrandRetries());

describe("brandRetryKey", () => {
  it("is stable per thread+channel", () => {
    expect(brandRetryKey("t1", "linkedin")).toBe(brandRetryKey("t1", "linkedin"));
  });

  it("differs by thread and by channel", () => {
    expect(brandRetryKey("t1", "linkedin")).not.toBe(brandRetryKey("t2", "linkedin"));
    expect(brandRetryKey("t1", "linkedin")).not.toBe(brandRetryKey("t1", "outreach"));
  });

  it("falls back to a constant key when thread is undefined", () => {
    expect(brandRetryKey(undefined, "linkedin")).toBe("no-thread::linkedin");
  });
});

describe("recordBrandFailure", () => {
  it("increments on consecutive failures", () => {
    const k = brandRetryKey("t1", "linkedin");
    expect(recordBrandFailure(k, 1000)).toBe(1);
    expect(recordBrandFailure(k, 1100)).toBe(2);
    expect(recordBrandFailure(k, 1200)).toBe(3);
  });

  it("resets the count after the TTL gap (new drafting session)", () => {
    const k = brandRetryKey("t1", "linkedin");
    expect(recordBrandFailure(k, 1000)).toBe(1);
    expect(recordBrandFailure(k, 1100)).toBe(2);
    // gap > TTL → fresh session
    expect(recordBrandFailure(k, 1100 + BRAND_RETRY_TTL_MS + 1)).toBe(1);
  });

  it("keeps separate counts per session key", () => {
    const a = brandRetryKey("t1", "linkedin");
    const b = brandRetryKey("t2", "linkedin");
    recordBrandFailure(a, 1000);
    recordBrandFailure(a, 1010);
    expect(recordBrandFailure(b, 1020)).toBe(1);
    expect(recordBrandFailure(a, 1030)).toBe(3);
  });
});

describe("clearBrandRetries + brandRetryCount", () => {
  it("clear resets the count to 0", () => {
    const k = brandRetryKey("t1", "linkedin");
    recordBrandFailure(k, 1000);
    recordBrandFailure(k, 1010);
    expect(brandRetryCount(k, 1020)).toBe(2);
    clearBrandRetries(k);
    expect(brandRetryCount(k, 1030)).toBe(0);
  });

  it("brandRetryCount returns 0 for an expired entry", () => {
    const k = brandRetryKey("t1", "linkedin");
    recordBrandFailure(k, 1000);
    expect(brandRetryCount(k, 1000 + BRAND_RETRY_TTL_MS + 1)).toBe(0);
  });
});

describe("convergence guarantee", () => {
  it("an oscillating draft exceeds the cap in exactly BRAND_MAX_RETRIES+1 failures", () => {
    const k = brandRetryKey("t1", "linkedin");
    let attempt = 0;
    let exceeded = false;
    // Simulate the model oscillating forever; the cap must trip deterministically.
    for (let i = 0; i < 100; i++) {
      attempt = recordBrandFailure(k, 1000 + i * 10);
      if (attempt > BRAND_MAX_RETRIES) {
        exceeded = true;
        break;
      }
    }
    expect(exceeded).toBe(true);
    expect(attempt).toBe(BRAND_MAX_RETRIES + 1);
  });
});
