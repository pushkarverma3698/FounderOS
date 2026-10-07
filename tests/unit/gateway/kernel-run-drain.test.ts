/**
 * AG-037 wiring: a real runKernelText / resumeKernel is "in flight" while the kernel runs, so SIGTERM's drain
 * waits for it, and a text turn that outlives the drain is reported dropped under the trace's turnId.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "grammy";

const DONE_STATE = { reply: "All done.", mission: { status: "done", plan: null, cursor: 0, goal: "" } };

let release!: () => void;
let started!: () => void;
async function* heldStream() {
  started();
  await new Promise<void>((r) => (release = r));
  yield DONE_STATE;
}
const fakeKernel = {
  stream: vi.fn((..._args: unknown[]) => heldStream()),
  getState: vi.fn(async () => ({ tasks: [] })),
  updateState: vi.fn(async (..._args: unknown[]) => ({})),
};
vi.mock("../../../src/gateway/kernel-boot.js", () => ({ getKernel: vi.fn(async () => fakeKernel) }));
vi.mock("../../../src/db/queries.js", () => ({
  getPendingInterrupt: vi.fn(async () => null),
  resolveInterrupt: vi.fn(async () => ({})),
  getTodayCostUsd: vi.fn(async () => 0),
  insertScheduledTask: vi.fn(async () => ({})),
}));
vi.mock("../../../src/infra/halt.js", () => ({ readHalt: vi.fn(async () => null), formatHaltNotice: vi.fn(() => "halted") }));

const { runKernelText, resumeKernel } = await import("../../../src/gateway/kernel-run.js");
const { drainInFlight, inFlightCount } = await import("../../../src/gateway/inflight-turns.js");
import { setTraceSink, type TraceEvent } from "../../../src/infra/trace.js";

function fakeCtx(): Context {
  let id = 1;
  return {
    chat: { id: 777 },
    reply: vi.fn(async () => ({ message_id: id++ })),
    api: { editMessageText: vi.fn(async () => undefined), deleteMessage: vi.fn(async () => undefined) },
  } as unknown as Context;
}

/** Starts a turn and resolves once the kernel stream is actually running. */
async function startHeld(run: () => Promise<void>): Promise<{ done: Promise<void> }> {
  const running = new Promise<void>((r) => (started = r));
  const done = run();
  await running;
  return { done };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("kernel runs are in flight while they run", () => {
  it("a text turn is counted until its reply is sent, and the drain waits for it", async () => {
    const { done } = await startHeld(() => runKernelText(fakeCtx(), "write the quarterly summary"));
    expect(inFlightCount()).toBe(1);
    const draining = drainInFlight(5_000);
    release();
    await done;
    expect(await draining).toEqual({ drained: true, dropped: [] });
    expect(inFlightCount()).toBe(0);
  });

  it("a text turn that outlives the drain is named as dropped with the founder's words and chat", async () => {
    vi.useFakeTimers();
    const events: TraceEvent[] = [];
    setTraceSink((e) => events.push(e));
    try {
      const { done } = await startHeld(() => runKernelText(fakeCtx(), "write the quarterly summary"));
      const draining = drainInFlight(100);
      await vi.advanceTimersByTimeAsync(100);
      const res = await draining;
      expect(res.drained).toBe(false);
      expect(res.dropped).toHaveLength(1);
      expect(res.dropped[0]).toMatchObject({ chatId: "777", text: "write the quarterly summary" });
      // The id is the trace's, not the placeholder, so the journal and the notice line up.
      const turnIn = events.find((e) => e.seam === "turn.in");
      expect(turnIn).toBeDefined();
      expect(res.dropped[0]!.turnId).toBe(turnIn!.turnId);
      release();
      await done;
    } finally {
      setTraceSink(null);
      vi.useRealTimers();
    }
  });

  it("an approval tap is waited for but never reported as a dropped message", async () => {
    vi.useFakeTimers();
    try {
      const { done } = await startHeld(() => resumeKernel(fakeCtx(), "approved"));
      expect(inFlightCount()).toBe(1);
      const draining = drainInFlight(100);
      await vi.advanceTimersByTimeAsync(100);
      expect(await draining).toEqual({ drained: false, dropped: [] });
      release();
      await done;
    } finally {
      vi.useRealTimers();
    }
  });
});
