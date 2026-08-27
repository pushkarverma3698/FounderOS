/**
 * makeKernelInvoker — offline, deterministic proof of the D1 fix.
 * ==================================================================
 * docs/EVAL-AUDIT-2026-08-28.md D1 found that the eval invoker reported ZERO
 * tools for any step that paused on a HITL gate — nine tasks in the published
 * 2026-08-27 report scored `hitl: ✅` (an interrupt genuinely fired) alongside
 * `tools: ❌ [none]`, which is self-contradicting: the only way to reach a
 * gated tool's interrupt() is to have called that tool.
 *
 * These tests build a REAL kernel (buildKernel) with scripted models — no
 * network, no LLM cost — and drive it through `makeKernelInvoker` exactly like
 * `pnpm eval` does, to prove the fix against the real graph rather than a
 * mocked seam.
 *
 * Two distinct mechanisms had to be verified empirically (see kernel-invoker.ts's
 * own doc comment) because they behave differently:
 *   1. A tool call that already committed via a normal tools-node return
 *      before a LATER call in the same step paused — recoverable from
 *      `state.step_receipts`.
 *   2. The gated call ITSELF: every HITL tool in this codebase calls
 *      interrupt() BEFORE doing any work, so the tools node throws before its
 *      own receipt-recording line ever runs. `state.step_receipts` is
 *      genuinely `{}` in this case (proven against the real graph while
 *      building this fix) — the only record is the pending interrupt's own
 *      `{ action: "<tool name>" }` payload.
 */

import { describe, it, expect, vi } from "vitest";
import { MemorySaver, interrupt } from "@langchain/langgraph";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  buildKernel,
  KERNEL_SCHEMA_VERSION,
  type KernelBindableModel,
  type KernelTool,
  type WorkerSpec,
} from "../../../src/kernel/index.js";
import { OFFICE_RECURSION_LIMIT } from "../../../src/core/config.js";
import { makeKernelInvoker } from "../../../src/eval/kernel-invoker.js";
import type { GoldenTask } from "../../../src/eval/types.js";

class ScriptedModel implements KernelBindableModel {
  calls = 0;
  constructor(private script: Array<AIMessage | ((msgs: BaseMessage[]) => AIMessage)>) {}
  bindTools(): ScriptedModel {
    return this;
  }
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    const entry = this.script[this.calls];
    this.calls += 1;
    if (!entry) throw new Error(`ScriptedModel exhausted after ${this.calls - 1} calls`);
    return typeof entry === "function" ? entry(messages) : entry;
  }
}

const ai = (content: string) => new AIMessage(content);
const aiTool = (name: string, args: Record<string, unknown>, id = "c1") =>
  new AIMessage({ content: "", tool_calls: [{ name, args, id, type: "tool_call" }] });

const planJson = (steps: unknown[]) =>
  JSON.stringify({ type: "plan", plan: { schema_version: KERNEL_SCHEMA_VERSION, goal: "test goal", steps } });

function makeGatedTool(name: string): KernelTool {
  return {
    name,
    invoke: async (args) => {
      const decision = interrupt({ kind: "approval", action: name, title: `Run ${name}?`, args });
      if (decision !== "approved") return "❌ Rejected by founder.";
      return JSON.stringify({ success: true });
    },
  };
}

const task: GoldenTask = { id: "t1", input: "do the gated thing", expectedRoute: "comms" };

describe("makeKernelInvoker — recursion limit", () => {
  it("passes OFFICE_RECURSION_LIMIT, not LangGraph's bare default of 25", async () => {
    const planner = new ScriptedModel([ai(JSON.stringify({ type: "reply", text: "hi" }))]);
    const worker = new ScriptedModel([]);
    const synth = new ScriptedModel([]);
    const k = buildKernel({
      plannerModel: planner,
      workerModel: worker,
      synthesizerModel: synth,
      workers: [{ id: "comms", description: "d", prompt: "p", tools: [] }],
      checkpointer: new MemorySaver(),
    });

    const invokeSpy = vi.spyOn(k, "invoke");
    await makeKernelInvoker(k)(task);

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const passedConfig = invokeSpy.mock.calls[0]![1] as { recursionLimit?: number };
    expect(passedConfig.recursionLimit).toBe(OFFICE_RECURSION_LIMIT);
    expect(passedConfig.recursionLimit).not.toBe(25);
  });
});

describe("makeKernelInvoker — a single gated call that pauses on its FIRST attempt (D1)", () => {
  it("observes the gated tool even though it produced zero settled receipts (comms-send-known shape)", async () => {
    const gated = makeGatedTool("send_email");
    const step = {
      step_id: "s1",
      worker: "comms",
      objective: "Email the client a thank-you note",
      inputs: {},
      expected: { kind: "action_receipt", schema_ref: "action.summary" },
      constraints: { max_tool_calls: 2, hitl_required: true },
    };
    const planner = new ScriptedModel([ai(planJson([step]))]);
    const worker = new ScriptedModel([aiTool("send_email", { to: "alex@acme.com", subject: "hi", body: "thanks" })]);
    const synth = new ScriptedModel([]);
    const k = buildKernel({
      plannerModel: planner,
      workerModel: worker,
      synthesizerModel: synth,
      workers: [{ id: "comms", description: "d", prompt: "p", tools: [gated] }],
      checkpointer: new MemorySaver(),
    });

    const obs = await makeKernelInvoker(k)({
      id: "comms-send-known",
      input: "Email our client alex@acme.com a short thank-you note for the call.",
      expectedRoute: "comms",
      expectedTools: ["send_email"],
      expectsHitl: true,
    });

    expect(obs.hadInterrupt).toBe(true);
    expect(obs.route).toBe("comms");
    // The whole point of the fix: this used to be [] even though the gate
    // that just fired can ONLY be reached by calling send_email.
    expect(obs.tools).toContain("send_email");
    expect(obs.toolCalls).toContainEqual({ tool: "send_email", ok: true });
    expect(obs.steps).toEqual([{ worker: "comms", objective: "Email the client a thank-you note" }]);
  });
});

describe("makeKernelInvoker — an earlier committed call plus a later gated call in the same step (D1)", () => {
  it("unions the committed receipt (via state.step_receipts) with the paused call's interrupt payload", async () => {
    const scaffold: KernelTool = { name: "apply_cinematic_preset", invoke: async () => JSON.stringify({ success: true }) };
    const gated = makeGatedTool("claude_code");
    const step = {
      step_id: "s1",
      worker: "engineering",
      objective: "Scaffold then build the landing page",
      inputs: {},
      expected: { kind: "action_receipt", schema_ref: "action.summary" },
      constraints: { max_tool_calls: 3, hitl_required: true },
    };
    const planner = new ScriptedModel([ai(planJson([step]))]);
    const worker = new ScriptedModel([
      aiTool("apply_cinematic_preset", { preset: "neon" }, "c1"),
      aiTool("claude_code", { instructions: "build it" }, "c2"),
    ]);
    const synth = new ScriptedModel([]);
    const k = buildKernel({
      plannerModel: planner,
      workerModel: worker,
      synthesizerModel: synth,
      workers: [{ id: "engineering", description: "d", prompt: "p", tools: [scaffold, gated] }],
      checkpointer: new MemorySaver(),
    });

    const obs = await makeKernelInvoker(k)({
      id: "webdesign-build-landing",
      input: "Build a cinematic landing page using the neon preset.",
      expectedRoute: "engineering",
      expectedTools: ["apply_cinematic_preset", "claude_code"],
      expectsHitl: true,
    });

    expect(obs.hadInterrupt).toBe(true);
    expect(obs.tools).toEqual(expect.arrayContaining(["apply_cinematic_preset", "claude_code"]));
    expect(obs.toolCalls).toContainEqual({ tool: "apply_cinematic_preset", ok: true });
    expect(obs.toolCalls).toContainEqual({ tool: "claude_code", ok: true });
  });
});

describe("makeKernelInvoker — negative cases (no false positives)", () => {
  it("reports no tools/steps for a direct reply", async () => {
    const planner = new ScriptedModel([ai(JSON.stringify({ type: "reply", text: "Here's the function..." }))]);
    const worker = new ScriptedModel([]);
    const synth = new ScriptedModel([]);
    const k = buildKernel({
      plannerModel: planner,
      workerModel: worker,
      synthesizerModel: synth,
      workers: [{ id: "engineering", description: "d", prompt: "p", tools: [] }],
      checkpointer: new MemorySaver(),
    });

    const obs = await makeKernelInvoker(k)({
      id: "eng-write-code",
      input: "Write a TypeScript function that validates an email address.",
      expectedRoute: null,
      expectsHitl: false,
    });

    expect(obs.route).toBeNull();
    expect(obs.hadInterrupt).toBe(false);
    expect(obs.tools).toEqual([]);
    expect(obs.steps).toEqual([]);
  });

  it("a step that completes normally (no interrupt) still reports its real tool via settled results", async () => {
    const tool: KernelTool = { name: "search_web", invoke: async () => JSON.stringify({ success: true, data: [] }) };
    const step = {
      step_id: "s1",
      worker: "research",
      objective: "Research Stripe",
      inputs: {},
      expected: { kind: "data", schema_ref: "research.findings" },
      constraints: { max_tool_calls: 2, hitl_required: false },
    };
    const planner = new ScriptedModel([ai(planJson([step]))]);
    const worker = new ScriptedModel([
      aiTool("search_web", { query: "Stripe" }),
      ai(JSON.stringify({ summary: "Stripe processes payments.", sources: [] })),
    ]);
    const synth = new ScriptedModel([]);
    const k = buildKernel({
      plannerModel: planner,
      workerModel: worker,
      synthesizerModel: synth,
      workers: [{ id: "research", description: "d", prompt: "p", tools: [tool] }],
      checkpointer: new MemorySaver(),
    });

    const obs = await makeKernelInvoker(k)({
      id: "research-company",
      input: "Research what Stripe does.",
      expectedRoute: "research",
      expectedTools: ["search_web"],
      expectsHitl: false,
    });

    expect(obs.hadInterrupt).toBe(false);
    expect(obs.tools).toContain("search_web");
    expect(obs.toolCalls).toContainEqual({ tool: "search_web", ok: true });
  });
});
