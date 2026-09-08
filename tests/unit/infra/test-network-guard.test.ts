/**
 * The repo-wide test network guard must actually be installed.
 *
 * tests/setup.ts builds a `blockedFetch` and, on 2026-09-08, stopped assigning
 * it to `globalThis.fetch` — the function was still defined, the comment above
 * it still promised "no unit test can ever hit a real host", and every unit test
 * in the repo could reach the network again. Nothing failed, which is the point:
 * a dead guard is indistinguishable from a working one until a test quietly
 * pulls live data, or bills a real model.
 *
 * This asserts the guard is armed, so deleting it fails LOUD next time.
 */

import { describe, it, expect } from "vitest";

describe("test network guard", () => {
  it("blocks a real fetch instead of attempting the connection", async () => {
    // The guard throws synchronously; the `.then` turns that into a rejection so
    // one assertion covers it whether it throws or rejects. Without the guard
    // this reaches the network and fails with "fetch failed" instead.
    await expect(
      Promise.resolve().then(() => fetch("http://127.0.0.1:1/should-never-connect")),
    ).rejects.toThrow(/test-network-guard/);
  });

  it("still exposes the real fetch for suites that opt back in", () => {
    expect(typeof (globalThis as { __realFetch?: typeof fetch }).__realFetch).toBe("function");
  });
});
