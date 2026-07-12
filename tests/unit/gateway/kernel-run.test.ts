/**
 * v3 gateway run loop — tested with a FAKE kernel (repo rule #19.3: the
 * gateway loop gets direct unit tests; never rely on the eval harness).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "grammy";

const DONE_STATE = { reply: "All done.", mission: { status: "done", plan: null, cursor: 0, goal: "" } };

async function* singleYield(state: unknown) {
  yield state;
}

const fakeKernel = {
  stream: vi.fn((..._args: unknown[]) => singleYield(DONE_STATE)),
  getState: vi.fn(async () => ({ tasks: [] })),
  updateState: vi.fn(async (..._args: unknown[]) => ({})),
};
vi.mock("../../../src/gateway/kernel-boot.js", () => ({
  getKernel: vi.fn(async () => fakeKernel),
}));

const resolveInterrupt = vi.fn(async () => ({}));
const getPendingInterrupt = vi.fn(async (): Promise<unknown> => null);
vi.mock("../../../src/db/queries.js", () => ({
  getPendingInterrupt: (...a: unknown[]) => getPendingInterrupt(...(a as [])),
  resolveInterrupt: (...a: unknown[]) => resolveInterrupt(...(a as [])),
  getTodayCostUsd: vi.fn(async () => 0),
}));

vi.mock("../../../src/infra/halt.js", () => ({
  readHalt: vi.fn(async () => null),
  formatHaltNotice: vi.fn(() => "halted"),
}));

const { runKernelText, resumeKernel, progressLabelFor } = await import("../../../src/gateway/kernel-run.js");
import { Command } from "@langchain/langgraph";
import type { KernelStateType } from "../../../src/kernel/index.js";

function baseState(overrides: Partial<KernelStateType["mission"]>): KernelStateType {
  return {
    turn: { id: "t1", chat_id: "1", received_at: "", raw_input: "" },
    mission: { goal: "g", status: "planning", plan: null, cursor: 0, ...overrides },
    results: [],
    attempts: {},
    failure: null,
    scratch: [],
    step_receipts: [],
    reply: "",
    last_turn: null,
    history: [],
  } as unknown as KernelStateType;
}

function makePlan(objective: string) {
  return {
    schema_version: 1,
    goal: "g",
    steps: [
      {
        step_id: "s1",
        worker: "research",
        objective,
        inputs: {},
        expected: { kind: "data", schema_ref: "research.findings" },
        constraints: { max_tool_calls: 3, hitl_required: false },
      },
    ],
  } as const;
}

const PLAN = makePlan("Find the founder's five most recent LinkedIn posts and summarize engagement");

describe("progressLabelFor", () => {
  it("returns a worker + truncated-objective label while executing", () => {
    const state = baseState({ status: "executing", plan: PLAN as never, cursor: 0 });
    expect(progressLabelFor(state)).toBe(
      "🔧 research: Find the founder's five most recent LinkedIn posts and summ…",
    );
  });

  it("returns the writing label while synthesizing", () => {
    const state = baseState({ status: "synthesizing", plan: PLAN as never, cursor: 1 });
    expect(progressLabelFor(state)).toBe("✍️ Writing your reply…");
  });

  it("returns null while planning (nothing worth showing yet)", () => {
    const state = baseState({ status: "planning", plan: null, cursor: 0 });
    expect(progressLabelFor(state)).toBeNull();
  });

  it("returns null when done or failed", () => {
    expect(progressLabelFor(baseState({ status: "done", plan: PLAN as never, cursor: 1 }))).toBeNull();
    expect(progressLabelFor(baseState({ status: "failed", plan: PLAN as never, cursor: 0 }))).toBeNull();
  });

  it("returns null defensively when cursor is out of range (mirrors dispatch's own bounds check)", () => {
    const state = baseState({ status: "executing", plan: PLAN as never, cursor: 5 });
    expect(progressLabelFor(state)).toBeNull();
  });

  it("returns null when executing with no plan (should not happen, but must not throw)", () => {
    const state = baseState({ status: "executing", plan: null, cursor: 0 });
    expect(progressLabelFor(state)).toBeNull();
  });

  it("returns null when mission is undefined (the initial stream snapshot, before the plan node runs)", () => {
    const state = { turn: { id: "t1", chat_id: "1", received_at: "", raw_input: "" } } as unknown as KernelStateType;
    expect(progressLabelFor(state)).toBeNull();
  });
});

interface Reply {
  text: string;
  opts?: { reply_markup?: unknown };
}

function fakeCtx(): { ctx: Context; replies: Reply[]; edits: string[]; deletedIds: number[] } {
  const replies: Reply[] = [];
  const edits: string[] = [];
  const deletedIds: number[] = [];
  let nextMessageId = 1;
  const ctx = {
    chat: { id: 777 },
    reply: vi.fn(async (text: string, opts?: Reply["opts"]) => {
      replies.push({ text, ...(opts !== undefined ? { opts } : {}) });
      return { message_id: nextMessageId++ };
    }),
    api: {
      editMessageText: vi.fn(async (_chatId: number, _messageId: number, text: string) => {
        edits.push(text);
      }),
      deleteMessage: vi.fn(async (_chatId: number, messageId: number) => {
        deletedIds.push(messageId);
      }),
    },
  } as unknown as Context;
  return { ctx, replies, edits, deletedIds };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeKernel.stream.mockImplementation(() => singleYield(DONE_STATE));
  fakeKernel.getState.mockResolvedValue({ tasks: [] } as never);
  getPendingInterrupt.mockResolvedValue(null);
});

describe("runKernelText", () => {
  it("invokes the kernel with the turn record and sends the reply", async () => {
    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "hello kernel");

    expect(fakeKernel.stream).toHaveBeenCalledTimes(1);
    const [input, config] = fakeKernel.stream.mock.calls[0]! as unknown as [
      { turn: { raw_input: string; chat_id: string } },
      { configurable: { thread_id: string } },
    ];
    expect(input.turn.raw_input).toBe("hello kernel");
    expect(config.configurable.thread_id).toBe("turicks:777");
    expect(replies).toHaveLength(2); // progress placeholder + final reply
    expect(replies.at(-1)!.text).toContain("All done.");
  });

  it("pauses on a pending approval: sends the card with Approve/Reject, no reply", async () => {
    fakeKernel.getState.mockResolvedValue({
      tasks: [
        {
          interrupts: [
            {
              value: {
                kind: "approval",
                action: "send_email",
                title: "Send email to a@b.c?",
                summary: "Subject: hi",
                preview: "hello body",
                args: {},
              },
            },
          ],
        },
      ],
    } as never);

    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "send the email");

    expect(replies).toHaveLength(2); // progress placeholder + approval card
    expect(replies.at(-1)!.text).toContain("Send email to a@b.c?");
    expect(replies.at(-1)!.opts?.reply_markup).toBeDefined();
  });

  it("kernel invoke failure → loud ❌ error reply (never silent, never a wipe)", async () => {
    fakeKernel.stream.mockImplementation(async function* () {
      throw new Error("planner exploded");
    });
    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "boom");

    expect(replies).toHaveLength(2); // progress placeholder + error reply
    expect(replies.at(-1)!.text).toContain("❌");
    expect(replies.at(-1)!.text).toContain("planner exploded");
  });

  /**
   * LIVE FAILURE 2026-07-12 33f64116: turn 68eae59d died on model exhaustion
   * with reply="" in the checkpoint, so summarizePreviousTurn skipped it and
   * "Try again" retried the EMAIL task from two turns earlier. A hard-failed
   * turn must be folded into thread history so the next planner call sees it.
   */
  it("hard kernel failure folds the failed turn into thread history (33f64116 amnesia regression)", async () => {
    const failedTurn = {
      id: "t-dead",
      chat_id: "777",
      received_at: new Date().toISOString(),
      raw_input: "Read previous LinkedIn posts and summarise",
    };
    fakeKernel.stream.mockImplementation(async function* () {
      throw new Error("429 Provider returned error");
    });
    fakeKernel.getState.mockResolvedValue({ tasks: [], values: { turn: failedTurn } } as never);

    const { ctx } = fakeCtx();
    await runKernelText(ctx, "Read previous LinkedIn posts and summarise");

    expect(fakeKernel.updateState).toHaveBeenCalledTimes(1);
    const [, values] = fakeKernel.updateState.mock.calls[0]! as unknown as [
      unknown,
      { last_turn: { id: string }; reply: string; failure: { stage: string; retryable: boolean } },
    ];
    expect(values.last_turn.id).toBe("t-dead");
    expect(values.reply).toContain("429");
    expect(values.failure.stage).toBe("model");
    expect(values.failure.retryable).toBe(true);
  });

  it("the folded values make the failed turn visible to summarizePreviousTurn", async () => {
    const failedTurn = { id: "t-dead", chat_id: "777", received_at: "2026-07-12T01:25:12Z", raw_input: "summarise posts" };
    fakeKernel.stream.mockImplementation(async function* () {
      throw new Error("429 Provider returned error");
    });
    fakeKernel.getState.mockResolvedValue({ tasks: [], values: { turn: failedTurn } } as never);

    const { ctx } = fakeCtx();
    await runKernelText(ctx, "summarise posts");

    const [, values] = fakeKernel.updateState.mock.calls[0]! as unknown as [unknown, Record<string, unknown>];
    const { summarizePreviousTurn } = await import("../../../src/kernel/planner.js");
    const nextState = {
      ...values,
      mission: { goal: "summarise posts", status: "executing", plan: { steps: [] }, cursor: 0 },
      history: [],
    } as never;
    const summary = summarizePreviousTurn(nextState);
    expect(summary?.turn_id).toBe("t-dead");
    expect(summary?.outcome).toBe("failed");
    expect(summary?.user_input).toBe("summarise posts");
  });

  it("history fold failure never masks the founder error reply", async () => {
    fakeKernel.stream.mockImplementation(async function* () {
      throw new Error("planner exploded");
    });
    fakeKernel.getState.mockRejectedValue(new Error("checkpoint read failed"));

    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "boom");

    expect(replies.at(-1)!.text).toContain("❌");
  });

  it("model rate-limit exhaustion gets a friendly reply, not a raw stack (68eae59d)", async () => {
    fakeKernel.stream.mockImplementation(async function* () {
      throw Object.assign(new Error("429 Provider returned error\n\nTroubleshooting URL: https://..."), {
        status: 429,
      });
    });
    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "boom");

    const last = replies.at(-1)!.text;
    expect(last).toContain("overloaded");
    expect(last).not.toContain("Troubleshooting URL");
  });
});

describe("resumeKernel", () => {
  it("resolves the DB approval row and resumes the graph with the decision", async () => {
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "int-1", created_at: new Date().toISOString() });
    const { ctx, replies } = fakeCtx();
    await resumeKernel(ctx, "approved");

    expect(resolveInterrupt).toHaveBeenCalledWith("int-1", "approved");
    const [cmd] = fakeKernel.stream.mock.calls[0]! as unknown as [Command];
    expect(cmd).toBeInstanceOf(Command);
    expect(replies.at(-1)!.text).toContain("All done.");
  });

  it("a multi-step plan can pause AGAIN on the next gated step", async () => {
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "int-1", created_at: new Date().toISOString() });
    fakeKernel.getState.mockResolvedValue({
      tasks: [{ interrupts: [{ value: { kind: "approval", action: "x", title: "Second approval?", summary: "s", preview: "", args: {} } }] }],
    } as never);
    const { ctx, replies } = fakeCtx();
    await resumeKernel(ctx, "approved");

    expect(replies.at(-1)!.text).toContain("Second approval?");
    expect(replies.at(-1)!.opts?.reply_markup).toBeDefined();
  });
});

describe("progress streaming", () => {
  const EXECUTING_STEP1 = {
    reply: "",
    mission: { status: "executing", cursor: 0, goal: "g", plan: makePlan("Look up recent posts") },
  };
  const SYNTHESIZING = {
    reply: "",
    mission: { ...EXECUTING_STEP1.mission, status: "synthesizing", cursor: 1 },
  };
  const DONE = { reply: "Here you go.", mission: { ...EXECUTING_STEP1.mission, status: "done", cursor: 1 } };

  it("edits the placeholder as the label changes, then deletes it before the final reply", async () => {
    fakeKernel.stream.mockImplementation(async function* () {
      yield EXECUTING_STEP1;
      yield SYNTHESIZING;
      yield DONE;
    });

    const { ctx, replies, edits, deletedIds } = fakeCtx();
    await runKernelText(ctx, "do the thing");

    expect(edits).toEqual(["🔧 research: Look up recent posts", "✍️ Writing your reply…"]);
    expect(deletedIds).toEqual([1]); // placeholder was message_id 1
    expect(replies.at(-1)!.text).toContain("Here you go.");
  });

  it("does not re-edit when consecutive states produce the same label", async () => {
    fakeKernel.stream.mockImplementation(async function* () {
      yield EXECUTING_STEP1;
      yield EXECUTING_STEP1; // agent/tools loop — same step, same label
      yield DONE;
    });

    const { ctx, edits } = fakeCtx();
    await runKernelText(ctx, "do the thing");

    expect(edits).toEqual(["🔧 research: Look up recent posts"]);
  });

  it("deletes the placeholder even when the stream throws", async () => {
    fakeKernel.stream.mockImplementation(async function* () {
      yield EXECUTING_STEP1;
      throw new Error("worker exploded");
    });

    const { ctx, deletedIds, replies } = fakeCtx();
    await runKernelText(ctx, "do the thing");

    expect(deletedIds).toEqual([1]);
    expect(replies.at(-1)!.text).toContain("❌");
  });

  it("still shows progress on resumeKernel for a multi-step plan continuing after approval", async () => {
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "int-1", created_at: new Date().toISOString() });
    fakeKernel.stream.mockImplementation(async function* () {
      yield SYNTHESIZING;
      yield DONE;
    });

    const { ctx, edits, deletedIds } = fakeCtx();
    await resumeKernel(ctx, "approved");

    expect(edits).toEqual(["✍️ Writing your reply…"]);
    expect(deletedIds).toEqual([1]);
  });
});
