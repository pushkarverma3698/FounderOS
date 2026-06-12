/**
 * Seam tier — golden-trace tests for the gateway run-loop.
 *
 * This is the test tier that catches the "shifting" gateway bugs (wedge-loop,
 * stale-reply, reject-loop) that unit + contract tests miss: it drives the REAL
 * `runOfficeText` (src/gateway/office-run.ts) with a FAKE office and uses the
 * trace sink (src/infra/trace.ts) as the oracle, asserting the ORDERED sequence
 * of seam events for a turn.
 *
 * Mocking strategy (copied from reject-no-redraft.test.ts): spread the ACTUAL
 * office.js module and override ONLY `getOffice`. The REAL `getPendingApproval`
 * is kept — it reads `state.tasks[].interrupts[].value`, so the fake `getState`
 * shapes drive the HITL/clean branching through the genuine predicate. The wedge
 * branch is driven through the REAL `isWedgedState` (src/infra/wedge.ts): a
 * non-empty `next` with zero pending interrupts == wedged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setTraceSink, type TraceEvent } from "../../../src/infra/trace.js";

const getOffice = vi.fn();
const clearThreadCheckpoints = vi.fn(async () => 1);

vi.mock("../../../src/infra/checkpointer.js", () => ({ clearThreadCheckpoints }));
vi.mock("../../../src/agents/office.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/agents/office.js")>();
  return { ...actual, getOffice };
});

const { runOfficeText } = await import("../../../src/gateway/office-run.js");

// ── Oracle: capture every emitted trace event ───────────────────────────────────
let events: TraceEvent[];
const seams = () => events.map((e) => e.seam);

// ── Fake message shape (OfficeMessage: content + _getType + tool_calls) ─────────
const aiMsg = (text: string) => ({ content: text, _getType: () => "ai", tool_calls: [] as unknown[] });

/** A pending send_email approval, the value an interrupt carries. */
const approval = {
  kind: "approval",
  action: "send_email",
  title: "📧 Send email to jane@example.com?",
  summary: "Subject: Hello",
  preview: "Hi Jane...",
  args: {},
};

// ── Fake grammy Context ─────────────────────────────────────────────────────────
function fakeCtx() {
  return {
    chat: { id: 99 },
    from: { id: 99 },
    message: { text: "hello" },
    reply: vi.fn(async () => {}),
    replyWithChatAction: vi.fn(async () => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/**
 * Build a fake office.
 * `getStateImpls` is a queue of getState return values consumed in call order;
 * once exhausted, the last value repeats. This lets a test make the FIRST
 * getState report a wedged thread while later ones report a clean thread.
 */
function makeOffice(opts: {
  getStateImpls?: Array<() => unknown>;
  invoke?: ReturnType<typeof vi.fn>;
}) {
  const cleanState = () => ({ values: { messages: [] }, next: [], tasks: [] });
  const queue = [...(opts.getStateImpls ?? [])];
  const getState = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return next ? next() : cleanState();
  });
  return {
    getState,
    invoke: opts.invoke ?? vi.fn(async () => ({ messages: [aiMsg("done")] })),
    updateState: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  events = [];
  getOffice.mockReset();
  clearThreadCheckpoints.mockClear();
  setTraceSink((e) => events.push(e));
});

afterEach(() => {
  setTraceSink(null);
  vi.clearAllMocks();
});

describe("seam trace — golden sequences", () => {
  it("clean turn: contains turn.in → route.decided → turn.out (no wedge, no error)", async () => {
    // Every getState reports a clean thread; invoke returns a normal AI reply.
    getOffice.mockResolvedValue(makeOffice({}));

    await runOfficeText(fakeCtx(), "hello");

    const order = seams();
    expect(order).toContain("turn.in");
    expect(order).toContain("route.decided");
    expect(order).toContain("turn.out");
    expect(order).not.toContain("wedge.recovered");
    expect(order).not.toContain("turn.error");
    // turn.in is first, turn.out is last.
    expect(order[0]).toBe("turn.in");
    expect(order.at(-1)).toBe("turn.out");
  });

  it("HITL turn: a pending approval after invoke emits hitl.interrupt and NO turn.out", async () => {
    // invoke leaves the thread parked on a pending approval. After invoke,
    // getState must surface that interrupt so the REAL getPendingApproval fires.
    let parked = false;
    const invoke = vi.fn(async () => {
      parked = true;
      return { messages: [] };
    });
    const office = makeOffice({
      // Pre-invoke getState calls (resolvePendingApproval, recoverWedgedThread,
      // baseLen capture) see a clean thread; post-invoke sees the interrupt.
      getStateImpls: [
        () =>
          parked
            ? { values: { messages: [] }, next: ["comms"], tasks: [{ interrupts: [{ value: approval }] }] }
            : { values: { messages: [] }, next: [], tasks: [] },
      ],
      invoke,
    });
    getOffice.mockResolvedValue(office);

    await runOfficeText(fakeCtx(), "email jane");

    const order = seams();
    expect(order).toContain("hitl.interrupt");
    expect(order).not.toContain("turn.out"); // paused — the turn did not complete
  });

  it("wedge turn: a wedged thread emits wedge.recovered BEFORE route.decided", async () => {
    // First getState (recoverWedgedThread) reports a wedged thread: a pending
    // node (next non-empty) with ZERO interrupts → isWedgedState() === true.
    // Note: resolvePendingApproval runs FIRST and calls getPendingApproval,
    // which also calls getState — so the FIRST getState must NOT have a pending
    // interrupt (else it's served as an approval, not wiped as a wedge). A
    // wedged shape (no interrupts) satisfies both: getPendingApproval returns
    // null, then isWedgedState returns true on the same shape.
    const office = makeOffice({
      getStateImpls: [
        // calls 1 (getPendingApproval) + 2 (recoverWedgedThread): wedged shape
        () => ({ values: { messages: [] }, next: ["tools"], tasks: [] }),
        () => ({ values: { messages: [] }, next: ["tools"], tasks: [] }),
        // call 3+ (baseLen capture, post-invoke approval check): clean
        () => ({ values: { messages: [] }, next: [], tasks: [] }),
      ],
    });
    getOffice.mockResolvedValue(office);

    await runOfficeText(fakeCtx(), "do a thing");

    const order = seams();
    expect(order).toContain("wedge.recovered");
    expect(order.indexOf("wedge.recovered")).toBeLessThan(order.indexOf("route.decided"));
  });
});
