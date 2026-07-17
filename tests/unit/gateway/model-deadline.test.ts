/**
 * raceWithDeadline — TDD for the 2026-07-17 prod incident: during a Gemini
 * 503 storm, one in-flight fallback call sat 254s with no per-request timeout
 * (journalctl: silence from 16:58:50 until the 300s turn watchdog fired at
 * 17:03:04). Every model call must carry its own hard deadline so the retry
 * and fallback layers stay bounded and the turn fails FAST with the real
 * provider error instead of a generic 5-minute hang.
 */
import { describe, it, expect } from "vitest";
import { raceWithDeadline, ModelCallTimeoutError } from "../../../src/gateway/model-deadline.js";
import { is503Error, isModelFallbackError } from "../../../src/agents/model.js";

const hangForever = <T>(): Promise<T> => new Promise<T>(() => {});

describe("raceWithDeadline", () => {
  it("rejects a hung promise with ModelCallTimeoutError once the deadline fires", async () => {
    await expect(raceWithDeadline(hangForever(), 20, "planner")).rejects.toBeInstanceOf(
      ModelCallTimeoutError,
    );
  });

  it("resolves with the promise's value when it settles before the deadline", async () => {
    await expect(raceWithDeadline(Promise.resolve("ok"), 1_000, "planner")).resolves.toBe("ok");
  });

  it("propagates the promise's own rejection when it loses to no one", async () => {
    await expect(
      raceWithDeadline(Promise.reject(new Error("provider says no")), 1_000, "planner"),
    ).rejects.toThrow("provider says no");
  });

  it("returns the promise unchanged when ms <= 0 (guard disabled)", async () => {
    const p = Promise.resolve("raw");
    expect(raceWithDeadline(p, 0, "planner")).toBe(p);
  });

  it("names the label and deadline in the error so FailureReports point at the real component", async () => {
    await expect(raceWithDeadline(hangForever(), 20, "worker")).rejects.toThrow(/worker/);
  });
});

describe("ModelCallTimeoutError classification", () => {
  it("is retriable (ETIMEDOUT transport class) so withModelRetry absorbs it", () => {
    expect(is503Error(new ModelCallTimeoutError(45_000, "planner"))).toBe(true);
  });

  it("engages the fallback chain like any other transient provider failure", () => {
    expect(isModelFallbackError(new ModelCallTimeoutError(45_000, "planner"))).toBe(true);
  });
});
