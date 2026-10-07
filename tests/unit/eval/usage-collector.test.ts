/**
 * AG-031 model A/B: the eval has to see which model answered each call, how many
 * tokens it billed and how long the turn took. All of it is read from the same
 * LangChain callback path the production cost ledger uses, so the A/B numbers and
 * the ledger cannot disagree. No network, no paid calls.
 */

import { describe, it, expect, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { buildKernel, type KernelBindableModel } from "../../../src/kernel/index.js";
import { makeUsageCollector } from "../../../src/eval/usage-collector.js";
import { makeKernelInvoker } from "../../../src/eval/kernel-invoker.js";
import { runEval } from "../../../src/eval/runner.js";
import type { GoldenTask, LlmCallUsage, Observation } from "../../../src/eval/types.js";

const llmResult = (tokenUsage: Record<string, number>, generationInfo: Record<string, unknown> = {}): LLMResult => ({
  generations: [[{ text: "ok", generationInfo }]],
  llmOutput: { tokenUsage },
});

const attribution = (agent: string, stage: string, model?: string): Record<string, string> => ({
  cost_agent: agent,
  cost_stage: stage,
  ...(model && { cost_model: model }),
});

describe("makeUsageCollector", () => {
  it("records stage, agent, answering model and tokens for each call", async () => {
    const c = makeUsageCollector();
    await c.callback.handleChatModelStart({}, [], "run-1", undefined, undefined, undefined, attribution("jobhunt", "worker", "openrouter:inclusionai/ling-3.0-flash"));
    await c.callback.handleLLMEnd(llmResult({ promptTokens: 100, completionTokens: 20, totalTokens: 120 }), "run-1");

    expect(await c.take()).toEqual<LlmCallUsage[]>([
      { stage: "worker", agent: "jobhunt", model: "openrouter:inclusionai/ling-3.0-flash", inputTokens: 100, outputTokens: 20 },
    ]);
  });

  it("prefers the model name the response carries over the stage's built model", async () => {
    const c = makeUsageCollector();
    await c.callback.handleChatModelStart({}, [], "run-1", undefined, undefined, undefined, attribution("kernel", "planner", "google-genai:gemini-3.6-flash"));
    await c.callback.handleLLMEnd(llmResult({ promptTokens: 5, completionTokens: 5, totalTokens: 10 }, { model: "gemini-3.6-flash-001" }), "run-1");

    const [only] = await c.take();
    expect(only?.model).toBe("gemini-3.6-flash-001");
  });

  it("keeps concurrent calls apart by run id", async () => {
    const c = makeUsageCollector();
    await c.callback.handleChatModelStart({}, [], "r1", undefined, undefined, undefined, attribution("a", "worker", "x:one"));
    await c.callback.handleChatModelStart({}, [], "r2", undefined, undefined, undefined, attribution("b", "synthesizer", "x:two"));
    await c.callback.handleLLMEnd(llmResult({ promptTokens: 2, completionTokens: 2, totalTokens: 4 }), "r2");
    await c.callback.handleLLMEnd(llmResult({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }), "r1");

    const calls = await c.take();
    expect(calls.map((x) => [x.agent, x.stage, x.model, x.inputTokens])).toEqual([
      ["b", "synthesizer", "x:two", 2],
      ["a", "worker", "x:one", 1],
    ]);
  });

  it("labels a call with no attribution as unattributed instead of guessing a stage", async () => {
    const c = makeUsageCollector();
    await c.callback.handleLLMEnd(llmResult({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }), "run-x");
    const [only] = await c.take();
    expect(only).toMatchObject({ stage: "unattributed", agent: "kernel", model: "unknown" });
  });

  it("hands each call over once: take() empties the collector for the next task", async () => {
    const c = makeUsageCollector();
    await c.callback.handleLLMEnd(llmResult({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }), "r1");
    expect(await c.take()).toHaveLength(1);
    expect(await c.take()).toEqual([]);
  });

  it("never aborts a run: no spend cap applies to an eval call", async () => {
    const c = makeUsageCollector();
    await expect(
      c.callback.handleLLMEnd(llmResult({ promptTokens: 9_999_999, completionTokens: 9_999_999, totalTokens: 19_999_998 }), "r1"),
    ).resolves.toBeUndefined();
  });
});

describe("runEval latency", () => {
  const tasks: GoldenTask[] = [
    { id: "slow", input: "x", expectedRoute: "research" },
    { id: "boom", input: "y", expectedRoute: "research" },
  ];

  it("records how long the invoker took, for passed tasks and for invoker errors alike", async () => {
    const report = await runEval(tasks, async (task): Promise<Observation> => {
      await new Promise((r) => setTimeout(r, 15));
      if (task.id === "boom") throw new Error("503");
      return { route: "research", tools: [], hadInterrupt: false };
    });

    for (const r of report.results) {
      expect(r.latencyMs).toBeGreaterThanOrEqual(10);
      expect(r.latencyMs).toBeLessThan(5000);
    }
  });
});

describe("makeKernelInvoker with a usage collector", () => {
  class ScriptedModel implements KernelBindableModel {
    constructor(private readonly reply: AIMessage) {}
    bindTools(): ScriptedModel {
      return this;
    }
    async invoke(): Promise<AIMessage> {
      return this.reply;
    }
  }

  const task: GoldenTask = { id: "t1", input: "hello", expectedRoute: "comms" };
  const buildReplyKernel = () =>
    buildKernel({
      plannerModel: new ScriptedModel(new AIMessage(JSON.stringify({ type: "reply", text: "hi" }))),
      workerModel: new ScriptedModel(new AIMessage("")),
      synthesizerModel: new ScriptedModel(new AIMessage("")),
      workers: [{ id: "comms", description: "d", prompt: "p", tools: [] }],
      checkpointer: new MemorySaver(),
    });

  it("attaches the collector's callback to the turn and puts the calls on the observation", async () => {
    const k = buildReplyKernel();
    const spy = vi.spyOn(k, "invoke");
    const seen: LlmCallUsage[] = [{ stage: "planner", agent: "kernel", model: "x:y", inputTokens: 3, outputTokens: 4 }];
    const collector = { callback: { name: "probe" } as never, take: vi.fn(async () => seen) };

    const obs = await makeKernelInvoker(k, collector)(task);

    const passed = spy.mock.calls[0]![1] as { callbacks?: unknown[] };
    expect(passed.callbacks).toEqual([collector.callback]);
    expect(obs.usage).toEqual(seen);
    expect(obs.reply).toBe("hi");
  });

  it("still reports the usage of a turn that failed", async () => {
    const k = buildReplyKernel();
    vi.spyOn(k, "invoke").mockRejectedValue(new Error("Anthropic 400"));
    const seen: LlmCallUsage[] = [{ stage: "planner", agent: "kernel", model: "x:y", inputTokens: 1, outputTokens: 0 }];
    const collector = { callback: { name: "probe" } as never, take: async () => seen };

    const obs = await makeKernelInvoker(k, collector)(task);

    expect(obs.error).toContain("Anthropic 400");
    expect(obs.usage).toEqual(seen);
  });

  it("without a collector the turn is unchanged: no callbacks, no usage field", async () => {
    const k = buildReplyKernel();
    const spy = vi.spyOn(k, "invoke");

    const obs = await makeKernelInvoker(k)(task);

    const passed = spy.mock.calls[0]![1] as { callbacks?: unknown[] };
    expect(passed.callbacks).toBeUndefined();
    expect(obs).not.toHaveProperty("usage");
  });
});
