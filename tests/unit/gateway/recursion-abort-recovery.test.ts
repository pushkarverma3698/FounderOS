/**
 * Regression (P0): after a turn hits the LangGraph recursion limit, the per-chat
 * thread stayed PERMANENTLY wedged — every later message returned "🔁 stuck in a
 * loop" with no routing, and only a manual /reset cleared it. One bad task bricked
 * the whole chat for the founder.
 *
 * Root cause: the GraphRecursionError / BudgetExceededError catch blocks cleared
 * the checkpoint only via clearWedgeQuietly → recoverWedgedThread, which is GATED
 * on isWedgedState(). A recursion abort frequently leaves a snapshot whose `next`
 * is empty (the pending *writes* are what resume-loop, not the snapshot's `next`),
 * so isWedgedState() returned false and the checkpoint survived → the next
 * invoke({messages}) resumed the stuck writes and instantly re-hit the limit.
 *
 * Fix: on an in-process abort we KNOW the run died mid-graph, so we clear the
 * thread UNCONDITIONALLY (mirroring /reset), never gating on isWedgedState().
 *
 * Contract under test (rule #19.3 — test the gateway loop, not the invoker):
 *   recursion abort → clearThreadCheckpoints called once (unconditional), even
 *                     when getState reports a healthy-looking (non-wedged) state
 *   budget abort    → same unconditional clear
 *   next message    → reaches office.invoke and replies cleanly (no wedge)
 *
 * Fake office: { invoke, getState, updateState }. No network, no LangGraph runtime.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphRecursionError } from "@langchain/langgraph";

const clearThreadCheckpoints = vi.fn(async () => 1);
const getOffice = vi.fn();

vi.mock("../../../src/infra/checkpointer.js", () => ({ clearThreadCheckpoints }));
vi.mock("../../../src/agents/office.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/agents/office.js")>();
  return { ...actual, getOffice };
});
// No global halt during tests, and don't touch the real DB on the success path.
vi.mock("../../../src/infra/halt.js", () => ({
  readHalt: vi.fn(async () => null),
  formatHaltNotice: vi.fn(() => ""),
}));
vi.mock("../../../src/infra/conversation-recorder.js", () => ({
  recordConversationEnd: vi.fn(async () => {}),
}));
vi.mock("../../../src/infra/budget.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/infra/budget.js")>();
  return actual;
});

const { runOfficeText } = await import("../../../src/gateway/office-run.js");
const { BudgetExceededError } = await import("../../../src/infra/budget.js");

interface Reply {
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts?: any;
}

function fakeCtx(replies: Reply[]) {
  return {
    chat: { id: 6775330211 },
    from: { id: 6775330211 },
    reply: vi.fn(async (text: string, opts?: unknown) => {
      replies.push({ text, opts });
    }),
    replyWithChatAction: vi.fn(async () => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeMsg(type: string, content: unknown) {
  return { content, _getType: () => type };
}

/**
 * Office whose invoke aborts mid-graph but whose getState reports a HEALTHY
 * (non-wedged) snapshot — exactly the case the old isWedgedState() gate missed.
 */
function abortingOffice(err: Error) {
  return {
    invoke: vi.fn().mockRejectedValue(err),
    getState: vi.fn(async () => ({ next: [], tasks: [], values: { messages: [] } })),
    updateState: vi.fn(async () => {}),
  };
}

/** Office that completes a turn normally. */
function healthyOffice(reply: string) {
  return {
    invoke: vi.fn(async () => ({ messages: [makeMsg("ai", reply)] })),
    getState: vi.fn(async () => ({ next: [], tasks: [], values: { messages: [] } })),
    updateState: vi.fn(async () => {}),
  };
}

describe("runOfficeText — abort recovery clears the thread unconditionally", () => {
  beforeEach(() => {
    clearThreadCheckpoints.mockClear();
    getOffice.mockReset();
  });

  it("recursion abort clears the checkpoint even when getState looks non-wedged", async () => {
    getOffice.mockResolvedValue(abortingOffice(new GraphRecursionError("Recursion limit of 40 reached")));
    const replies: Reply[] = [];

    await runOfficeText(fakeCtx(replies), "draft a linkedin post that loops the validator");

    // The headline fix: a recursion abort ALWAYS clears the thread, regardless of
    // what isWedgedState() thinks of the snapshot.
    expect(clearThreadCheckpoints).toHaveBeenCalledTimes(1);
    expect(clearThreadCheckpoints).toHaveBeenCalledWith("turicks:6775330211");
    // Founder is told the task was cleared.
    expect(replies.some((r) => /stuck|loop|cleared/i.test(r.text))).toBe(true);
  });

  it("budget abort clears the checkpoint unconditionally too", async () => {
    getOffice.mockResolvedValue(abortingOffice(new BudgetExceededError("token budget exceeded")));
    const replies: Reply[] = [];

    await runOfficeText(fakeCtx(replies), "run something expensive");

    expect(clearThreadCheckpoints).toHaveBeenCalledTimes(1);
    expect(clearThreadCheckpoints).toHaveBeenCalledWith("turicks:6775330211");
  });

  it("after a recursion abort, the NEXT message routes cleanly (no permanent wedge)", async () => {
    const good = healthyOffice("Here is your answer.");
    getOffice
      .mockResolvedValueOnce(abortingOffice(new GraphRecursionError("Recursion limit of 40 reached")))
      .mockResolvedValueOnce(good);

    const replies: Reply[] = [];
    const ctx = fakeCtx(replies);

    // Turn 1: aborts and clears.
    await runOfficeText(ctx, "the looping task");
    expect(clearThreadCheckpoints).toHaveBeenCalledTimes(1);

    // Turn 2: must actually reach invoke and reply with the real answer — proving
    // the thread is no longer wedged (no instant "stuck in a loop").
    await runOfficeText(ctx, "now do a normal thing");
    expect(good.invoke).toHaveBeenCalledTimes(1);
    expect(replies.some((r) => /Here is your answer/.test(r.text))).toBe(true);
  });
});
