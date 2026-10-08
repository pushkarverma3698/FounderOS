/**
 * AG-047 — a message sent while an approval card waits runs AFTER the card is answered, not "send it again".
 *
 * Prod 10-07 21:38:48: "Where are we stuck and failing?" arrived while a card waited, was refused and dropped;
 * the founder approved the card 3 s later and the question was never answered.
 *
 * The queries are an in-memory stand-in for the hitl_approvals row (hold / claim / resolve behave like the SQL).
 * The kernel is fake and records start/end of each stream so the ORDER of turns is asserted, not just their count.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "grammy";

interface Row {
  interrupt_id: string;
  status: string;
  created_at: string;
  callback_data: string;
  held_text: string | null;
  held_at: Date | null;
}

const CARD = JSON.stringify({ action: "create_issue", title: "Create the issue?", summary: "s", preview: "p", args: {} });
let row: Row | null = null;

function freshRow(over: Partial<Row> = {}): Row {
  return { interrupt_id: "abcd1234-0000", status: "pending", created_at: new Date(Date.now() - 60_000).toISOString(), callback_data: CARD, held_text: null, held_at: null, ...over };
}

const getPendingInterrupt = vi.fn(async (): Promise<Row | null> => (row && row.status === "pending" ? { ...row } : null));
const resolveInterrupt = vi.fn(async (_id: string, status: string) => {
  if (row && row.status === "pending") row.status = status;
  return true;
});
const holdMessageOnInterrupt = vi.fn(async (id: string, text: string, at: Date = new Date()) => {
  if (!row || row.interrupt_id !== id || row.status !== "pending") return false;
  row.held_text = text;
  row.held_at = at;
  return true;
});
const claimHeldMessage = vi.fn(async (id: string) => {
  if (!row || row.interrupt_id !== id || !row.held_text) return null;
  const out = { text: row.held_text, heldAt: row.held_at ?? new Date() };
  row.held_text = null;
  row.held_at = null;
  return out;
});
vi.mock("../../../src/db/queries.js", () => ({
  getPendingInterrupt: (...a: unknown[]) => getPendingInterrupt(...(a as [])),
  resolveInterrupt: (...a: unknown[]) => resolveInterrupt(...(a as [string, string])),
  holdMessageOnInterrupt: (...a: unknown[]) => holdMessageOnInterrupt(...(a as [string, string, Date?])),
  claimHeldMessage: (...a: unknown[]) => claimHeldMessage(...(a as [string])),
  getTodayCostUsd: vi.fn(async () => 0),
  logLlmCost: vi.fn(async () => undefined),
}));
vi.mock("../../../src/infra/halt.js", () => ({ readHalt: vi.fn(async () => null), formatHaltNotice: vi.fn(() => "halted") }));

const events: string[] = [];
const doneState = (reply: string) => ({ reply, mission: { status: "done", plan: null, cursor: 0, goal: "" } });
const fakeKernel = {
  stream: vi.fn(async function* (input: unknown) {
    const label = (input as { turn?: { raw_input: string } }).turn?.raw_input ?? "RESUME";
    events.push(`start:${label}`);
    await new Promise((r) => setTimeout(r, 15));
    events.push(`end:${label}`);
    yield doneState(label === "RESUME" ? "RESUMED REPLY" : `ANSWER TO: ${label}`);
  }),
  getState: vi.fn(async () => ({ tasks: [] })),
  updateState: vi.fn(async () => ({})),
};
vi.mock("../../../src/gateway/kernel-boot.js", () => ({ getKernel: vi.fn(async () => fakeKernel) }));

const { runKernelText, resumeKernel } = await import("../../../src/gateway/kernel-run.js");
const HOLD_REPLY = "⏸ Holding this until you answer the card above.";

function fakeCtx(): { ctx: Context; texts: string[] } {
  const texts: string[] = [];
  let id = 1;
  const ctx = {
    chat: { id: 777 },
    reply: vi.fn(async (text: string) => {
      texts.push(text);
      events.push(`reply:${text.slice(0, 40)}`);
      return { message_id: id++ };
    }),
    api: { editMessageText: vi.fn(async () => undefined), deleteMessage: vi.fn(async () => undefined) },
  } as unknown as Context;
  return { ctx, texts };
}

const heldTurns = () =>
  fakeKernel.stream.mock.calls.map((c) => (c[0] as { turn?: { raw_input: string } }).turn?.raw_input).filter(Boolean);

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  row = freshRow();
});

describe("a message sent while a card waits (AG-047)", () => {
  it("is held, not run; the card is re-sent and nothing says 'send it again'", async () => {
    const { ctx, texts } = fakeCtx();
    await runKernelText(ctx, "Where are we stuck and failing?");

    expect(fakeKernel.stream).not.toHaveBeenCalled();
    expect(texts).toContain(HOLD_REPLY);
    expect(texts.join("\n")).toContain("Create the issue?");
    expect(texts.join("\n")).not.toMatch(/send (it|your message) again/i);
    expect(row!.held_text).toBe("Where are we stuck and failing?");
  });

  it("runs after the founder approves, once the resume turn has replied (the 10-07 bug)", async () => {
    const { ctx, texts } = fakeCtx();
    await runKernelText(ctx, "Where are we stuck and failing?");
    await resumeKernel(ctx, "approved", "abcd1234");

    expect(fakeKernel.stream).toHaveBeenCalledTimes(2);
    const order = events.filter((e) => /^(start|end):/.test(e));
    expect(order).toEqual(["start:RESUME", "end:RESUME", "start:Where are we stuck and failing?", "end:Where are we stuck and failing?"]);
    expect(texts.findIndex((t) => t.includes("RESUMED REPLY"))).toBeLessThan(texts.findIndex((t) => t.includes("ANSWER TO: Where are we stuck")));
    expect(texts.some((t) => t.includes("ANSWER TO: Where are we stuck and failing?"))).toBe(true);
    expect(row!.held_text).toBeNull();
  });

  it("is not read as the answer to the card: the resume carries the tap's decision only", async () => {
    const { ctx } = fakeCtx();
    await runKernelText(ctx, "yes approve it");
    await resumeKernel(ctx, "rejected", "abcd1234");

    const resumeInput = fakeKernel.stream.mock.calls[0]![0] as { resume?: string };
    expect(resumeInput.resume).toBe("rejected");
    expect(heldTurns()).toEqual(["yes approve it"]); // a reject still runs the held text, as a normal turn
  });

  it("keeps only the newest message when several arrive, and says it replaced the earlier one", async () => {
    const { ctx, texts } = fakeCtx();
    await runKernelText(ctx, "first question");
    await runKernelText(ctx, "second question");
    await resumeKernel(ctx, "approved", "abcd1234");

    expect(texts.some((t) => t.includes("replaces the message I was holding"))).toBe(true);
    expect(heldTurns()).toEqual(["second question"]);
  });

  it("survives a restart between hold and approve: the text lives on the row, not in memory", async () => {
    const { ctx } = fakeCtx();
    await runKernelText(ctx, "what time is it in Amsterdam?");
    vi.resetModules(); // a deploy: every in-memory structure is gone, only the database row remains
    const fresh = await import("../../../src/gateway/kernel-run.js");
    await fresh.resumeKernel(ctx, "approved", "abcd1234");

    expect(heldTurns()).toEqual(["what time is it in Amsterdam?"]);
  });

  it("drops a message held longer than the restore window, naming it and saying why", async () => {
    const { ctx, texts } = fakeCtx();
    await runKernelText(ctx, "old question");
    row!.held_at = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await resumeKernel(ctx, "approved", "abcd1234");

    expect(fakeKernel.stream).toHaveBeenCalledTimes(1); // the resume only
    expect(texts.some((t) => t.includes("old question") && /over 2 hours ago/.test(t))).toBe(true);
    expect(row!.held_text).toBeNull();
  });

  it("when the card expires unanswered, the held message is dropped with a line and the new message still runs", async () => {
    const { ctx, texts } = fakeCtx();
    await runKernelText(ctx, "held one");
    row!.created_at = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await runKernelText(ctx, "fresh one");

    expect(texts.some((t) => t.includes("held one") && /expired/.test(t))).toBe(true);
    expect(heldTurns()).toEqual(["fresh one"]);
  });

  it("a stale tap (wrong nonce) resolves nothing and runs nothing", async () => {
    const { ctx, texts } = fakeCtx();
    await runKernelText(ctx, "still waiting");
    await resumeKernel(ctx, "approved", "ffffffff");

    expect(fakeKernel.stream).not.toHaveBeenCalled();
    expect(row!.held_text).toBe("still waiting");
    expect(texts.some((t) => /expired or belongs to an older task/.test(t))).toBe(true);
  });

  it("if the resume raised the NEXT card, the text moves behind that card instead of running", async () => {
    const { runHeldMessageAfterResume } = await import("../../../src/gateway/held-message.js");
    const { ctx } = fakeCtx();
    const run = vi.fn(async () => undefined);
    row = freshRow({ interrupt_id: "old00000-0000", status: "approved", held_text: "later", held_at: new Date() });
    getPendingInterrupt.mockResolvedValueOnce(freshRow({ interrupt_id: "new00000-0000" }));
    holdMessageOnInterrupt.mockImplementationOnce(async (id: string, text: string, at?: Date) => {
      expect(id).toBe("new00000-0000");
      expect(text).toBe("later");
      expect(at).toBeInstanceOf(Date);
      return true;
    });
    await runHeldMessageAfterResume(ctx, { interruptId: "old00000-0000", threadId: "turicks:777", run });

    expect(run).not.toHaveBeenCalled();
    expect(holdMessageOnInterrupt).toHaveBeenCalledTimes(1);
  });

  it("tells the founder when the card was answered between the read and the hold", async () => {
    holdMessageOnInterrupt.mockResolvedValueOnce(false);
    const { ctx, texts } = fakeCtx();
    await runKernelText(ctx, "too late");

    expect(fakeKernel.stream).not.toHaveBeenCalled();
    expect(texts.some((t) => /answered just now/.test(t))).toBe(true);
    expect(texts).not.toContain(HOLD_REPLY);
  });
});
