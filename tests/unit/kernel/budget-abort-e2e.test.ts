/**
 * A blown budget stops the REAL graph — not just the counter.
 *
 * The unit tests in budget-enforcement.test.ts prove the signal fires. This one
 * proves the thing that actually failed in production: that after a breach, the
 * kernel issues no further tool calls.
 *
 * Prod turn 7dd021d8 (2026-09-07, 21:55–21:56) breached the 100,000-token cap
 * five times — 105k, 110k, 121k, 137k, 154k — and kept calling tools after
 * every one, finishing only when it ran out of work. The cap was enforced by
 * throwing from `BudgetGuardCallback.handleLLMEnd`, and LangChain catches what a
 * callback handler throws, so nothing downstream ever learned about it.
 *
 * Scripted models, real StateGraph, real checkpointer, no network, $0. The
 * breach is dispatched through LangChain's own CallbackManager — the same path
 * a real model completion takes — from inside the first tool, so it lands
 * mid-run exactly as it did in production.
 */

import { describe, it, expect } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import {
  buildKernel,
  KERNEL_SCHEMA_VERSION,
  type KernelBindableModel,
  type KernelTool,
  type WorkerSpec,
} from "../../../src/kernel/index.js";
import { BudgetExceededError, BudgetTracker, enforceRunBudget } from "../../../src/infra/budget.js";

class ScriptedModel implements KernelBindableModel {
  calls = 0;
  constructor(private script: AIMessage[]) {}
  bindTools(): ScriptedModel {
    return this;
  }
  async invoke(_messages: BaseMessage[]): Promise<AIMessage> {
    const entry = this.script[this.calls];
    this.calls += 1;
    if (!entry) throw new Error(`ScriptedModel exhausted after ${this.calls - 1} calls`);
    return entry;
  }
}

const ai = (content: string) => new AIMessage(content);
const aiTool = (name: string, args: Record<string, unknown>, id: string) =>
  new AIMessage({ content: "", tool_calls: [{ name, args, id, type: "tool_call" }] });

const step = (id: string, objective: string) => ({
  step_id: id,
  worker: "research",
  objective,
  inputs: {},
  expected: { kind: "data", schema_ref: "research.findings" },
  constraints: { max_tool_calls: 2, hitl_required: false },
});

/** Usage big enough to blow the caps below, shaped the way Gemini reports it. */
function hugeResult(): LLMResult {
  return {
    generations: [
      [{ text: "ok", generationInfo: { usage_metadata: { promptTokenCount: 90_000, candidatesTokenCount: 20_000 } } }],
    ],
    llmOutput: {},
  } as unknown as LLMResult;
}

const SERIALIZED = { lc: 1, type: "not_implemented" as const, id: ["test", "model"] };

/** Complete one LLM call through LangChain's real dispatch path. */
async function breachThroughLangChain(handler: Parameters<typeof CallbackManager.configure>[0]): Promise<void> {
  const manager = CallbackManager.configure(handler);
  const runManagers = await manager!.handleChatModelStart(SERIALIZED, [[new HumanMessage("hi")]]);
  await runManagers[0]!.handleLLMEnd(hugeResult());
}

describe("run budget — a breach halts the kernel mid-plan", () => {
  it("stops before the next tool call, and reports the cap rather than a raw abort", async () => {
    const budget = enforceRunBudget(
      "gemini-2.5-flash",
      undefined,
      new BudgetTracker({ maxUsd: 100, maxTokens: 100_000 }),
    );

    const toolCalls: string[] = [];
    const firstTool: KernelTool = {
      name: "search_web",
      description: "search the web",
      invoke: async () => {
        toolCalls.push("search_web");
        // The breach lands HERE — mid-run, through the framework's own dispatch,
        // exactly as a real completion would deliver it.
        await breachThroughLangChain([budget.callback]);
        return JSON.stringify({ success: true, data: [{ title: "x", url: "https://x.dev" }] });
      },
    };
    const secondTool: KernelTool = {
      name: "read_page",
      description: "read a page",
      invoke: async () => {
        toolCalls.push("read_page");
        return JSON.stringify({ success: true, data: "page body" });
      },
    };

    const workers: WorkerSpec[] = [
      {
        id: "research",
        description: "web research",
        prompt: "You are the research worker.",
        tools: [firstTool, secondTool],
      },
    ];

    const planner = new ScriptedModel([
      ai(
        JSON.stringify({
          type: "plan",
          plan: {
            schema_version: KERNEL_SCHEMA_VERSION,
            goal: "two steps",
            steps: [step("s1", "search for it"), step("s2", "then read the page")],
          },
        }),
      ),
    ]);
    // Enough script for BOTH steps — if the run does not stop, it has the
    // material to keep going, so a passing test cannot be an exhausted script.
    const worker = new ScriptedModel([
      aiTool("search_web", { query: "x" }, "c1"),
      ai(JSON.stringify({ text: "found it" })),
      aiTool("read_page", { url: "https://x.dev" }, "c2"),
      ai(JSON.stringify({ text: "read it" })),
    ]);
    const synth = new ScriptedModel([ai("All done.")]);

    const kernel = buildKernel({
      plannerModel: planner,
      workerModel: worker,
      synthesizerModel: synth,
      workers,
      checkpointer: new MemorySaver(),
    });

    const run = kernel.invoke(
      { turn: { id: "t1", chat_id: "1", received_at: new Date().toISOString(), raw_input: "do two things" } },
      {
        configurable: { thread_id: "budget-abort" },
        callbacks: [budget.callback],
        signal: budget.signal,
      },
    );

    await expect(run).rejects.toThrow();

    // The cap was recorded, and it is what the founder would be told.
    expect(budget.breached).toBe(true);
    const failure = budget.breachError();
    expect(failure).toBeInstanceOf(BudgetExceededError);
    expect(failure!.reason).toContain("Token budget exceeded");

    // The whole point: nothing ran after the breach.
    expect(toolCalls).toEqual(["search_web"]);
    expect(toolCalls).not.toContain("read_page");
    expect(synth.calls).toBe(0);
  });

  it("a run inside its caps completes normally — the guard is not a tripwire on success", async () => {
    const budget = enforceRunBudget(
      "gemini-2.5-flash",
      undefined,
      new BudgetTracker({ maxUsd: 100, maxTokens: 10_000_000 }),
    );

    const toolCalls: string[] = [];
    const tool: KernelTool = {
      name: "search_web",
      description: "search the web",
      invoke: async () => {
        toolCalls.push("search_web");
        await breachThroughLangChain([budget.callback]); // accrues, but well inside the cap
        return JSON.stringify({ success: true, data: [{ title: "x", url: "https://x.dev" }] });
      },
    };

    const kernel = buildKernel({
      plannerModel: new ScriptedModel([
        ai(
          JSON.stringify({
            type: "plan",
            plan: { schema_version: KERNEL_SCHEMA_VERSION, goal: "one step", steps: [step("s1", "search the web for it")] },
          }),
        ),
      ]),
      workerModel: new ScriptedModel([aiTool("search_web", { query: "x" }, "c1"), ai(JSON.stringify({ text: "found" }))]),
      synthesizerModel: new ScriptedModel([ai("All done.")]),
      workers: [{ id: "research", description: "web research", prompt: "worker", tools: [tool] }],
      checkpointer: new MemorySaver(),
    });

    const res = await kernel.invoke(
      { turn: { id: "t2", chat_id: "1", received_at: new Date().toISOString(), raw_input: "search the web" } },
      { configurable: { thread_id: "budget-ok" }, callbacks: [budget.callback], signal: budget.signal },
    );

    expect(budget.breached).toBe(false);
    expect(budget.signal.aborted).toBe(false);
    expect(toolCalls).toEqual(["search_web"]);
    expect(res.mission.status).toBe("done");
  });
});
