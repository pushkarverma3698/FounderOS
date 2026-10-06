/**
 * Direct replies are judged too.
 * ==============================
 * "evaluate" used to sit only after "synthesize", so a planner direct reply (no plan, no tool, no step)
 * never reached the judge: every answer_evaluations row had planned_steps 1-2. Direct replies are where
 * claims about the system ("I sent it", "the loop is idle") come from, with nothing behind them. These tests
 * run the REAL graph with a fake judge and a fake row writer ($0, no network, no database).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { buildKernel, routeAfterPlan, type KernelBindableModel } from "../../../src/kernel/index.js";
import type { KernelStateType } from "../../../src/kernel/state.js";
import type { NewAnswerEvaluation } from "../../../src/db/schema.js";
import type { AnswerEvalDeps, CompletedTurn } from "../../../src/infra/answer-eval.js";
import { judgeAnswer, _resetAnswerJudgeCache, type JudgeModel } from "../../../src/infra/judge.js";
import { judgeHealth, _resetJudgeHealth, JUDGE_OUTAGE_THRESHOLD } from "../../../src/infra/judge-health.js";

/** A planner that always answers with this decision. */
function plannerSaying(decision: unknown): KernelBindableModel {
  return {
    async invoke(_messages: BaseMessage[]) {
      return new AIMessage(JSON.stringify(decision));
    },
    bindTools() {
      return this;
    },
  } as unknown as KernelBindableModel;
}

const SCORES = {
  groundedness: 15,
  relevance: 90,
  completeness: 90,
  critique: "claims with no step behind them",
};

function fakes() {
  const judged: CompletedTurn[] = [];
  const rows: NewAnswerEvaluation[] = [];
  const deps: AnswerEvalDeps = {
    judge: async (turn) => {
      judged.push(turn);
      return {
        status: "evaluated",
        scores: SCORES,
      };
    },
    write: async (row) => {
      rows.push(row);
    },
  };
  return { deps, judged, rows };
}

const TASKS_COMMAND = {
  name: "tasks",
  description: "what the agent loop is doing",
  mutating: false,
};

function kernelFor(planner: KernelBindableModel, deps: AnswerEvalDeps) {
  return buildKernel({
    plannerModel: planner,
    workerModel: planner,
    synthesizerModel: planner,
    workers: [],
    checkpointer: new MemorySaver(),
    answerEval: deps,
    commands: [TASKS_COMMAND],
  });
}

function input(raw: string) {
  return {
    turn: {
      id: "t1",
      chat_id: "chat-1",
      received_at: "2026-10-05T10:00:00Z",
      raw_input: raw,
    },
  };
}

const cfg = (thread: string) => ({ configurable: { thread_id: thread } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function stateWith(over: Record<string, unknown>): KernelStateType {
  return {
    turn: null,
    mission: { goal: "g", status: "done", plan: null, cursor: 0 },
    results: [],
    failure: null,
    reply: "Everything is idle.",
    command: null,
    ...over,
  } as unknown as KernelStateType;
}

const EXECUTING = { goal: "g", status: "executing", plan: { steps: [] }, cursor: 0 };
const FAILED = { goal: "g", status: "failed", plan: null, cursor: 0 };
const FAILURE = { stage: "plan", component: "kernel/planner", message: "x", evidence: "y", retryable: false };

describe("routeAfterPlan", () => {
  it("sends a direct reply to evaluate", () => {
    expect(routeAfterPlan(stateWith({}))).toBe("evaluate");
  });
  it("keeps sending an executing mission to dispatch", () => {
    expect(routeAfterPlan(stateWith({ mission: EXECUTING }))).toBe("dispatch");
  });
  it("does not judge a failed turn", () => {
    expect(routeAfterPlan(stateWith({ failure: FAILURE, mission: FAILED }))).toBe("finish");
  });
  it("does not judge a routed command", () => {
    expect(routeAfterPlan(stateWith({ command: { name: "tasks", args: "" }, reply: "Ran /tasks" }))).toBe("finish");
  });
  it("does not judge a blank reply", () => {
    expect(routeAfterPlan(stateWith({ reply: "   " }))).toBe("finish");
  });
});

describe("direct replies through the real graph", () => {
  it("judges a direct reply once, with no steps, and leaves the reply alone", async () => {
    const { deps, judged, rows } = fakes();
    const kernel = kernelFor(plannerSaying({ type: "reply", text: "The loop is idle." }), deps);
    const out = await kernel.invoke(input("is the loop idle?"), cfg("th-1"));
    await flush();
    expect(out.reply).toBe("The loop is idle.");
    expect(judged).toHaveLength(1);
    expect(judged[0]).toMatchObject({
      turnId: "t1",
      threadId: "chat-1",
      goal: "is the loop idle?",
      reply: "The loop is idle.",
      steps: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ planned_steps: 0, reply: "The loop is idle." });
  });

  it("does not judge a planner-routed command", async () => {
    const { deps, judged } = fakes();
    const kernel = kernelFor(plannerSaying({ type: "command", name: "tasks", args: "" }), deps);
    const out = await kernel.invoke(input("What is running?"), cfg("th-2"));
    await flush();
    expect(out.reply).toMatch(/Ran \/tasks/);
    expect(judged).toHaveLength(0);
  });
});

const ONE_STEP = [{ stepId: "s1", objective: "list PRs", status: "ok" as const, output: "2 PRs" }];
const JUDGE_REPLY = JSON.stringify({ groundedness: 10, relevance: 90, completeness: 90, critique: "r" });

function capturingJudge() {
  const prompts: string[] = [];
  const model: JudgeModel = {
    async invoke(prompt: unknown) {
      prompts.push(String(prompt));
      return { content: JUDGE_REPLY };
    },
  };
  return { model, prompts };
}

describe("judge prompt for direct replies", () => {
  beforeEach(() => _resetAnswerJudgeCache());

  it("scores unsupported claims about the system as ungrounded when no step ran", async () => {
    const { model, prompts } = capturingJudge();
    await judgeAnswer({ goal: "is the loop idle?", reply: "Yes, idle.", steps: [] }, { model });
    expect(prompts[0]).toMatch(/no step was run/i);
    expect(prompts[0]).toMatch(/claims? about system state, tools, past actions or data/i);
    expect(prompts[0]).toMatch(/ungrounded/i);
  });

  it("keeps the step-results wording when steps exist", async () => {
    const { model, prompts } = capturingJudge();
    await judgeAnswer({ goal: "list PRs", reply: "2 PRs.", steps: ONE_STEP }, { model });
    expect(prompts[0]).toContain("STEP RESULTS (the only ground truth)");
    expect(prompts[0]).not.toMatch(/no step was run/i);
  });
});

const RATE_LIMITED: JudgeModel = {
  async invoke() {
    throw new Error("429 rate limit exceeded");
  },
};

describe("judge health under the extra direct-reply volume", () => {
  beforeEach(() => {
    _resetAnswerJudgeCache();
    _resetJudgeHealth();
  });

  it("failed direct-reply judge calls never count toward the outage alert", async () => {
    for (let i = 0; i < JUDGE_OUTAGE_THRESHOLD + 3; i++) {
      const out = await judgeAnswer({ goal: "g${i}", reply: "r${i}", steps: [] }, { model: RATE_LIMITED });
      expect(out.status).toBe("not_evaluated");
    }
    expect(judgeHealth().consecutiveFailures).toBe(0);
    expect(judgeHealth().shouldAlert).toBe(false);
  });

  it("failed planned-turn judge calls still raise the alert, exactly as before", async () => {
    for (let i = 0; i < JUDGE_OUTAGE_THRESHOLD; i++) {
      await judgeAnswer({ goal: "g${i}", reply: "r${i}", steps: ONE_STEP }, { model: RATE_LIMITED });
    }
    expect(judgeHealth().shouldAlert).toBe(true);
  });

  it("direct-reply failures interleaved with planned failures do not move the count", async () => {
    await judgeAnswer({ goal: "a", reply: "a", steps: ONE_STEP }, { model: RATE_LIMITED });
    await judgeAnswer({ goal: "b", reply: "b", steps: [] }, { model: RATE_LIMITED });
    await judgeAnswer({ goal: "c", reply: "c", steps: [] }, { model: RATE_LIMITED });
    expect(judgeHealth().consecutiveFailures).toBe(1);
  });
});
