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
const insertScheduledTask = vi.fn(async (data: Record<string, unknown>) => ({ id: "task-1", ...data }));
vi.mock("../../../src/db/queries.js", () => ({
  getPendingInterrupt: (...a: unknown[]) => getPendingInterrupt(...(a as [])),
  resolveInterrupt: (...a: unknown[]) => resolveInterrupt(...(a as [])),
  getTodayCostUsd: vi.fn(async () => 0),
  insertScheduledTask: (...a: unknown[]) => insertScheduledTask(...(a as [Record<string, unknown>])),
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
  it("returns a truncated objective while executing, without the internal worker id", () => {
    const state = baseState({ status: "executing", plan: PLAN as never, cursor: 0 });
    expect(progressLabelFor(state)).toBe(
      "🔧 Find the founder's five most recent LinkedIn posts and summ…",
    );
  });

  it("strips tool names the planner wrote into the objective", () => {
    // Verbatim from prod's turn.progress seam, 2026-08-14T08:17:07Z.
    const plan = makePlan("Retrieve the full set of captured jobs using job_state and export it");
    const label = progressLabelFor(baseState({ status: "executing", plan: plan as never, cursor: 0 }))!;

    expect(label).not.toContain("job_state");
    expect(label).not.toContain("jobhunt:");
    expect(label).toContain("Retrieve the full set of captured jobs");
  });

  it("falls back to the generic placeholder when scrubbing empties the objective", () => {
    const plan = makePlan("job_state write_artifact");
    expect(progressLabelFor(baseState({ status: "executing", plan: plan as never, cursor: 0 }))).toBe(
      "🤔 Working on it…",
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

  // T4, 2026-09-05: the jobhunt worker's system prompt is baked in once at
  // kernel boot and always named the default profile — a fallback draft for
  // the second candidate's row came back signed with the wrong name. This is
  // the channel that fixes it: the caller-named profile rides in
  // `configurable.profile_id`, the same per-invocation config `thread_id`
  // already uses, so no kernel rebuild is needed.
  it("carries a caller-provided profileId as configurable.profile_id", async () => {
    const { ctx } = fakeCtx();
    await runKernelText(ctx, "draft this row", "wife-nl-finance");

    const [, config] = fakeKernel.stream.mock.calls[0]! as unknown as [
      unknown,
      { configurable: { thread_id: string; profile_id?: string } },
    ];
    expect(config.configurable.thread_id).toBe("turicks:777");
    expect(config.configurable.profile_id).toBe("wife-nl-finance");
  });

  it("omits profile_id entirely when no profile was named (the general free-text path)", async () => {
    const { ctx } = fakeCtx();
    await runKernelText(ctx, "hello kernel");

    const [, config] = fakeKernel.stream.mock.calls[0]! as unknown as [
      unknown,
      { configurable: Record<string, unknown> },
    ];
    expect("profile_id" in config.configurable).toBe(false);
  });

  it("hands the kernel stream an AbortSignal so a deadline ABORTS the run instead of orphaning it", async () => {
    const { ctx } = fakeCtx();
    await runKernelText(ctx, "hello kernel");

    const [, config] = fakeKernel.stream.mock.calls[0]! as unknown as [unknown, { signal?: AbortSignal }];
    expect(config.signal).toBeInstanceOf(AbortSignal);
    expect(config.signal!.aborted).toBe(false); // a completed turn never aborts
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
    expect(last).toMatch(/rate-limited/i);
    expect(last).not.toContain("Troubleshooting URL");
  });

  /**
   * 2026-07-13 prod audit (turn 49dbaa06 latency review): after the whole model
   * fallback chain is exhausted, don't make the founder manually type "try
   * again" — queue ONE automatic retry of the same turn ~3 minutes out via the
   * scheduled-task sweep and say so.
   */
  it("model exhaustion enqueues ONE automatic retry ~3 min out and tells the founder", async () => {
    fakeKernel.stream.mockImplementation(async function* () {
      throw Object.assign(new Error("429 rate limit"), { status: 429 });
    });
    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "summarise my LinkedIn posts");

    expect(insertScheduledTask).toHaveBeenCalledTimes(1);
    const arg = insertScheduledTask.mock.calls[0]![0]!;
    expect(arg["prompt"]).toBe("summarise my LinkedIn posts");
    expect(arg["chat_id"]).toBe("777");
    expect(String(arg["idempotency_key"])).toMatch(/^auto-retry:/);
    const delayMs = new Date(arg["scheduled_at"] as string).getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(2 * 60 * 1000);
    expect(delayMs).toBeLessThan(4 * 60 * 1000);

    const last = replies.at(-1)!.text;
    expect(last).toMatch(/retry/i);
    expect(last).toMatch(/automatic/i);
    expect(last).not.toMatch(/try again/i); // no manual instruction on the auto-retry path
  });

  it("falls back to the manual 'try again' message when the retry cannot be enqueued", async () => {
    insertScheduledTask.mockRejectedValueOnce(new Error("db unavailable"));
    fakeKernel.stream.mockImplementation(async function* () {
      throw Object.assign(new Error("429 rate limit"), { status: 429 });
    });
    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "summarise my LinkedIn posts");

    expect(insertScheduledTask).toHaveBeenCalledTimes(1);
    expect(replies.at(-1)!.text).toMatch(/try again/i);
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

  it("model exhaustion on a resume does NOT auto-retry (no raw input to replay) — manual message", async () => {
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "int-1", created_at: new Date().toISOString() });
    fakeKernel.stream.mockImplementation(async function* () {
      throw Object.assign(new Error("429 rate limit"), { status: 429 });
    });
    const { ctx, replies } = fakeCtx();
    await resumeKernel(ctx, "approved");

    expect(insertScheduledTask).not.toHaveBeenCalled();
    expect(replies.at(-1)!.text).toMatch(/try again/i);
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

    expect(edits).toEqual(["🔧 Look up recent posts", "✍️ Writing your reply…"]);
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

    expect(edits).toEqual(["🔧 Look up recent posts"]);
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
