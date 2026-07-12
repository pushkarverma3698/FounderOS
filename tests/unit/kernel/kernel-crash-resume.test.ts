/**
 * Crash-resume E2E on the REAL graph (offline, $0 — same recipe as
 * kernel-e2e.test.ts). The gateway's boot recovery (mission-resume.ts) rests
 * on three assumptions this file proves against the actual LangGraph runtime,
 * not fakes:
 *   1. a run that dies mid-flight leaves a checkpoint whose StateSnapshot
 *      carries the crash signature resumeDecision() looks for (real field
 *      names: next / tasks / createdAt / values);
 *   2. stream(null) on a REBUILT kernel (process restart) continues from the
 *      last valid node to a normal completed turn;
 *   3. after that completion the signature is gone — a second restart cannot
 *      re-run the mission (idempotent recovery).
 * Two death modes are exercised: recursion-limit termination between nodes,
 * and an AbortSignal fired mid-run (what the turn-timeout deadline now does).
 */

import { describe, it, expect } from "vitest";
import { MemorySaver, GraphRecursionError } from "@langchain/langgraph";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  buildKernel,
  KERNEL_SCHEMA_VERSION,
  type KernelBindableModel,
  type KernelTool,
  type WorkerSpec,
} from "../../../src/kernel/index.js";
import { resumeDecision, type MissionSnapshot } from "../../../src/gateway/mission-resume.js";

class ScriptedModel implements KernelBindableModel {
  calls = 0;
  constructor(private script: Array<AIMessage | ((msgs: BaseMessage[]) => AIMessage)>, private loop = false) {}
  bindTools(): ScriptedModel {
    return this;
  }
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    const idx = this.loop ? this.calls % this.script.length : this.calls;
    this.calls += 1;
    const entry = this.script[idx];
    if (!entry) throw new Error(`ScriptedModel exhausted after ${this.calls - 1} calls`);
    return typeof entry === "function" ? entry(messages) : entry;
  }
}

const ai = (content: string) => new AIMessage(content);
const planJson = (steps: unknown[]) =>
  JSON.stringify({ type: "plan", plan: { schema_version: KERNEL_SCHEMA_VERSION, goal: "crash-resume goal", steps } });

const researchStep = {
  step_id: "s1",
  worker: "research",
  objective: "Find the latest LangGraph news",
  inputs: {},
  expected: { kind: "data", schema_ref: "research.findings" },
  constraints: { max_tool_calls: 2, hitl_required: false },
};

const searchTool: KernelTool = {
  name: "search_web",
  description: "search the web",
  invoke: async () => JSON.stringify({ success: true, data: [{ title: "LangGraph 1.4", url: "https://x.dev" }] }),
};

const workers: WorkerSpec[] = [
  { id: "research", description: "web research", prompt: "You are the research worker.", tools: [searchTool] },
];

/** Fresh kernel over a SHARED saver — building twice = process restart. */
function buildOn(saver: MemorySaver, planner: ScriptedModel, worker: ScriptedModel, synth: ScriptedModel) {
  return buildKernel({
    plannerModel: planner,
    workerModel: worker,
    synthesizerModel: synth,
    workers,
    checkpointer: saver,
  });
}

const plannerScript = () => new ScriptedModel([ai(planJson([researchStep]))]);
const workerScript = () =>
  new ScriptedModel([ai(JSON.stringify({ summary: "LangGraph 1.4 released", sources: [] }))]);
const synthScript = () => new ScriptedModel([ai("LangGraph 1.4 was released.")]);

const cfg = (thread: string) => ({ configurable: { thread_id: thread } });
const turn = (raw_input: string) => ({
  turn: { id: "t1", chat_id: "1", received_at: new Date().toISOString(), raw_input },
});

async function drain(iter: AsyncIterable<unknown>): Promise<unknown> {
  let last: unknown;
  for await (const s of iter) last = s;
  return last;
}

describe("crash resume E2E (real graph, shared checkpointer)", () => {
  it("recursion-limit death mid-run → real snapshot carries the crash signature → stream(null) on a rebuilt kernel completes the mission → signature gone", async () => {
    const saver = new MemorySaver();

    // "Crash": the run terminates between nodes with committed checkpoints
    // (recursionLimit 2 lets plan + dispatch commit, then kills the step loop).
    const k1 = buildOn(saver, plannerScript(), workerScript(), synthScript());
    await expect(
      k1.invoke(turn("research LangGraph news"), { ...cfg("crash-rl"), recursionLimit: 2 }),
    ).rejects.toBeInstanceOf(GraphRecursionError);

    // Process restart: NEW kernel instance, same (Postgres-backed in prod) saver.
    const k2 = buildOn(saver, plannerScript(), workerScript(), synthScript());
    const snap = (await k2.getState(cfg("crash-rl"))) as unknown as MissionSnapshot;

    // The REAL StateSnapshot must satisfy the boot predicate on its real field names.
    expect(snap.next?.length).toBeGreaterThan(0);
    expect(resumeDecision(snap)).toEqual({ resume: true });

    // Boot recovery's exact call: continue this thread from its checkpoint.
    const res = (await drain(
      await k2.stream(null, { ...cfg("crash-rl"), streamMode: "values" }),
    )) as { mission: { status: string }; reply: string; results: Array<{ status: string }> };
    expect(res.mission.status).toBe("done");
    expect(res.reply).toContain("LangGraph 1.4 was released.");
    expect(res.results[0]!.status).toBe("ok");

    // Idempotence: a second restart finds nothing to resume.
    const after = (await k2.getState(cfg("crash-rl"))) as unknown as MissionSnapshot;
    const decision = resumeDecision(after);
    expect(decision.resume).toBe(false);
  });

  it("AbortSignal death mid-run (what the timeout deadline fires) leaves the same recoverable checkpoint", async () => {
    const saver = new MemorySaver();
    const abort = new AbortController();

    // The worker model aborts the run from INSIDE the graph — deterministic
    // stand-in for the deadline firing while a step executes.
    const abortingWorker = new ScriptedModel([
      () => {
        abort.abort();
        return ai(JSON.stringify({ summary: "never delivered", sources: [] }));
      },
    ]);
    const k1 = buildOn(saver, plannerScript(), abortingWorker, synthScript());
    await expect(
      drain(await k1.stream(turn("research LangGraph news"), { ...cfg("crash-abort"), streamMode: "values", signal: abort.signal })),
    ).rejects.toThrow();

    // Restart + boot predicate on the real post-abort snapshot.
    const k2 = buildOn(saver, plannerScript(), workerScript(), synthScript());
    const snap = (await k2.getState(cfg("crash-abort"))) as unknown as MissionSnapshot;
    expect(resumeDecision(snap)).toEqual({ resume: true });

    // Resume completes the interrupted step and the whole mission.
    const res = (await drain(
      await k2.stream(null, { ...cfg("crash-abort"), streamMode: "values" }),
    )) as { mission: { status: string }; reply: string };
    expect(res.mission.status).toBe("done");
    expect(res.reply).toContain("LangGraph 1.4 was released.");
  });

  it("a COMPLETED turn's snapshot never matches the crash signature (no spontaneous re-runs)", async () => {
    const saver = new MemorySaver();
    const k = buildOn(saver, plannerScript(), workerScript(), synthScript());
    const res = await k.invoke(turn("research LangGraph news"), cfg("clean"));
    expect(res.mission.status).toBe("done");

    const snap = (await k.getState(cfg("clean"))) as unknown as MissionSnapshot;
    const decision = resumeDecision(snap);
    expect(decision.resume).toBe(false);
  });
});
