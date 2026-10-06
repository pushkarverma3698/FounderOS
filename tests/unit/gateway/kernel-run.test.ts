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
const getTodayCostUsd = vi.fn(async (): Promise<number> => 0);
const insertScheduledTask = vi.fn(async (data: Record<string, unknown>) => ({ id: "task-1", ...data }));
vi.mock("../../../src/db/queries.js", () => ({
  getPendingInterrupt: (...a: unknown[]) => getPendingInterrupt(...(a as [])),
  resolveInterrupt: (...a: unknown[]) => resolveInterrupt(...(a as [])),
  getTodayCostUsd: (...a: unknown[]) => getTodayCostUsd(...(a as [])),
  insertScheduledTask: (...a: unknown[]) => insertScheduledTask(...(a as [Record<string, unknown>])),
}));

const readHalt = vi.fn(async (): Promise<unknown> => null);
vi.mock("../../../src/infra/halt.js", () => ({
  readHalt: (...a: unknown[]) => readHalt(...(a as [])),
  formatHaltNotice: vi.fn(() => "halted"),
}));

const recordHitlDecisionTurn = vi.fn();
vi.mock("../../../src/gateway/hitl-decision-turn.js", () => ({
  recordHitlDecisionTurn: (...a: unknown[]) => recordHitlDecisionTurn(...a),
}));

const { runKernelText, resumeKernel, progressLabelFor } = await import("../../../src/gateway/kernel-run.js");
import { Command } from "@langchain/langgraph";
import type { KernelStateType } from "../../../src/kernel/index.js";
import { setTraceSink, type TraceEvent } from "../../../src/infra/trace.js";

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
  it("names the goal and the step count on step 1, then the truncated objective, without the internal worker id", () => {
    const state = baseState({ status: "executing", plan: PLAN as never, cursor: 0 });
    expect(progressLabelFor(state)).toBe(
      "On it: g, 1 step\nStep 1 of 1: Find the founder's five most recent LinkedIn posts and summ…",
    );
  });

  it("says 'Step k of N' on later steps, and does not repeat the goal line", () => {
    const plan = {
      ...makePlan("first"),
      goal: "Ship the report",
      steps: [makePlan("first").steps[0], { ...makePlan("second").steps[0], step_id: "s2" }, { ...makePlan("third").steps[0], step_id: "s3" }],
    };
    expect(progressLabelFor(baseState({ status: "executing", plan: plan as never, cursor: 0 }))).toBe(
      "On it: Ship the report, 3 steps\nStep 1 of 3: first",
    );
    expect(progressLabelFor(baseState({ status: "executing", plan: plan as never, cursor: 1 }))).toBe("Step 2 of 3: second");
    expect(progressLabelFor(baseState({ status: "executing", plan: plan as never, cursor: 2 }))).toBe("Step 3 of 3: third");
  });

  it("scrubs and clips the goal the same way as the objective", () => {
    const plan = { ...makePlan("do it"), goal: `Use job_state to export every captured job and then ${"x".repeat(80)}` };
    const label = progressLabelFor(baseState({ status: "executing", plan: plan as never, cursor: 0 }))!;
    const goalLine = label.split("\n")[0]!;
    expect(goalLine).not.toContain("job_state");
    expect(goalLine.startsWith("On it: ")).toBe(true);
    expect(goalLine.endsWith(", 1 step")).toBe(true);
    expect(goalLine.length).toBeLessThanOrEqual("On it: ".length + 60 + ", 1 step".length);
  });

  it("strips tool names the planner wrote into the objective", () => {
    // Verbatim from prod's turn.progress seam, 2026-08-14T08:17:07Z.
    const plan = makePlan("Retrieve the full set of captured jobs using job_state and export it");
    const label = progressLabelFor(baseState({ status: "executing", plan: plan as never, cursor: 0 }))!;

    expect(label).not.toContain("job_state");
    expect(label).not.toContain("jobhunt:");
    expect(label).toContain("Step 1 of 1: Retrieve the full set of captured jobs");
  });

  it("falls back to the generic placeholder when scrubbing empties the objective", () => {
    const plan = makePlan("job_state write_artifact");
    expect(progressLabelFor(baseState({ status: "executing", plan: plan as never, cursor: 0 }))).toBe(
      "🤔 Working on it…",
    );
  });

  it("says all N steps are done while synthesizing", () => {
    const state = baseState({ status: "synthesizing", plan: PLAN as never, cursor: 1 });
    expect(progressLabelFor(state)).toBe("All 1 step done");
    const three = { ...makePlan("a"), steps: [1, 2, 3].map((n) => ({ ...makePlan("a").steps[0], step_id: `s${n}` })) };
    expect(progressLabelFor(baseState({ status: "synthesizing", plan: three as never, cursor: 3 }))).toBe("All 3 steps done");
  });

  it("falls back to the writing label when synthesizing without a plan", () => {
    expect(progressLabelFor(baseState({ status: "synthesizing", plan: null, cursor: 0 }))).toBe("✍️ Writing your reply…");
  });

  it("returns the planning label while planning", () => {
    const state = baseState({ status: "planning", plan: null, cursor: 0 });
    expect(progressLabelFor(state)).toBe("🧠 Planning…");
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
  readHalt.mockResolvedValue(null);
  getTodayCostUsd.mockResolvedValue(0);
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

  it("carries a command-forced engine as configurable.engine, and omits it otherwise", async () => {
    const { ctx } = fakeCtx();
    await runKernelText(ctx, "/claude fix the thing", undefined, "claude");
    const [, forced] = fakeKernel.stream.mock.calls[0]! as unknown as [unknown, { configurable: Record<string, unknown> }];
    expect(forced.configurable["engine"]).toBe("claude");

    fakeKernel.stream.mockClear();
    await runKernelText(ctx, "hello kernel");
    const [, plain] = fakeKernel.stream.mock.calls[0]! as unknown as [unknown, { configurable: Record<string, unknown> }];
    expect("engine" in plain.configurable).toBe(false);
  });

  it("hands the kernel stream an AbortSignal so a deadline ABORTS the run instead of orphaning it", async () => {
    const { ctx } = fakeCtx();
    await runKernelText(ctx, "hello kernel");

    const [, config] = fakeKernel.stream.mock.calls[0]! as unknown as [unknown, { signal?: AbortSignal }];
    expect(config.signal).toBeInstanceOf(AbortSignal);
    expect(config.signal!.aborted).toBe(false); // a completed turn never aborts
  });

  // AG-015/B5. A single graph step running one long tool call (claude_code,
  // own budget 15min) yields no new LangGraph state for its whole duration —
  // nothing resets a fixed outer deadline. configurable.onTurnActivity is the
  // channel src/agents/agent-tools/engineering.ts uses to report real
  // progress from INSIDE that one step, keeping the outer guard alive.
  it("exposes configurable.onTurnActivity wired to the turn-timeout's touch()", async () => {
    const { ctx } = fakeCtx();
    await runKernelText(ctx, "hello kernel");

    const [, config] = fakeKernel.stream.mock.calls[0]! as unknown as [
      unknown,
      { configurable: { onTurnActivity?: () => void } },
    ];
    expect(typeof config.configurable.onTurnActivity).toBe("function");
    // By the time anything would actually call this (claude_code's own
    // progress stream, well after the turn starts), withTurnTimeout has
    // already armed and handed back touch() — calling it here must be safe.
    expect(() => config.configurable.onTurnActivity!()).not.toThrow();
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

  it("a new message while an approval card is pending is NOT run: the card is re-sent and the founder is told (2026-10-03 lost-dispatch bug)", async () => {
    getPendingInterrupt.mockResolvedValue({
      interrupt_id: "abcd1234-0000",
      created_at: new Date(Date.now() - 60_000).toISOString(),
      callback_data: JSON.stringify({
        action: "dispatch_antigravity",
        title: "Dispatch task to Antigravity?",
        summary: "s",
        preview: "p",
        args: {},
      }),
    });
    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "/task second thing");

    expect(fakeKernel.stream).not.toHaveBeenCalled();
    const all = replies.map((r) => r.text).join("\n");
    expect(all).toContain("Dispatch task to Antigravity?"); // the pending card, again
    expect(all).toMatch(/approve or reject/i);
    expect(all).toMatch(/send (it|your message) again/i);
  });

  it("an approval pending longer than the restore window is expired, not allowed to block the chat forever", async () => {
    getPendingInterrupt.mockResolvedValue({
      interrupt_id: "dead0000-1111",
      created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      callback_data: "{}",
    });
    const { ctx } = fakeCtx();
    await runKernelText(ctx, "hello");

    expect(resolveInterrupt).toHaveBeenCalledWith("dead0000-1111", "expired");
    expect(fakeKernel.stream).toHaveBeenCalledTimes(1);
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

describe("withChatTurnLock queue-ack", () => {
  // Regression for a promise-identity bug (PR #731): the per-chat lock map's
  // cleanup used to compare `chatTurnChains.get(key) === slot`, but the map
  // held `tail.then(() => slot)` — a DIFFERENT promise object — so the compare
  // was always false and the entry was never deleted. That silently broke this
  // exact queue-ack feature: once a chat had sent one message, EVERY later
  // message — even sent hours apart, one at a time — would falsely show
  // "finishing the current request first."
  it("acks a message that arrives mid-turn, then cleans up so a later, sequential message is not falsely flagged", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    fakeKernel.stream.mockImplementationOnce(async function* () {
      await gate;
      yield DONE_STATE;
    });

    const { ctx: ctx1 } = fakeCtx();
    const { ctx: ctx2, replies: replies2 } = fakeCtx();

    const first = runKernelText(ctx1, "first message");
    const second = runKernelText(ctx2, "second message");

    expect(replies2.some((r) => r.text.includes("finishing the current request first"))).toBe(true);

    releaseFirst();
    await Promise.all([first, second]);

    const { ctx: ctx3, replies: replies3 } = fakeCtx();
    await runKernelText(ctx3, "third message, well after the first two finished");
    expect(replies3.some((r) => r.text.includes("finishing the current request first"))).toBe(false);
  });
});

describe("resumeKernel", () => {
  it("files the approve or reject tap as a turn under the chat's thread, keyed on the pending interrupt", async () => {
    recordHitlDecisionTurn.mockClear();
    const card = JSON.stringify({ title: "Send email to Anna" });
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "int-9", created_at: new Date().toISOString(), callback_data: card });
    await resumeKernel(fakeCtx().ctx, "rejected");
    expect(recordHitlDecisionTurn).toHaveBeenCalledTimes(1);
    const [threadId, input] = recordHitlDecisionTurn.mock.calls[0]! as [string, Record<string, unknown>];
    expect(threadId).toMatch(/:/);
    expect(input).toMatchObject({ interruptId: "int-9", decision: "rejected", cardJson: card });
  });

  it("files nothing for a stale card tap or when no approval is pending", async () => {
    recordHitlDecisionTurn.mockClear();
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "current-1", created_at: new Date().toISOString() });
    await resumeKernel(fakeCtx().ctx, "approved", "stale123");
    getPendingInterrupt.mockResolvedValue(null);
    await resumeKernel(fakeCtx().ctx, "approved");
    expect(recordHitlDecisionTurn).not.toHaveBeenCalled();
  });

  it("resolves the DB approval row and resumes the graph with the decision", async () => {
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "int-1", created_at: new Date().toISOString() });
    const { ctx, replies } = fakeCtx();
    await resumeKernel(ctx, "approved");

    expect(resolveInterrupt).toHaveBeenCalledWith("int-1", "approved");
    const [cmd] = fakeKernel.stream.mock.calls[0]! as unknown as [Command];
    expect(cmd).toBeInstanceOf(Command);
    expect(replies.at(-1)!.text).toContain("All done.");
  });

  it("resumes with the engine the approved card showed, so the tap cannot file for a different CLI", async () => {
    const card = { action: "dispatch_antigravity_task", args: { title: "t", engine: "claude" } };
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "int-1", created_at: new Date().toISOString(), callback_data: JSON.stringify(card) });
    await resumeKernel(fakeCtx().ctx, "approved");
    const [, withEngine] = fakeKernel.stream.mock.calls[0]! as unknown as [unknown, { configurable: Record<string, unknown> }];
    expect(withEngine.configurable["engine"]).toBe("claude");

    fakeKernel.stream.mockClear();
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "int-2", created_at: new Date().toISOString(), callback_data: '{"action":"send_email","args":{"to":"x"}}' });
    await resumeKernel(fakeCtx().ctx, "approved");
    const [, plain] = fakeKernel.stream.mock.calls[0]! as unknown as [unknown, { configurable: Record<string, unknown> }];
    expect("engine" in plain.configurable).toBe(false);
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

  // AG-015/B7. Previously the orphan-row cleanup sat only after a SUCCESSFUL
  // resume, so a timeout (or any other error, as simulated here) skipped it
  // entirely, leaving interrupt()'s re-execution artifact stuck forever —
  // recoverable only by restorePendingApproval resurfacing a stale card.
  it("resolves interrupt()'s re-execution artifact even when the resume stream throws", async () => {
    getPendingInterrupt
      .mockResolvedValueOnce({ interrupt_id: "int-1", created_at: new Date().toISOString() }) // what triggered this resume
      .mockResolvedValueOnce({ interrupt_id: "int-2", created_at: new Date().toISOString() }); // re-inserted by interrupt() re-execution
    fakeKernel.stream.mockImplementation(async function* () {
      throw new Error("simulated stream failure");
    });
    const { ctx } = fakeCtx();
    await resumeKernel(ctx, "approved");

    expect(resolveInterrupt).toHaveBeenCalledWith("int-1", "approved");
    expect(resolveInterrupt).toHaveBeenCalledWith("int-2", "approved");
  });

  it("does NOT touch a genuinely new pending approval when cleaning up after a throw", async () => {
    getPendingInterrupt.mockResolvedValueOnce({ interrupt_id: "int-1", created_at: new Date().toISOString() });
    // A genuine new pause exists per the checkpoint (getPendingKernelApproval
    // reads this), even though the stream itself also threw.
    fakeKernel.getState.mockResolvedValue({
      tasks: [{ interrupts: [{ value: { kind: "approval", action: "x", title: "Real pause", summary: "s", preview: "", args: {} } }] }],
    } as never);
    fakeKernel.stream.mockImplementation(async function* () {
      throw new Error("simulated stream failure");
    });
    const { ctx } = fakeCtx();
    await resumeKernel(ctx, "approved");

    expect(resolveInterrupt).toHaveBeenCalledTimes(1); // only "int-1", the original trigger
    expect(resolveInterrupt).toHaveBeenCalledWith("int-1", "approved");
  });

  // Nonce (PR #731): the approval card embeds the first 8 chars of the interrupt
  // id in its callback_data, so a stale card (editMessageReplyMarkup failed to
  // clear it, or the founder scrolled back to an old one) can't resolve a
  // DIFFERENT, newer pending interrupt just because it happens to be current.
  it("rejects a stale HITL card whose nonce doesn't match the currently pending interrupt", async () => {
    getPendingInterrupt.mockResolvedValue({
      interrupt_id: "current-9f8e7d6c",
      created_at: new Date().toISOString(),
    });
    const { ctx, replies } = fakeCtx();
    await resumeKernel(ctx, "approved", "stale123");

    expect(resolveInterrupt).not.toHaveBeenCalled();
    expect(replies.at(-1)!.text).toMatch(/expired|older task/i);
  });

  it("accepts a HITL card whose nonce matches the currently pending interrupt", async () => {
    getPendingInterrupt.mockResolvedValue({
      interrupt_id: "current-9f8e7d6c",
      created_at: new Date().toISOString(),
    });
    const { ctx } = fakeCtx();
    await resumeKernel(ctx, "approved", "current-");

    expect(resolveInterrupt).toHaveBeenCalledWith("current-9f8e7d6c", "approved");
  });

  it("omitting the nonce (older bot version, or a pre-deploy card) resumes exactly as before", async () => {
    getPendingInterrupt.mockResolvedValue({
      interrupt_id: "current-9f8e7d6c",
      created_at: new Date().toISOString(),
    });
    const { ctx } = fakeCtx();
    await resumeKernel(ctx, "approved");

    expect(resolveInterrupt).toHaveBeenCalledWith("current-9f8e7d6c", "approved");
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

    expect(edits).toEqual(["On it: g, 1 step\nStep 1 of 1: Look up recent posts", "All 1 step done"]);
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

    expect(edits).toEqual(["On it: g, 1 step\nStep 1 of 1: Look up recent posts"]);
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

    expect(edits).toEqual(["All 1 step done"]);
    expect(deletedIds).toEqual([1]);
  });
});

// ── Failure card + 🔁 Retry (2026-09-28 plan §5) ─────────────────────────────

describe("failed turns reach the founder as a card with a Retry button", () => {
  const FAILED_STATE = {
    reply: '⚠️ Task stopped at step "s1" — tool failure in comms.',
    turn: { id: "ignored", chat_id: "777", received_at: "", raw_input: "list my emails" },
    mission: {
      goal: "list my emails",
      status: "failed",
      cursor: 0,
      plan: {
        schema_version: 1,
        goal: "g",
        steps: [
          {
            step_id: "s1",
            worker: "comms",
            objective: "Read the inbox",
            inputs: {},
            expected: { kind: "data", schema_ref: "x" },
            constraints: { max_tool_calls: 3, hitl_required: false },
          },
        ],
      },
    },
    results: [],
    failure: { step_id: "s1", stage: "tool", component: "comms/read_emails", message: "Gmail returned 503", retryable: true },
  };

  /** The first 8 chars of the turn id runKernelText minted for the last stream() call. */
  const lastTurnNonce = (): string =>
    (fakeKernel.stream.mock.calls.at(-1)![0] as { turn: { id: string } }).turn.id.slice(0, 8);
  const retryData = (reply: Reply | undefined): string[] =>
    ((reply?.opts?.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)
      ?.inline_keyboard ?? [])
      .flat()
      .map((b) => b.callback_data ?? "")
      .filter((d) => d.startsWith("retry:"));

  it("sends the failure card with a Retry button for the turn that failed", async () => {
    fakeKernel.stream.mockImplementation(() => singleYield(FAILED_STATE));
    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "list my emails");
    const last = replies.at(-1)!;
    expect(last.text).toContain("I couldn't finish:");
    expect(last.text).toContain("Read the inbox");
    expect(retryData(last)).toEqual([`retry:${lastTurnNonce()}`]);
  });

  it("keeps the profile on the button for a candidate's turn", async () => {
    fakeKernel.stream.mockImplementation(() => singleYield(FAILED_STATE));
    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "draft row 3", "wife-nl-finance");
    expect(retryData(replies.at(-1))).toEqual([`retry:${lastTurnNonce()}:wife-nl-finance`]);
  });

  it("sends the plain kernel text, no button, when he rejected an approval", async () => {
    fakeKernel.stream.mockImplementation(() =>
      singleYield({
        ...FAILED_STATE,
        reply: "Nothing was sent. Re-ask if you change your mind.",
        failure: { step_id: "s1", stage: "hitl_rejected", component: "send_email", message: "Rejected by founder.", retryable: false },
      }),
    );
    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "email the landlord");
    expect(replies.at(-1)!.text).toContain("Nothing was sent");
    expect(retryData(replies.at(-1))).toEqual([]);
  });

  it("falls back to the plain failure text if Telegram rejects the card, and keeps the button", async () => {
    fakeKernel.stream.mockImplementation(() => singleYield(FAILED_STATE));
    const { ctx, replies } = fakeCtx();
    const reply = ctx.reply as unknown as ReturnType<typeof vi.fn>;
    const original = reply.getMockImplementation()!;
    reply.mockImplementation(async (text: string, opts?: Reply["opts"]) => {
      if (text.includes("<blockquote expandable>")) throw new Error("400: can't parse entities");
      return original(text, opts);
    });
    await runKernelText(ctx, "list my emails");
    expect(replies.at(-2)!.text).toContain("tool failure in comms");
    expect(retryData(replies.at(-1))).toEqual([`retry:${lastTurnNonce()}`]);
  });

  it("keeps the Retry button when the card is too long for one message", async () => {
    // A long failure message used to be dropped into the details block whole.
    // Plain text is split across messages; the button follows in its own.
    fakeKernel.stream.mockImplementation(() =>
      singleYield({
        ...FAILED_STATE,
        reply: `⚠️ Task stopped — ${"validation detail ".repeat(400)}`,
        failure: { ...FAILED_STATE.failure, message: "x".repeat(900), evidence: "e".repeat(2_000) },
        results: Array.from({ length: 7 }, (_, i) => ({
          step_id: `s${i}`,
          status: "ok",
          output: "o".repeat(400),
          tool_receipts: [],
        })),
        mission: {
          ...FAILED_STATE.mission,
          plan: {
            ...FAILED_STATE.mission.plan,
            steps: Array.from({ length: 8 }, (_, i) => ({
              ...FAILED_STATE.mission.plan.steps[0],
              step_id: i === 7 ? "s1" : `s${i}`,
              objective: `${"a long objective with many words ".repeat(8)}${i}`,
            })),
          },
        },
      }),
    );
    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "list my emails");
    for (const r of replies) expect(r.text.length).toBeLessThanOrEqual(4096);
    expect(retryData(replies.at(-1))).toEqual([`retry:${lastTurnNonce()}`]);
  });

  it("adds a Retry button to a thrown error when no auto-retry was queued", async () => {
    fakeKernel.stream.mockImplementation(async function* () {
      throw new Error("planner exploded");
    });
    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "boom");
    expect(replies.at(-1)!.text).toContain("❌");
    expect(retryData(replies.at(-1))).toEqual([`retry:${lastTurnNonce()}`]);
  });

  it("never offers both: a queued auto-retry sends no button", async () => {
    fakeKernel.stream.mockImplementation(async function* () {
      throw Object.assign(new Error("429 rate limit"), { status: 429 });
    });
    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "summarise my LinkedIn posts");
    expect(insertScheduledTask).toHaveBeenCalledTimes(1);
    expect(retryData(replies.at(-1))).toEqual([]);
  });

  it("offers the button when the auto-retry could not be queued", async () => {
    insertScheduledTask.mockRejectedValueOnce(new Error("db unavailable"));
    fakeKernel.stream.mockImplementation(async function* () {
      throw Object.assign(new Error("429 rate limit"), { status: 429 });
    });
    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "summarise my LinkedIn posts");
    expect(retryData(replies.at(-1))).toEqual([`retry:${lastTurnNonce()}`]);
  });

  it("does not auto-retry a candidate's turn — the queue carries no profile — and offers the button instead", async () => {
    // An auto-retry runs through scheduled_tasks, which stores only the text:
    // a /wife_draft turn would come back drafted under the default candidate's
    // prompt (the 2026-09-05 wrong-signature bug). The button keeps the profile.
    fakeKernel.stream.mockImplementation(async function* () {
      throw Object.assign(new Error("429 rate limit"), { status: 429 });
    });
    const { ctx, replies } = fakeCtx();
    await runKernelText(ctx, "draft row 3", "wife-nl-finance");
    expect(insertScheduledTask).not.toHaveBeenCalled();
    expect(retryData(replies.at(-1))).toEqual([`retry:${lastTurnNonce()}:wife-nl-finance`]);
  });

  it("gives a resume no button — its turn text would re-run the whole approved mission", async () => {
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "int-1", created_at: new Date().toISOString() });
    fakeKernel.stream.mockImplementation(async function* () {
      throw new Error("send failed");
    });
    const { ctx, replies } = fakeCtx();
    await resumeKernel(ctx, "approved");
    expect(retryData(replies.at(-1))).toEqual([]);
  });
});

// 2026-10-05: the "Working on it" ack went out only after readHalt, the pending-approval lookup, two
// daily-budget reads and the first-boot kernel compile, so it routinely missed the 2 s budget. The ack now
// goes first and the gates run behind it; a gate that refuses must take the ack away so nothing is orphaned.
describe("runKernelText: the ack goes out before the gates", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("sends the placeholder while readHalt is still pending, then runs the kernel once the gates pass", async () => {
    const gate = deferred<unknown>();
    readHalt.mockReturnValue(gate.promise);
    const { ctx, replies } = fakeCtx();
    const run = runKernelText(ctx, "hello");
    await tick();

    expect(replies.map((r) => r.text)).toEqual(["🤔 Working on it…"]);
    expect(fakeKernel.stream).not.toHaveBeenCalled();

    gate.resolve(null);
    await run;
    expect(fakeKernel.stream).toHaveBeenCalledTimes(1);
    expect(replies.map((r) => r.text)).toEqual(["🤔 Working on it…", "All done."]);
  });

  it("sends the placeholder while the pending-approval lookup and the budget read are pending", async () => {
    const pending = deferred<unknown>();
    getPendingInterrupt.mockReturnValue(pending.promise);
    const { ctx, replies } = fakeCtx();
    const run = runKernelText(ctx, "hello");
    await tick();
    expect(replies).toHaveLength(1);
    expect(getTodayCostUsd).not.toHaveBeenCalled();
    pending.resolve(null);
    await run;
    expect(getTodayCostUsd).toHaveBeenCalledTimes(1);
  });

  it("records turn.ack with the milliseconds since the message arrived, before any gate resolves", async () => {
    const events: TraceEvent[] = [];
    setTraceSink((e) => events.push(e));
    try {
      const gate = deferred<unknown>();
      readHalt.mockReturnValue(gate.promise);
      const { ctx } = fakeCtx();
      const run = runKernelText(ctx, "hello");
      await tick();
      const ack = events.find((e) => e.seam === "turn.ack");
      expect(ack).toBeDefined();
      expect(typeof ack!.data?.["ms"]).toBe("number");
      expect(ack!.data!["ms"] as number).toBeLessThan(2000);
      expect(events.some((e) => e.seam === "turn.in")).toBe(false); // the gates have not finished
      gate.resolve(null);
      await run;
    } finally {
      setTraceSink(null);
    }
  });

  it("halted: the ack is deleted, the halt notice is shown, and the kernel never runs", async () => {
    readHalt.mockResolvedValue({ reason: "stop" });
    const { ctx, replies, deletedIds } = fakeCtx();
    await runKernelText(ctx, "hello");

    expect(replies.map((r) => r.text)).toEqual(["🤔 Working on it…", "halted"]);
    expect(deletedIds).toEqual([1]); // exactly the ack, exactly once
    expect(fakeKernel.stream).not.toHaveBeenCalled();
    expect(getPendingInterrupt).not.toHaveBeenCalled();
  });

  it("an approval is pending: the ack is deleted before the hold notice, and the kernel never runs", async () => {
    getPendingInterrupt.mockResolvedValue({
      interrupt_id: "abcd1234-0000",
      created_at: new Date(Date.now() - 60_000).toISOString(),
      callback_data: JSON.stringify({ action: "dispatch_antigravity", title: "Dispatch?", summary: "s", preview: "p", args: {} }),
    });
    const { ctx, replies, deletedIds } = fakeCtx();
    await runKernelText(ctx, "/task another");

    expect(deletedIds).toEqual([1]);
    expect(replies[0]!.text).toBe("🤔 Working on it…");
    expect(replies[1]!.text).toMatch(/approve or reject/i);
    expect(replies).toHaveLength(3); // ack, hold notice, the pending card again: no second ack
    expect(fakeKernel.stream).not.toHaveBeenCalled();
    expect(getTodayCostUsd).not.toHaveBeenCalled();
  });

  it("daily budget exhausted: the ack is deleted, the refusal is shown, and the kernel never runs", async () => {
    getTodayCostUsd.mockResolvedValue(1_000_000);
    const { ctx, replies, deletedIds } = fakeCtx();
    await runKernelText(ctx, "hello");

    expect(deletedIds).toEqual([1]);
    expect(replies).toHaveLength(2);
    expect(replies[1]!.text).toMatch(/budget/i);
    expect(fakeKernel.stream).not.toHaveBeenCalled();
  });

  it("a failing gate read is a loud error with the ack removed, not a stuck ack", async () => {
    readHalt.mockRejectedValue(new Error("halt table unreachable"));
    const { ctx, replies, deletedIds } = fakeCtx();
    await runKernelText(ctx, "hello");

    expect(deletedIds).toEqual([1]);
    expect(replies.at(-1)!.text).toContain("❌");
    expect(fakeKernel.stream).not.toHaveBeenCalled();
  });

  it("a slow ack send does not let a refusal overtake it: the refusal waits, then the ack is deleted", async () => {
    readHalt.mockResolvedValue({ reason: "stop" });
    const send = deferred<{ message_id: number }>();
    const { ctx, replies, deletedIds } = fakeCtx();
    let first = true;
    (ctx.reply as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => {
      replies.push({ text });
      if (first) {
        first = false;
        return send.promise;
      }
      return { message_id: 99 };
    });
    const run = runKernelText(ctx, "hello");
    await tick();
    expect(replies.map((r) => r.text)).toEqual(["🤔 Working on it…"]); // refusal not sent yet
    send.resolve({ message_id: 41 });
    await run;
    expect(deletedIds).toEqual([41]);
    expect(replies.at(-1)!.text).toBe("halted");
  });

  it("a normal turn still deletes the ack exactly once, after the reply path ends", async () => {
    const { ctx, deletedIds } = fakeCtx();
    await runKernelText(ctx, "hello");
    expect(deletedIds).toEqual([1]);
  });

  it("a queued turn shows the queue ack and then its own placeholder", async () => {
    let release!: () => void;
    fakeKernel.stream.mockImplementationOnce(async function* () {
      await new Promise<void>((r) => (release = r));
      yield DONE_STATE;
    } as never);
    const first = fakeCtx();
    const second = fakeCtx();
    const a = runKernelText(first.ctx, "one");
    await tick();
    const b = runKernelText(second.ctx, "two");
    await tick();
    expect(second.replies.map((r) => r.text)).toEqual(["⏳ Got it — finishing the current request first."]);
    release();
    await Promise.all([a, b]);
    expect(second.replies.map((r) => r.text)).toEqual([
      "⏳ Got it — finishing the current request first.",
      "🤔 Working on it…",
      "All done.",
    ]);
  });
});

// Same rule for the Approve/Reject tap: the ack goes out before the pending-interrupt lookup and the
// first-boot kernel compile, and anything that stops the resume before the stream takes the ack away.
describe("resumeKernel: the ack goes out before the pending lookup", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("sends the placeholder while getPendingInterrupt is still pending", async () => {
    let release!: (v: unknown) => void;
    getPendingInterrupt.mockReturnValue(new Promise((r) => (release = r)));
    const { ctx, replies } = fakeCtx();
    const run = resumeKernel(ctx, "approved");
    await tick();

    expect(replies.map((r) => r.text)).toEqual(["🤔 Working on it…"]);
    expect(fakeKernel.stream).not.toHaveBeenCalled();

    release(null);
    await run;
    expect(fakeKernel.stream).toHaveBeenCalledTimes(1);
  });

  it("a stale card tap deletes the ack before it says the card is expired", async () => {
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "current-9f8e7d6c", created_at: new Date().toISOString() });
    const { ctx, replies, deletedIds } = fakeCtx();
    await resumeKernel(ctx, "approved", "stale123");

    expect(deletedIds).toEqual([1]);
    expect(replies.at(-1)!.text).toMatch(/expired|older task/i);
    expect(fakeKernel.stream).not.toHaveBeenCalled();
  });

  it("a failure before the stream starts deletes the ack, then shows the error", async () => {
    getPendingInterrupt.mockRejectedValue(new Error("db down"));
    const { ctx, replies, deletedIds } = fakeCtx();
    await resumeKernel(ctx, "approved");

    expect(deletedIds).toEqual([1]);
    expect(replies.at(-1)!.text).toContain("❌");
  });
});
