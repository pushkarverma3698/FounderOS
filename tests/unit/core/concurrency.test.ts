/**
 * Unit tests — `mapWithConcurrencyLimit`, the bounded-parallelism helper the
 * free lane uses to poll 238 boards without bursting any single origin.
 *
 * Callers depend on results landing at their INPUT index regardless of which
 * call finishes first, and on the in-flight count never exceeding the caller's
 * limit — a burst above the limit reads as abuse to a third-party host's rate
 * limiter, which is the entire reason this helper exists.
 */

import { describe, it, expect, vi } from "vitest";
import { mapWithConcurrencyLimit } from "../../../src/core/concurrency.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapWithConcurrencyLimit", () => {
  it("returns results in INPUT order even when a later item resolves first", async () => {
    const items = [
      { id: 0, delayMs: 30 },
      { id: 1, delayMs: 5 },
      { id: 2, delayMs: 20 },
    ];

    const results = await mapWithConcurrencyLimit(items, 3, async (item) => {
      await delay(item.delayMs);
      return item.id;
    });

    expect(results).toEqual([0, 1, 2]);
  });

  it("never lets peak in-flight calls exceed the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapWithConcurrencyLimit(items, 3, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await delay(2 + (item % 3));
      inFlight -= 1;
      return item;
    });

    expect(peak).toBeLessThanOrEqual(3);
    // With more items than the limit, the pool must actually reach it, not
    // just stay under it — otherwise a limit of 1 and a limit of 3 would both
    // pass this assertion.
    expect(peak).toBe(3);
  });

  it("is correct across MULTIPLE rounds — order and peak both hold with more items than the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const limit = 4;
    const items = Array.from({ length: 20 }, (_, i) => ({ id: i, delayMs: ((20 - i) % 7) + 1 }));

    const results = await mapWithConcurrencyLimit(items, limit, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await delay(item.delayMs);
      inFlight -= 1;
      return item.id;
    });

    expect(results).toEqual(items.map((i) => i.id));
    expect(peak).toBeLessThanOrEqual(limit);
    expect(peak).toBe(limit);
  });

  it("returns [] for empty input, and never calls fn", async () => {
    const fn = vi.fn(async () => 1);

    const results = await mapWithConcurrencyLimit([], 5, fn);

    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("works when the limit is larger than the item count", async () => {
    const items = [1, 2, 3];

    const results = await mapWithConcurrencyLimit(items, 100, async (n) => n * 2);

    expect(results).toEqual([2, 4, 6]);
  });

  it("is fully sequential when the limit is 1 — one call starts only after the last resolves", async () => {
    const startOrder: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const items = [30, 5, 20, 1]; // deliberately out of sorted order

    const results = await mapWithConcurrencyLimit(items, 1, async (ms) => {
      startOrder.push(ms);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await delay(ms);
      inFlight -= 1;
      return ms;
    });

    expect(peak).toBe(1);
    expect(startOrder).toEqual(items);
    expect(results).toEqual(items);
  });
});
