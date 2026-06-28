/**
 * Turn-level timeout guard — a hung office.invoke must abort LOUD, never hang
 * SILENT (rule #19/#22, fail-loud). These prove the race + cleanup semantics so
 * the gateway can surface a deadline to the founder instead of eternal typing dots.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTurnTimeout, TurnTimeoutError } from "../../../src/gateway/turn-timeout.js";

describe("withTurnTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves with the value when the promise settles before the deadline", async () => {
    const fast = Promise.resolve("done");
    await expect(withTurnTimeout(fast, 1000)).resolves.toBe("done");
  });

  it("propagates a real rejection (not masked by the timeout)", async () => {
    const boom = Promise.reject(new Error("real failure"));
    await expect(withTurnTimeout(boom, 1000)).rejects.toThrow("real failure");
  });

  it("rejects with TurnTimeoutError when the promise hangs past the deadline", async () => {
    const hang = new Promise<string>(() => {
      /* never settles — simulates a hung model/tool call */
    });
    const guarded = withTurnTimeout(hang, 5000, "office.invoke");
    const assertion = expect(guarded).rejects.toBeInstanceOf(TurnTimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("carries the deadline + label on the error for a useful founder message", async () => {
    const hang = new Promise<string>(() => {});
    const guarded = withTurnTimeout(hang, 1234, "guard-retry");
    const assertion = guarded.catch((e) => e as TurnTimeoutError);
    await vi.advanceTimersByTimeAsync(1234);
    const err = await assertion;
    expect(err).toBeInstanceOf(TurnTimeoutError);
    expect(err.ms).toBe(1234);
    expect(err.label).toBe("guard-retry");
  });

  it("is a no-op pass-through when ms <= 0 (guard disabled)", async () => {
    await expect(withTurnTimeout(Promise.resolve(42), 0)).resolves.toBe(42);
    await expect(withTurnTimeout(Promise.resolve(7), -1)).resolves.toBe(7);
  });
});
