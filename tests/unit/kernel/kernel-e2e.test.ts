/**
 * v3 kernel — offline E2E of the FULL graph (DoD level 2).
 * Scripted models at the fetch-free boundary; REAL StateGraph, checkpointer,
 * interrupt/resume, receipts, and validation. Every scenario that broke the
 * old system (audit Runs A–D) has a terminal-state assertion here.
 */

import { describe, it, expect, vi } from "vitest";
import { MemorySaver, Command, interrupt } from "@langchain/langgraph";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import {
  buildKernel,
  getPendingKernelApproval,
  hashToolArgs,
  KERNEL_SCHEMA_VERSION,
  type KernelBindableModel,
  type KernelTool,
  summarizePreviousTurn,
  type WorkerSpec,
} from "../../../src/kernel/index.js";

// ── Scripted model ────────────────────────────────────────────────────────────

class ScriptedModel implements KernelBindableModel {
  calls = 0;
  received: BaseMessage[][] = [];
  constructor(private script: Array<AIMessage | ((msgs: BaseMessage[]) => AIMessage)>, private loop = false) {}
  bindTools(): ScriptedModel {
    return this;
  }
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.received.push(messages);
    const idx = this.loop ? this.calls % this.script.length : this.calls;
    this.calls += 1;
    const entry = this.script[idx];
    if (!entry) throw new Error(`ScriptedModel exhausted after ${this.calls - 1} calls`);
    return typeof entry === "function" ? entry(messages) : entry;
  }
}

const ai = (content: string) => new AIMessage(content);
const aiTool = (name: string, args: Record<string, unknown>, id = "c1") =>
  new AIMessage({ content: "", tool_calls: [{ name, args, id, type: "tool_call" }] });

const planJson = (steps: unknown[]) =>
  JSON.stringify({ type: "plan", plan: { schema_version: KERNEL_SCHEMA_VERSION, goal: "test goal", steps } });

const researchStep = (over: Record<string, unknown> = {}) => ({
  step_id: "s1",
  worker: "research",
  objective: "Find the latest LangGraph news",
  inputs: {},
  expected: { kind: "data", schema_ref: "research.findings" },
  constraints: { max_tool_calls: 2, hitl_required: false },
  ...over,
});

function makeWorkers(tools: KernelTool[]): WorkerSpec[] {
  return [
    { id: "research", description: "web research", prompt: "You are the research worker.", tools },
    { id: "comms", description: "email + calendar", prompt: "You are the comms worker.", tools },
  ];
}

const searchTool = (impl?: (args: Record<string, unknown>) => Promise<unknown>): KernelTool => ({
  name: "search_web",
  description: "search the web",
  invoke: impl ?? (async () => JSON.stringify({ success: true, data: [{ title: "LangGraph 1.4", url: "https://x.dev" }] })),
});

const cfg = (thread: string) => ({ configurable: { thread_id: thread } });

function kernelWith(planner: ScriptedModel, worker: ScriptedModel, synth: ScriptedModel, tools: KernelTool[]) {
  return buildKernel({
    plannerModel: planner,
    workerModel: worker,
    synthesizerModel: synth,
    workers: makeWorkers(tools),
    checkpointer: new MemorySaver(),
  });
}

const turn = (raw_input: string) => ({
  turn: { id: "t1", chat_id: "1", received_at: new Date().toISOString(), raw_input },
});

// ── Scenarios ─────────────────────────────────────────────────────────────────

describe("kernel E2E (scripted models, real graph)", () => {
  it("hello-world: direct reply costs exactly ONE LLM call", async () => {
    const planner = new ScriptedModel([ai(JSON.stringify({ type: "reply", text: "Hello! How can I help?" }))]);
    const worker = new ScriptedModel([]);
    const synth = new ScriptedModel([]);
    const k = kernelWith(planner, worker, synth, [searchTool()]);

    const res = await k.invoke(turn("hello"), cfg("hello"));
    expect(res.reply).toBe("Hello! How can I help?");
    expect(res.mission.status).toBe("done");
    expect(planner.calls).toBe(1);
    expect(worker.calls).toBe(0);
    expect(synth.calls).toBe(0);
  });

  it("route override builds a deterministic plan with ZERO planner LLM calls", async () => {
    const planner = new ScriptedModel([]);
    const worker = new ScriptedModel([ai(JSON.stringify({ text: "42 open issues" }))]);
    const synth = new ScriptedModel([ai("There are 42 open issues.")]);
    const k = kernelWith(planner, worker, synth, [searchTool()]);

    const res = await k.invoke(turn("[route directly to research] count issues"), cfg("override"));
    expect(planner.calls).toBe(0);
    expect(res.mission.plan?.steps[0]?.worker).toBe("research");
    expect(res.mission.status).toBe("done");
  });

  it("single-step tool task: executes, records a code-side receipt, synthesizes with receipt block", async () => {
    const planner = new ScriptedModel([ai(planJson([researchStep()]))]);
    const worker = new ScriptedModel([
      aiTool("search_web", { query: "LangGraph news" }),
      ai(JSON.stringify({ summary: "LangGraph 1.4 released", sources: [{ title: "LangGraph 1.4", url: "https://x.dev" }] })),
    ]);
    const synth = new ScriptedModel([ai("LangGraph 1.4 was released.")]);
    const k = kernelWith(planner, worker, synth, [searchTool()]);

    const res = await k.invoke(turn("research LangGraph news"), cfg("single"));
    expect(res.mission.status).toBe("done");
    const r0 = res.results[0]!;
    expect(r0.status).toBe("ok");
    if (r0.status === "ok") {
      expect(r0.tool_receipts).toHaveLength(1);
      expect(r0.tool_receipts[0]!.ok).toBe(true);
      expect(r0.tool_receipts[0]!.args_hash).toBe(hashToolArgs({ query: "LangGraph news" }));
    }
    expect(res.reply).toContain("Action receipts");
    expect(res.reply).toContain("search_web");
    // 1 planner + 2 worker + 1 synth — bounded, measured.
    expect(planner.calls + worker.calls + synth.calls).toBe(4);
  });

  it("multi-step: step 2's envelope receives step 1's VALIDATED output (typed data bus)", async () => {
    const planner = new ScriptedModel([
      ai(
        planJson([
          researchStep(),
          {
            step_id: "s2",
            worker: "comms",
            objective: "Draft an email summarizing the findings",
            inputs: { findings: "s1" },
            expected: { kind: "draft", schema_ref: "draft.email" },
            constraints: { max_tool_calls: 1, hitl_required: false },
          },
        ]),
      ),
    ]);
    const worker = new ScriptedModel([
      ai(JSON.stringify({ summary: "LangGraph 1.4 released", sources: [] })),
      ai(JSON.stringify({ to: "sam@x.dev", subject: "LangGraph 1.4", body: "It shipped." })),
    ]);
    const synth = new ScriptedModel([ai("Draft ready.")]);
    const k = kernelWith(planner, worker, synth, [searchTool()]);

    const res = await k.invoke(turn("research then draft email"), cfg("multi"));
    expect(res.mission.status).toBe("done");
    expect(res.results).toHaveLength(2);
    // The second worker invocation's envelope contains the RESOLVED step-1 output.
    const step2Msgs = worker.received[1]!;
    const envelopeMsg = step2Msgs.find((m) => m instanceof HumanMessage) as HumanMessage;
    expect(String(envelopeMsg.content)).toContain("LangGraph 1.4 released");
  });

  it("HITL approve: pauses at the gated tool, resume runs the side effect exactly once", async () => {
    const sideEffect = vi.fn();
    const gated: KernelTool = {
      name: "send_email",
      invoke: async (args) => {
        const decision = interrupt({ kind: "approval", action: "send_email", title: "Send email?", args });
        if (decision !== "approved") return "❌ Rejected by founder.";
        sideEffect(args);
        return JSON.stringify({ success: true, message_id: "m1" });
      },
    };
    const planner = new ScriptedModel([
      ai(planJson([researchStep({ worker: "comms", expected: { kind: "action_receipt", schema_ref: "action.summary" }, objective: "Send the email to sam@x.dev" })])),
    ]);
    const worker = new ScriptedModel([
      aiTool("send_email", { to: "sam@x.dev", subject: "hi", body: "hello" }),
      ai(JSON.stringify({ summary: "Email sent to sam@x.dev" })),
    ]);
    const synth = new ScriptedModel([ai("Sent.")]);
    const k = kernelWith(planner, worker, synth, [gated]);

    const paused = await k.invoke(turn("send the email"), cfg("approve"));
    expect(paused.mission.status).toBe("executing");
    const approval = await getPendingKernelApproval(k, cfg("approve"));
    expect(approval).toMatchObject({ kind: "approval", action: "send_email" });
    expect(sideEffect).not.toHaveBeenCalled();

    const res = await k.invoke(new Command({ resume: "approved" }), cfg("approve"));
    expect(sideEffect).toHaveBeenCalledTimes(1);
    expect(res.mission.status).toBe("done");
    const r0 = res.results[0]!;
    if (r0.status === "ok") expect(r0.tool_receipts[0]!.ok).toBe(true);
    expect(res.reply).toContain("Action receipts");
  });

  it("HITL reject: typed hitl_rejected failure, NO side effect, state PRESERVED (no thread wipe)", async () => {
    const sideEffect = vi.fn();
    const gated: KernelTool = {
      name: "send_email",
      invoke: async (args) => {
        const decision = interrupt({ kind: "approval", action: "send_email", title: "Send email?", args });
        if (decision !== "approved") return "❌ Rejected by founder.";
        sideEffect(args);
        return JSON.stringify({ success: true });
      },
    };
    const planner = new ScriptedModel([
      ai(planJson([researchStep({ worker: "comms", expected: { kind: "action_receipt", schema_ref: "action.summary" }, objective: "Send the email to sam@x.dev" })])),
    ]);
    const worker = new ScriptedModel([
      aiTool("send_email", { to: "sam@x.dev", subject: "hi", body: "hello" }),
      ai(JSON.stringify({ summary: "not sent" })),
    ]);
    const synth = new ScriptedModel([]);
    const k = kernelWith(planner, worker, synth, [gated]);

    await k.invoke(turn("send the email"), cfg("reject"));
    const res = await k.invoke(new Command({ resume: "rejected" }), cfg("reject"));

    expect(sideEffect).not.toHaveBeenCalled();
    expect(res.mission.status).toBe("failed");
    expect(res.failure?.stage).toBe("hitl_rejected");
    expect(res.reply).toContain("Nothing was sent");
    // No thread wipe: the mission state survives in the checkpoint.
    const state = await k.getState(cfg("reject"));
    expect(state.values.mission.plan).not.toBeNull();
  });

  it("unproven action claim: ok-output with no successful receipt is REJECTED, retried once, then typed failure", async () => {
    const failingTool = searchTool(async () => {
      throw new Error("Apify quota exhausted");
    });
    const planner = new ScriptedModel([
      ai(planJson([researchStep({ expected: { kind: "action_receipt", schema_ref: "action.summary" }, objective: "Post the update to the site" })])),
    ]);
    // Model fabricates success on both attempts.
    const worker = new ScriptedModel(
      [aiTool("search_web", { q: "x" }), ai(JSON.stringify({ summary: "posted successfully!" }))],
      true,
    );
    const synth = new ScriptedModel([]);
    const k = kernelWith(planner, worker, synth, [failingTool]);

    const res = await k.invoke(turn("post the update"), cfg("fabricate"));
    expect(res.mission.status).toBe("failed");
    expect(res.failure?.stage).toBe("validation");
    expect(res.failure?.message).toMatch(/receipt/);
    expect(res.attempts["s1"]).toBe(2); // one original + ONE visible retry
    expect(res.reply).toContain("Task stopped");
  });

  it("loop scenario (audit Run-D): tool budget TERMINATES the loop with a typed failure — no recursion error, no wipe", async () => {
    // The pathological model: ALWAYS calls the tool, never finalizes.
    const worker = new ScriptedModel([(_msgs) => aiTool("search_web", { q: "again" })], true);
    const planner = new ScriptedModel([ai(planJson([researchStep()]))]);
    const synth = new ScriptedModel([]);
    let executions = 0;
    const tool = searchTool(async () => {
      executions += 1;
      return "results";
    });
    const k = kernelWith(planner, worker, synth, [tool]);

    const res = await k.invoke(turn("research forever"), cfg("loop"));
    expect(res.mission.status).toBe("failed");
    expect(res.failure?.stage).toBe("validation");
    // Cap = 2 → exactly 2 executions per attempt, 2 attempts. Never 10 wasted hops.
    expect(executions).toBe(4);
    expect(worker.calls).toBeLessThanOrEqual(8);
    // The thread survives with full state (the old system wiped it here).
    const state = await k.getState(cfg("loop"));
    expect(state.values.results.length).toBeGreaterThan(0);
  });

  it("determinism: identical inputs produce byte-identical plans and results", async () => {
    const build = () =>
      kernelWith(
        new ScriptedModel([ai(planJson([researchStep()]))]),
        new ScriptedModel([
          aiTool("search_web", { query: "LangGraph news" }),
          ai(JSON.stringify({ summary: "LangGraph 1.4 released", sources: [] })),
        ]),
        new ScriptedModel([ai("LangGraph 1.4 was released.")]),
        [searchTool()],
      );

    const a = await build().invoke(turn("research LangGraph news"), cfg("d1"));
    const b = await build().invoke(turn("research LangGraph news"), cfg("d2"));
    expect(JSON.stringify(a.mission.plan)).toBe(JSON.stringify(b.mission.plan));
    const stripReceipts = (r: typeof a.results) =>
      JSON.stringify(r, (k2, v) => (k2 === "at" ? "T" : v));
    expect(stripReceipts(a.results)).toBe(stripReceipts(b.results));
  });

  it("planner returning garbage → typed planning failure, no execution", async () => {
    const planner = new ScriptedModel([ai("I think we should probably do some research maybe?")]);
    const worker = new ScriptedModel([]);
    const synth = new ScriptedModel([]);
    const k = kernelWith(planner, worker, synth, [searchTool()]);

    const res = await k.invoke(turn("do the thing"), cfg("garbage"));
    expect(res.mission.status).toBe("failed");
    expect(res.failure?.stage).toBe("planning");
    expect(worker.calls).toBe(0);
    expect(res.reply).toContain("planning failure");
  });
});

// ── Cross-turn memory (conversation history hydrated from the checkpointer) ───

const turnAt = (id: string, raw_input: string) => ({
  turn: { id, chat_id: "1", received_at: new Date().toISOString(), raw_input },
});

describe("cross-turn memory (checkpointer-hydrated history)", () => {
  it("turn 2's planner sees turn 1's exchange — even across a kernel rebuild (process restart)", async () => {
    const saver = new MemorySaver();
    const build = (planner: ScriptedModel) =>
      buildKernel({
        plannerModel: planner,
        workerModel: new ScriptedModel([]),
        synthesizerModel: new ScriptedModel([]),
        workers: makeWorkers([searchTool()]),
        checkpointer: saver,
      });

    const p1 = new ScriptedModel([ai(JSON.stringify({ type: "reply", text: "Tagline drafted: Ship boring, win big." }))]);
    const r1 = await build(p1).invoke(turnAt("t1", "Draft a tagline for Turicks"), cfg("memory"));
    expect(r1.reply).toContain("Ship boring, win big.");

    // Process restart: NEW graph instance, same (Postgres-backed in prod) checkpointer.
    const p2 = new ScriptedModel([
      (msgs) => {
        const all = msgs.map((m) => String(m.content)).join("\n");
        expect(all).toContain("Draft a tagline for Turicks");
        expect(all).toContain("Ship boring, win big.");
        return ai(JSON.stringify({ type: "reply", text: "That tagline was: Ship boring, win big." }));
      },
    ]);
    const r2 = await build(p2).invoke(turnAt("t2", "What tagline did you draft?"), cfg("memory"));
    expect(p2.calls).toBe(1);
    expect(r2.reply).toBe("That tagline was: Ship boring, win big.");
    // Turn 1 is now durably summarized in the thread's history channel.
    expect(r2.history.at(-1)?.user_input).toBe("Draft a tagline for Turicks");
    expect(r2.history.at(-1)?.outcome).toBe("replied");
  });

  it("prod regression ('Send it'): a FAILED turn's reply + evidence is visible to the next turn's planner", async () => {
    const saver = new MemorySaver();
    const build = (planner: ScriptedModel, worker: ScriptedModel) =>
      buildKernel({
        plannerModel: planner,
        workerModel: worker,
        synthesizerModel: new ScriptedModel([]),
        workers: makeWorkers([searchTool()]),
        checkpointer: saver,
      });

    // Turn 1: worker never finalizes with valid JSON → validation failure (the 23:02 prod trace).
    const p1 = new ScriptedModel([
      ai(planJson([researchStep({ worker: "comms", objective: "Draft reply to the Google security alert" })])),
    ]);
    const w1 = new ScriptedModel([ai("Here is the draft: Dear Google, thanks for the alert.")], true);
    const r1 = await build(p1, w1).invoke(turnAt("t1", "Draft a reply to the Google email"), cfg("sendit"));
    expect(r1.mission.status).toBe("failed");

    // Turn 2: "Send it" — the planner must see what "it" refers to.
    const p2 = new ScriptedModel([
      (msgs) => {
        const all = msgs.map((m) => String(m.content)).join("\n");
        expect(all).toContain("Draft a reply to the Google email");
        expect(all).toContain("[turn failed]");
        return ai(JSON.stringify({ type: "reply", text: "Retrying the Google draft." }));
      },
    ]);
    const r2 = await build(p2, new ScriptedModel([])).invoke(turnAt("t2", "Send it"), cfg("sendit"));
    expect(p2.calls).toBe(1);
    expect(r2.reply).toBe("Retrying the Google draft.");
    expect(r2.history.at(-1)?.outcome).toBe("failed");
  });

  it("HITL pause: a turn awaiting approval is NOT summarized; after resume it lands in history with its final reply", async () => {
    const saver = new MemorySaver();
    const gated: KernelTool = {
      name: "send_email",
      invoke: async (args) => {
        const decision = interrupt({ kind: "approval", action: "send_email", title: "Send email?", args });
        if (decision !== "approved") return "❌ Rejected by founder.";
        return JSON.stringify({ success: true, message_id: "m1" });
      },
    };
    const build = (planner: ScriptedModel, worker: ScriptedModel, synth: ScriptedModel) =>
      buildKernel({
        plannerModel: planner,
        workerModel: worker,
        synthesizerModel: synth,
        workers: makeWorkers([gated]),
        checkpointer: saver,
      });

    const p1 = new ScriptedModel([
      ai(planJson([researchStep({ worker: "comms", expected: { kind: "action_receipt", schema_ref: "action.summary" }, objective: "Send the email to sam@x.dev" })])),
    ]);
    const w1 = new ScriptedModel([
      aiTool("send_email", { to: "sam@x.dev", subject: "hi", body: "hello" }),
      ai(JSON.stringify({ summary: "Email sent to sam@x.dev" })),
    ]);
    const synth = new ScriptedModel([ai("Sent the email to sam.")]);
    const k1 = build(p1, w1, synth);

    await k1.invoke(turnAt("t1", "send the email"), cfg("hitl-mem"));
    // Paused: reply empty ⇒ the turn must NOT be summarizable yet.
    const paused = await k1.getState(cfg("hitl-mem"));
    expect(paused.values.reply).toBe("");
    expect(summarizePreviousTurn(paused.values)).toBeNull();

    await k1.invoke(new Command({ resume: "approved" }), cfg("hitl-mem"));

    // Next turn (fresh kernel = process restart): turn 1 appears ONCE, with the post-resume reply.
    const p2 = new ScriptedModel([
      (msgs) => {
        const all = msgs.map((m) => String(m.content)).join("\n");
        expect(all).toContain("send the email");
        expect(all).toContain("Sent the email to sam.");
        return ai(JSON.stringify({ type: "reply", text: "Yes — it went out." }));
      },
    ]);
    const r2 = await build(p2, new ScriptedModel([]), new ScriptedModel([])).invoke(
      turnAt("t2", "did that go out?"),
      cfg("hitl-mem"),
    );
    expect(p2.calls).toBe(1);
    expect(r2.history).toHaveLength(1);
    expect(r2.history[0]?.turn_id).toBe("t1");
    expect(r2.history[0]?.outcome).toBe("done");
  });

  it("history is capped: only the most recent turns are retained", async () => {
    const saver = new MemorySaver();
    const build = (planner: ScriptedModel) =>
      buildKernel({
        plannerModel: planner,
        workerModel: new ScriptedModel([]),
        synthesizerModel: new ScriptedModel([]),
        workers: makeWorkers([searchTool()]),
        checkpointer: saver,
      });

    for (let i = 1; i <= 25; i += 1) {
      const p = new ScriptedModel([ai(JSON.stringify({ type: "reply", text: `reply ${i}` }))]);
      await build(p).invoke(turnAt(`t${i}`, `message ${i}`), cfg("cap"));
    }
    const state = await build(new ScriptedModel([])).getState(cfg("cap"));
    const history = state.values.history as Array<{ user_input: string }>;
    expect(history.length).toBeLessThanOrEqual(20);
    expect(history.at(-1)?.user_input).toBe("message 24"); // turn 25 itself summarizes on the NEXT turn
  });
});
