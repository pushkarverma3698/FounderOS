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
    const err = (await assertion) as TurnTimeoutError;
    expect(err).toBeInstanceOf(TurnTimeoutError);
    expect(err.ms).toBe(1234);
    expect(err.label).toBe("guard-retry");
  });

  it("is a no-op pass-through when ms <= 0 (guard disabled)", async () => {
    await expect(withTurnTimeout(Promise.resolve(42), 0)).resolves.toBe(42);
    await expect(withTurnTimeout(Promise.resolve(7), -1)).resolves.toBe(7);
  });

  it("fires onDeadline exactly once when the deadline wins (the run gets ABORTED, not abandoned)", async () => {
    const onDeadline = vi.fn();
    const hang = new Promise<string>(() => {});
    const guarded = withTurnTimeout(hang, 5000, "kernel.invoke", onDeadline);
    const assertion = expect(guarded).rejects.toBeInstanceOf(TurnTimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(onDeadline).toHaveBeenCalledTimes(1);
  });

  it("never fires onDeadline when the promise settles in time", async () => {
    const onDeadline = vi.fn();
    await expect(withTurnTimeout(Promise.resolve("ok"), 5000, "kernel.invoke", onDeadline)).resolves.toBe("ok");
    await vi.advanceTimersByTimeAsync(10_000); // timer must be cleared, not merely raced past
    expect(onDeadline).not.toHaveBeenCalled();
  });

  it("a throwing onDeadline cannot mask the TurnTimeoutError", async () => {
    const hang = new Promise<string>(() => {});
    const guarded = withTurnTimeout(hang, 5000, "kernel.invoke", () => {
      throw new Error("abort() blew up");
    });
    const assertion = expect(guarded).rejects.toBeInstanceOf(TurnTimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("hands the caller a touch() function synchronously via onArm", async () => {
    const onArm = vi.fn();
    await withTurnTimeout(Promise.resolve("ok"), 1000, "kernel.invoke", undefined, onArm);
    expect(onArm).toHaveBeenCalledTimes(1);
    expect(typeof onArm.mock.calls[0]![0]).toBe("function");
  });

  it("touch() postpones the deadline — a turn with periodic activity never times out (AG-015/B5)", async () => {
    // Simulates a single long-running tool call (e.g. claude_code) inside one
    // graph step: no new LangGraph state is yielded for the whole duration, but
    // the tool's own progress stream calls touch() every few seconds. The outer
    // guard must not fire as long as that keeps happening, even well past the
    // original deadline.
    let touch!: () => void;
    const hang = new Promise<string>(() => {});
    const guarded = withTurnTimeout(hang, 5000, "kernel.invoke", undefined, (fn) => {
      touch = fn;
    });
    let settled = false;
    guarded.catch(() => {
      settled = true;
    });

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(4000); // would have fired at 5000 without a touch
      touch();
    }
    // Still alive after 16s against a 5s deadline, purely because touch() kept firing.
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
  });

  it("touch() does not extend past a genuine hang once activity stops", async () => {
    let touch!: () => void;
    const hang = new Promise<string>(() => {});
    const guarded = withTurnTimeout(hang, 5000, "kernel.invoke", undefined, (fn) => {
      touch = fn;
    });
    const assertion = expect(guarded).rejects.toBeInstanceOf(TurnTimeoutError);
    await vi.advanceTimersByTimeAsync(3000);
    touch(); // one burst of activity, then silence
    await vi.advanceTimersByTimeAsync(4999); // 3000 + 4999 = 7999ms since touch, deadline is 5000ms after it
    await vi.advanceTimersByTimeAsync(2); // now past the re-armed deadline
    await assertion;
  });

  it("the abandoned promise's LATE rejection after a timeout is marked handled (no fatal unhandledRejection)", async () => {
    // Before this guard: the orphaned run's AbortError/provider error rejected
    // with nobody listening → src/index.ts unhandledRejection → process.exit(1),
    // minutes after the founder already saw the timeout message. Vitest fails
    // the suite on any unhandled rejection, so this test IS the assertion.
    let rejectLate!: (err: Error) => void;
    const hang = new Promise<string>((_res, rej) => {
      rejectLate = rej;
    });
    const guarded = withTurnTimeout(hang, 5000, "kernel.invoke");
    const assertion = expect(guarded).rejects.toBeInstanceOf(TurnTimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    rejectLate(new Error("AbortError: the orphaned run finally died"));
    await vi.advanceTimersByTimeAsync(1); // flush microtasks — would surface an unhandled rejection
  });
});
