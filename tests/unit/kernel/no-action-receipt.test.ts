/**
 * A tool that deliberately did nothing is not an action.
 * =====================================================
 * Prod reply 53f253d7 (2026-10-07): the second dispatch_antigravity_task call returned "Already dispatched … (skipped
 * duplicate)". It was an ok receipt for a HITL-gated tool, so the footer read "✓ 2 actions completed and verified"
 * under one filed issue and one skip. The skip must stay ok (the synthesizer only sees ok results, and the founder
 * needs to read "nothing was filed"), so it is marked as a receipt that did not act, and the footer counts only acts.
 */

import { describe, it, expect, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { makeToolsNode, type KernelTool, type WorkerSpec } from "../../../src/kernel/worker.js";
import { founderReceiptsBlock, type StepResult } from "../../../src/kernel/index.js";
import { NO_ACTION_PREFIX, isFailureResult, isNoActionResult } from "../../../src/kernel/tool-failure.js";
import { NO_ACTION_PREFIX as AGENT_NO_ACTION_PREFIX } from "../../../src/agents/tool-result.js";
import type { ToolReceipt } from "../../../src/kernel/contracts.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

const SKIP = `${NO_ACTION_PREFIX} Already dispatched earlier: "x" on o/r. Nothing new was filed.`;

describe("isNoActionResult", () => {
  it("the agents' copy of the prefix is the kernel's (the kernel cannot import agents)", () => {
    expect(AGENT_NO_ACTION_PREFIX).toBe(NO_ACTION_PREFIX);
  });

  it("a no-action result is not a failure, and is recognised", () => {
    expect(isFailureResult(SKIP)).toBe(false);
    expect(isNoActionResult(SKIP)).toBe(true);
    expect(isNoActionResult(`  ${SKIP}`)).toBe(true);
  });

  it("a result that only quotes the prefix later did act", () => {
    expect(isNoActionResult(`✅ Filed #84. Earlier: ${NO_ACTION_PREFIX} skipped`)).toBe(false);
  });
});

function stateWithCall(name: string): KernelStateType {
  const ai = new AIMessage({ content: "", tool_calls: [{ id: "c1", name, args: { title: "x" } }] });
  return {
    turn: { id: "t", chat_id: "1", received_at: "", raw_input: "" },
    mission: {
      goal: "g",
      status: "executing",
      plan: {
        schema_version: 1,
        goal: "g",
        steps: [
          {
            step_id: "s1",
            worker: "engineering",
            objective: "o",
            inputs: {},
            expected: { kind: "action_receipt" },
            constraints: { max_tool_calls: 5, hitl_required: true },
          },
        ],
      },
      cursor: 0,
    },
    results: [],
    attempts: {},
    failure: null,
    scratch: { s1: [ai] },
    step_receipts: { s1: [] },
    reply: "",
    last_turn: null,
    history: [],
  } as unknown as KernelStateType;
}

function specWith(tool: KernelTool): Record<string, WorkerSpec> {
  return { engineering: { id: "engineering" as WorkerSpec["id"], description: "d", prompt: "p", tools: [tool] } };
}

describe("worker receipts", () => {
  it("a no-action result is an ok receipt marked acted:false", async () => {
    const tool: KernelTool = { name: "dispatch_antigravity_task", invoke: vi.fn(async () => SKIP) };
    const update = await makeToolsNode(specWith(tool))(stateWithCall("dispatch_antigravity_task"));
    const [r] = (update.step_receipts as Record<string, ToolReceipt[]>)["s1"] ?? [];
    expect(r).toMatchObject({ tool: "dispatch_antigravity_task", ok: true, acted: false });
  });

  it("an ordinary success carries no acted flag", async () => {
    const tool: KernelTool = { name: "dispatch_antigravity_task", invoke: vi.fn(async () => "✅ Filed #84") };
    const update = await makeToolsNode(specWith(tool))(stateWithCall("dispatch_antigravity_task"));
    const [r] = (update.step_receipts as Record<string, ToolReceipt[]>)["s1"] ?? [];
    expect(r?.ok).toBe(true);
    expect(r && "acted" in r).toBe(false);
  });
});

describe("founderReceiptsBlock", () => {
  const receipt = (over: Partial<ToolReceipt>): ToolReceipt => ({
    tool: "dispatch_antigravity_task",
    args_hash: "a".repeat(64),
    result_digest: "b".repeat(64),
    ok: true,
    at: new Date().toISOString(),
    ...over,
  });
  const step = (tool_receipts: ToolReceipt[]): StepResult => ({ step_id: "s1", status: "ok", output: {}, tool_receipts });

  it("one filed issue and one skipped duplicate is ONE action (prod 53f253d7 printed 2)", () => {
    expect(founderReceiptsBlock([step([receipt({}), receipt({ acted: false })])])).toContain("✓ 1 action completed");
  });

  it("only skips: no ✓ line at all", () => {
    expect(founderReceiptsBlock([step([receipt({ acted: false })])])).toBe("");
  });
});
