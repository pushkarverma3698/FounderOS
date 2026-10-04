/**
 * The turn log — every finished turn is kept past the 6-hour session, written from the one place all turns pass.
 *
 * The plan node folds the PREVIOUS turn into `history` when the next one begins (so every ending is covered:
 * direct reply, synthesis, typed failure). It now hands the same summary to the durable log. These tests pin
 * what makes that log trustworthy: a turn is written once with the thread it belongs to, an unfinished turn is
 * never written, a thread-less call never files a row nobody could read back, and a failing log never costs the
 * founder a reply.
 */

import { describe, expect, it } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { makePlanNode, summarizePreviousTurn, HISTORY_INPUT_MAX_CHARS, type KernelChatModel, type WorkerCatalogEntry } from "../../../src/kernel/planner.js";
import type { KernelStateType } from "../../../src/kernel/state.js";
import type { TurnSummary } from "../../../src/kernel/contracts.js";
import type { TurnLog } from "../../../src/kernel/turn-log.js";

const catalog: WorkerCatalogEntry[] = [
  { id: "engineering", description: "code and repo work", toolNames: ["github_read"], gatedToolNames: [] },
];

const REPLY_DECISION = JSON.stringify({ type: "reply", text: "Hello again." });

/** State as the plan node sees it at the start of turn 2: turn 1 finished with a reply. */
function stateAfterTurn(over: Record<string, unknown> = {}): KernelStateType {
  return {
    turn: { id: "t2", chat_id: "c1", received_at: "2026-10-04T10:00:00Z", raw_input: "second question" },
    last_turn: { id: "t1", chat_id: "c1", received_at: "2026-10-03T16:11:00Z", raw_input: "can you check why the PR bot paused?" },
    mission: { goal: "check the PR bot", status: "done", plan: null, cursor: 0 },
    results: [],
    attempts: {},
    scratch: {},
    step_receipts: {},
    failure: null,
    reply: "The review bot paused because the model name was retired.",
    history: [],
    command: null,
    lesson_candidate: null,
    ...over,
  } as unknown as KernelStateType;
}

const model: KernelChatModel = {
  async invoke(_messages: BaseMessage[]) {
    return new AIMessage(REPLY_DECISION);
  },
};

function recordingLog() {
  const calls: Array<{ turn: TurnSummary; threadId: string }> = [];
  const log: TurnLog = {
    async record(turn, threadId) {
      calls.push({ turn, threadId });
    },
  };
  return { log, calls };
}

const withThread = (threadId: string) => ({ configurable: { thread_id: threadId } });

describe("plan node → turn log", () => {
  it("records the finished previous turn once, with the thread it belongs to", async () => {
    const { log, calls } = recordingLog();
    await makePlanNode(model, catalog, undefined, [], log)(stateAfterTurn(), withThread("turicks:42"));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.threadId).toBe("turicks:42");
    expect(calls[0]!.turn).toMatchObject({
      turn_id: "t1",
      at: "2026-10-03T16:11:00Z",
      user_input: "can you check why the PR bot paused?",
      outcome: "replied",
      reply: "The review bot paused because the model name was retired.",
    });
  });

  it("records a failed turn as failed, so recall never presents a failure as a success", async () => {
    const { log, calls } = recordingLog();
    const failure = { stage: "agent", component: "kernel/worker", message: "CI was red", evidence: "x", retryable: false };
    await makePlanNode(model, catalog, undefined, [], log)(stateAfterTurn({ failure }), withThread("turicks:42"));
    expect(calls[0]!.turn.outcome).toBe("failed");
  });

  it("records nothing on a fresh thread (no previous turn yet)", async () => {
    const { log, calls } = recordingLog();
    await makePlanNode(model, catalog, undefined, [], log)(stateAfterTurn({ last_turn: null, reply: "" }), withThread("turicks:42"));
    expect(calls).toHaveLength(0);
  });

  it("records nothing for a turn still paused on approval (empty reply): it is recorded after it completes", async () => {
    const { log, calls } = recordingLog();
    await makePlanNode(model, catalog, undefined, [], log)(stateAfterTurn({ reply: "" }), withThread("turicks:42"));
    expect(calls).toHaveLength(0);
  });

  it("files nothing without a thread id: recall is thread-scoped, so such a row could never be read back", async () => {
    const { log, calls } = recordingLog();
    await makePlanNode(model, catalog, undefined, [], log)(stateAfterTurn());
    await makePlanNode(model, catalog, undefined, [], log)(stateAfterTurn(), withThread(""));
    expect(calls).toHaveLength(0);
  });

  it("a log that throws never fails the turn: the founder still gets the planner's answer", async () => {
    const throwing: TurnLog = {
      async record() {
        throw new Error("connection refused");
      },
    };
    const update = await makePlanNode(model, catalog, undefined, [], throwing)(stateAfterTurn(), withThread("turicks:42"));
    expect(update.reply).toBe("Hello again.");
    expect(update.failure).toBeNull();
  });

  it("runs unchanged with no log configured (tests, offline CI)", async () => {
    const update = await makePlanNode(model, catalog)(stateAfterTurn(), withThread("turicks:42"));
    expect(update.reply).toBe("Hello again.");
  });
});

describe("what a stored turn keeps", () => {
  it("keeps up to 2000 characters of the founder's message, so a pasted brief survives the next turn", () => {
    const long = "x".repeat(5000);
    const summary = summarizePreviousTurn(stateAfterTurn({ last_turn: { id: "t1", chat_id: "c1", received_at: "2026-10-03T16:11:00Z", raw_input: long } }));
    expect(HISTORY_INPUT_MAX_CHARS).toBe(2000);
    expect(summary!.user_input).toHaveLength(2000);
  });
});
