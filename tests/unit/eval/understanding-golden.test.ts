/**
 * AG-030 — multi-turn understanding golden set. $0: scripted models only.
 * Proves the plumbing (prior turns replayed in order on one thread, reply scoring),
 * NOT that the scripted model passes any case.
 */

import { describe, it, expect } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { buildKernel, type KernelBindableModel } from "../../../src/kernel/index.js";
import { makeKernelInvoker, seedPriorTurns } from "../../../src/eval/kernel-invoker.js";
import { scoreMentions, scoreTask } from "../../../src/eval/scoring.js";
import { UNDERSTANDING_GOLDEN_TASKS } from "../../../src/eval/understanding-golden.js";
import { GOLDEN_TASKS } from "../../../src/eval/golden-tasks.js";
import type { GoldenTask, Observation } from "../../../src/eval/types.js";

const obs = (reply?: string): Observation => ({ route: null, tools: [], hadInterrupt: false, reply });
const base: GoldenTask = { id: "t", input: "x", expectedRoute: null };

describe("scoreMentions", () => {
  it("passes when no lists are declared, whatever the reply", () => {
    expect(scoreMentions(base, obs("anything"))).toBe(true);
    expect(scoreMentions(base, obs(undefined))).toBe(true);
  });

  it("requires every mustMention, case-insensitively", () => {
    const t = { ...base, mustMention: ["#676", "Oplify"] };
    expect(scoreMentions(t, obs("PR #676 on oplify is open"))).toBe(true);
    expect(scoreMentions(t, obs("PR #676 is open"))).toBe(false);
    expect(scoreMentions(t, obs(undefined))).toBe(false);
  });

  it("fails on any mustNotMention, and a missing reply satisfies it", () => {
    const t = { ...base, mustNotMention: ["actively executing", "I'll monitor"] };
    expect(scoreMentions(t, obs("It is ACTIVELY EXECUTING now"))).toBe(false);
    expect(scoreMentions(t, obs("Task not started."))).toBe(true);
    expect(scoreMentions(t, obs(undefined))).toBe(true);
  });

  it("feeds into passed, and old cases are unchanged", () => {
    const t = { ...base, mustMention: ["#676"] };
    expect(scoreTask(t, obs("nothing")).passed).toBe(false);
    expect(scoreTask(t, obs("see #676")).passed).toBe(true);
    expect(scoreTask(base, obs(undefined)).mentionsCorrect).toBe(true);
    expect(GOLDEN_TASKS.every((g) => g.priorTurns === undefined && g.mustMention === undefined)).toBe(true);
  });
});

describe("seedPriorTurns", () => {
  it("writes each prior turn in order on the same config", async () => {
    const calls: Array<{ config: unknown; values: { history: Array<{ user_input: string; reply: string; at: string }> } }> = [];
    const kernel = {
      updateState: async (config: unknown, values: Record<string, unknown>) => {
        calls.push({ config, values: values as never });
      },
    };
    const config = { configurable: { thread_id: "th" } };
    await seedPriorTurns(kernel, config, "th", [
      { user: "first", reply: "r1" },
      { user: "second", reply: "r2" },
    ]);
    expect(calls.map((c) => c.values.history[0]!.user_input)).toEqual(["first", "second"]);
    expect(calls.every((c) => c.config === config)).toBe(true);
    const at = calls.map((c) => Date.parse(c.values.history[0]!.at));
    expect(at[0]!).toBeLessThan(at[1]!);
  });

  it("does nothing for a case with no prior turns", async () => {
    let n = 0;
    await seedPriorTurns({ updateState: async () => void n++ }, {}, "th", []);
    expect(n).toBe(0);
  });
});

class ScriptedModel implements KernelBindableModel {
  seen: BaseMessage[][] = [];
  constructor(private reply: string) {}
  bindTools(): ScriptedModel {
    return this;
  }
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.seen.push(messages);
    return new AIMessage(this.reply);
  }
}

describe("makeKernelInvoker with priorTurns (real kernel, scripted models)", () => {
  it("shows the planner the prior turns in order, then captures the reply", async () => {
    const planner = new ScriptedModel(JSON.stringify({ type: "reply", text: "It is PR #676." }));
    const k = buildKernel({
      plannerModel: planner,
      workerModel: new ScriptedModel(""),
      synthesizerModel: new ScriptedModel(""),
      workers: [{ id: "comms", description: "d", prompt: "p", tools: [] }],
      checkpointer: new MemorySaver(),
    });
    const task: GoldenTask = {
      id: "t",
      input: "Is the PR ready?",
      expectedRoute: null,
      priorTurns: [
        { user: "List all the open pull request", reply: "PR #676 is open" },
        { user: "Thanks", reply: "You are welcome" },
      ],
      mustMention: ["#676"],
    };
    const result = await makeKernelInvoker(k)(task);

    expect(result.error).toBeUndefined();
    expect(result.reply).toContain("#676");
    const prompt = planner.seen[0]!.map((m) => String(m.content)).join("\n");
    const i1 = prompt.indexOf("List all the open pull request");
    const i2 = prompt.indexOf("Thanks");
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    expect(scoreTask(task, result).mentionsCorrect).toBe(true);
  });
});

describe("UNDERSTANDING_GOLDEN_TASKS", () => {
  it("has at least 14 cases with unique ids, each citing its prod turn", () => {
    expect(UNDERSTANDING_GOLDEN_TASKS.length).toBeGreaterThanOrEqual(14);
    const ids = UNDERSTANDING_GOLDEN_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of UNDERSTANDING_GOLDEN_TASKS) expect(t.note ?? "").toMatch(/prod turn/i);
  });

  it("holds no emails, phone numbers or long numeric ids", () => {
    const text = JSON.stringify(UNDERSTANDING_GOLDEN_TASKS);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(/\d{8,}/);
  });
});
