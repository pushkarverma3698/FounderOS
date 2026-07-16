/**
 * v3 kernel — self-healing E2E (offline, $0, real graph).
 * =========================================================
 * The 2026-07-13 "post-antigravity" upgrade: the kernel corrects its own
 * failures in-graph instead of crashing and waiting for the founder to say
 * "try again".
 *
 *   1. A worker-model error becomes a typed retryable failure and the
 *      supervisor's retry completes the mission — no turn-level crash.
 *   2. A persistent model failure terminates as a typed stage:"model"
 *      FailureReport after the full attempt budget — never an unhandled throw.
 *   3. Terminal errors (budget caps, aborts) still propagate untouched.
 *   4. The FINAL retry is a diagnostic envelope: approach change forced,
 *      output contract re-stated verbatim.
 *   5. A synthesizer-model blip degrades to the deterministic results reply —
 *      a fully-completed mission is never thrown away.
 */

import { describe, it, expect } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  buildKernel,
  KERNEL_SCHEMA_VERSION,
  MAX_ATTEMPTS_PER_STEP,
  isKernelTerminalError,
  type KernelBindableModel,
  type KernelTool,
  type WorkerSpec,
} from "../../../src/kernel/index.js";

class ScriptedModel implements KernelBindableModel {
  calls = 0;
  received: BaseMessage[][] = [];
  constructor(private script: Array<AIMessage | Error | ((msgs: BaseMessage[]) => AIMessage)>, private loop = false) {}
  bindTools(): ScriptedModel {
    return this;
  }
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.received.push(messages);
    const idx = this.loop ? this.calls % this.script.length : this.calls;
    this.calls += 1;
    const entry = this.script[idx];
    if (!entry) throw new Error(`ScriptedModel exhausted after ${this.calls - 1} calls`);
    if (entry instanceof Error) throw entry;
    return typeof entry === "function" ? entry(messages) : entry;
  }
}

const ai = (content: string) => new AIMessage(content);
const planJson = () =>
  JSON.stringify({
    type: "plan",
    plan: {
      schema_version: KERNEL_SCHEMA_VERSION,
      goal: "research goal",
      steps: [
        {
          step_id: "s1",
          worker: "research",
          objective: "Find the latest LangGraph news",
          inputs: {},
          expected: { kind: "data", schema_ref: "research.findings" },
          constraints: { max_tool_calls: 2, hitl_required: false },
        },
      ],
    },
  });

const searchTool: KernelTool = {
  name: "search_web",
  description: "search the web",
  invoke: async () => JSON.stringify({ success: true, data: [] }),
};
const workers: WorkerSpec[] = [
  { id: "research", description: "web research", prompt: "You are the research worker.", tools: [searchTool] },
];

function kernelWith(worker: ScriptedModel, synth?: ScriptedModel) {
  return buildKernel({
    plannerModel: new ScriptedModel([ai(planJson())]),
    workerModel: worker,
    synthesizerModel: synth ?? new ScriptedModel([ai("Done.")]),
    workers,
    checkpointer: new MemorySaver(),
  });
}

const cfg = (thread: string) => ({ configurable: { thread_id: thread } });
const turn = (id: string) => ({
  turn: { id, chat_id: "1", received_at: new Date().toISOString(), raw_input: "research LangGraph news" },
});

const VALID_OUTPUT = ai(JSON.stringify({ summary: "LangGraph 1.4 released", sources: [] }));

describe("kernel self-healing (real graph, scripted models)", () => {
  it("a worker-model throw becomes a typed retryable failure and the retry completes the mission", async () => {
    // Attempt 1: the provider dies mid-mission. Attempt 2: recovered.
    const worker = new ScriptedModel([new Error("503 Service Unavailable: model overloaded"), VALID_OUTPUT]);
    const res = await kernelWith(worker).invoke(turn("t1"), cfg("heal"));

    expect(res.mission.status).toBe("done");
    expect(res.attempts["s1"]).toBe(2); // the crash cost ONE visible retry, not the mission
    expect(res.failure).toBeNull();
    // The retry envelope told the model what failed.
    const retryMsgs = worker.received[1]!.map((m) => String(m.content)).join("\n");
    expect(retryMsgs).toContain("Worker model call failed");
  });

  it("a persistent model failure terminates as a typed stage:'model' report after the attempt budget", async () => {
    const worker = new ScriptedModel([new Error("503 Service Unavailable")], true);
    const res = await kernelWith(worker).invoke(turn("t1"), cfg("persist"));

    expect(res.mission.status).toBe("failed");
    expect(res.failure?.stage).toBe("model");
    expect(res.failure?.component).toBe("kernel/worker:research");
    expect(res.attempts["s1"]).toBe(MAX_ATTEMPTS_PER_STEP);
    expect(res.reply).toContain("Task stopped");
    expect(worker.calls).toBe(MAX_ATTEMPTS_PER_STEP); // one model call per attempt, then stop — no spin
  });

  it("terminal errors (budget cap) propagate out of the graph untouched", async () => {
    const budgetErr = new Error("BudgetExceededError: run budget $0.50 exhausted");
    budgetErr.name = "BudgetExceededError";
    const worker = new ScriptedModel([budgetErr], true);

    await expect(kernelWith(worker).invoke(turn("t1"), cfg("budget"))).rejects.toThrow(/budget/i);
  });

  it("isKernelTerminalError: classifies the exact terminal set, nothing else", () => {
    for (const name of ["BudgetExceededError", "DailyBudgetExceededError", "AbortError", "TurnTimeoutError"]) {
      const e = new Error("x");
      e.name = name;
      expect(isKernelTerminalError(e)).toBe(true);
    }
    expect(isKernelTerminalError(new Error("503 overloaded"))).toBe(false);
    expect(isKernelTerminalError("string error")).toBe(false);
  });

  it("the FINAL retry is a diagnostic envelope: approach change forced, contract re-stated", async () => {
    // Two invalid finalizations, then a valid one on the diagnostic attempt.
    const worker = new ScriptedModel([ai(JSON.stringify({})), ai(JSON.stringify({})), VALID_OUTPUT]);
    const res = await kernelWith(worker).invoke(turn("t1"), cfg("diag"));

    expect(res.mission.status).toBe("done");
    expect(res.attempts["s1"]).toBe(3);

    const attempt2 = worker.received[1]!.map((m) => String(m.content)).join("\n");
    expect(attempt2).toContain("RETRY 1 of 2");
    expect(attempt2).not.toContain("DIAGNOSTIC");

    const attempt3 = worker.received[2]!.map((m) => String(m.content)).join("\n");
    expect(attempt3).toContain("DIAGNOSTIC RETRY 2 of 2");
    expect(attempt3).toContain("FINAL attempt");
    expect(attempt3).toContain('"summary"'); // the exact output contract, re-stated
    expect(attempt3).toContain("never fabricate");
  });

  it("a synthesizer blip degrades to the deterministic results reply — completed work survives", async () => {
    const worker = new ScriptedModel([VALID_OUTPUT]);
    const synth = new ScriptedModel([new Error("429 rate limited")], true);
    const res = await kernelWith(worker, synth).invoke(turn("t1"), cfg("synthfall"));

    expect(res.mission.status).toBe("done");
    expect(res.failure).toBeNull();
    expect(res.reply).toContain("reply-writing model was unavailable");
    expect(res.reply).toContain("LangGraph 1.4 released"); // the validated output, verbatim
  });

  it("a synthesizer budget-cap error still propagates (never masked by the fallback)", async () => {
    const budgetErr = new Error("BudgetExceededError: daily cap");
    budgetErr.name = "BudgetExceededError";
    const worker = new ScriptedModel([VALID_OUTPUT]);
    const synth = new ScriptedModel([budgetErr], true);

    await expect(kernelWith(worker, synth).invoke(turn("t1"), cfg("synthbudget"))).rejects.toThrow(/cap/);
  });
});
