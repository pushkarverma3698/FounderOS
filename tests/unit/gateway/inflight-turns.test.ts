/**
 * A deploy must not drop a turn the founder is waiting on (AG-037). SIGTERM waits for runs in flight (up to the
 * drain budget); a run still going at exit is written to a ledger, and the next boot tells the founder once per turn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DRAIN_TIMEOUT_MS,
  droppedTurnMessage,
  drainInFlight,
  inFlightCount,
  notifyDroppedTurns,
  recordDroppedTurns,
  withInflight,
} from "../../../src/gateway/inflight-turns.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dropped-turns-"));
  process.env["DROPPED_TURNS_PATH"] = join(dir, "dropped-turns.json");
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env["DROPPED_TURNS_PATH"];
  rmSync(dir, { recursive: true, force: true });
});

/** A turn that runs until the test releases it. */
function holdTurn(text: string, opts: { chatId?: string; record?: boolean } = {}) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const run = withInflight({ chatId: opts.chatId ?? "42", text, record: opts.record ?? true }, async (f) => {
    f.setTurnId(`turn-${text}`);
    await gate;
  });
  return { run, release };
}

describe("drainInFlight", () => {
  it("returns at once when nothing is running", async () => {
    expect(await drainInFlight(DRAIN_TIMEOUT_MS)).toEqual({ drained: true, dropped: [] });
  });

  it("waits for an in-flight run and reports drained", async () => {
    const t = holdTurn("slow");
    expect(inFlightCount()).toBe(1);
    const draining = drainInFlight(DRAIN_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(10_000);
    t.release();
    await t.run;
    expect(await draining).toEqual({ drained: true, dropped: [] });
    expect(inFlightCount()).toBe(0);
  });

  it("times out at the budget and names the run still going", async () => {
    const t = holdTurn("never ends");
    const draining = drainInFlight(DRAIN_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS - 1);
    expect(inFlightCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const res = await draining;
    expect(res.drained).toBe(false);
    expect(res.dropped).toEqual([{ turnId: "turn-never ends", chatId: "42", text: "never ends" }]);
    t.release();
    await t.run;
  });

  it("leaves out runs that are not user turns (record:false)", async () => {
    const t = holdTurn("approval tap", { record: false });
    const draining = drainInFlight(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await draining).toEqual({ drained: false, dropped: [] });
    t.release();
    await t.run;
  });

  it("unregisters a run that throws", async () => {
    await expect(
      withInflight({ chatId: "1", text: "boom", record: true }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(inFlightCount()).toBe(0);
  });
});

describe("dropped-turn ledger", () => {
  const turn = { turnId: "t1", chatId: "42", text: "x".repeat(100) };

  it("tells the founder once per turn, quoting the first 60 characters", async () => {
    await recordDroppedTurns([turn]);
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await notifyDroppedTurns(send)).toBe(1);
    expect(send).toHaveBeenCalledWith("42", `I restarted while answering "${"x".repeat(60)}". Send it again.`);
    expect(droppedTurnMessage(turn.text)).toContain(`"${"x".repeat(60)}"`);
    // A second boot finds nothing left to say.
    expect(await notifyDroppedTurns(send)).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("records the same turnId once even if written twice", async () => {
    await recordDroppedTurns([turn]);
    await recordDroppedTurns([turn]);
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await notifyDroppedTurns(send)).toBe(1);
  });

  it("keeps a turn whose send failed so the next boot retries it", async () => {
    await recordDroppedTurns([turn, { turnId: "t2", chatId: "42", text: "second" }]);
    const send = vi.fn().mockRejectedValueOnce(new Error("telegram down")).mockResolvedValue(undefined);
    expect(await notifyDroppedTurns(send)).toBe(1); // t1 failed, t2 sent
    const retry = vi.fn().mockResolvedValue(undefined);
    expect(await notifyDroppedTurns(retry)).toBe(1);
    expect(retry).toHaveBeenCalledWith("42", expect.stringContaining("x".repeat(60)));
  });

  it("does nothing and writes nothing when no turn was dropped", async () => {
    await recordDroppedTurns([]);
    expect(existsSync(process.env["DROPPED_TURNS_PATH"]!)).toBe(false);
    expect(await notifyDroppedTurns(vi.fn())).toBe(0);
  });

  it("survives a corrupt ledger file", async () => {
    writeFileSync(process.env["DROPPED_TURNS_PATH"]!, "{not json");
    expect(await notifyDroppedTurns(vi.fn())).toBe(0);
  });
});
