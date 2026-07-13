/**
 * makeToolsNode — duplicate FAILED tool-call guard (2026-07-13 prod audit).
 * LIVE FAILURE turn 49dbaa06: a worker re-issued the IDENTICAL ENOENT
 * project_workflow call and the IDENTICAL github_read call within one step,
 * burning 4+ LLM roundtrips (and re-hitting the failing external surface) on
 * calls whose receipts already proved they fail. Before invoking, an identical
 * (tool + args_hash) call that already FAILED in this step must be short-
 * circuited with a synthetic ToolMessage — no re-invoke, no new receipt.
 */

import { describe, it, expect, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { makeToolsNode, type KernelTool, type WorkerSpec } from "../../../src/kernel/worker.js";
import { hashToolArgs, type ToolReceipt } from "../../../src/kernel/contracts.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

function specWith(tool: KernelTool): Record<string, WorkerSpec> {
  return { research: { id: "research" as WorkerSpec["id"], description: "d", prompt: "p", tools: [tool] } };
}

function receipt(tool: string, args: unknown, ok: boolean): ToolReceipt {
  return {
    tool,
    args_hash: hashToolArgs(args),
    result_digest: "0".repeat(64),
    ok,
    at: new Date().toISOString(),
  };
}

function stateWithCalls(
  calls: { id: string; name: string; args: Record<string, unknown> }[],
  receipts: ToolReceipt[],
  priorResults: { tool_receipts: ToolReceipt[] }[] = [],
): KernelStateType {
  const ai = new AIMessage({ content: "", tool_calls: calls });
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
            worker: "research",
            objective: "o",
            inputs: {},
            expected: { kind: "data", schema_ref: "research.findings" },
            constraints: { max_tool_calls: 5, hitl_required: false },
          },
        ],
      },
      cursor: 0,
    },
    results: priorResults,
    attempts: {},
    failure: null,
    scratch: [ai],
    step_receipts: receipts,
    reply: "",
    last_turn: null,
    history: [],
  } as unknown as KernelStateType;
}

describe("makeToolsNode — duplicate FAILED call guard (turn 49dbaa06)", () => {
  it("short-circuits a call identical to one that already FAILED this step — no re-invoke, no new receipt", async () => {
    const invoke = vi.fn(async () => "should not run");
    const tool: KernelTool = { name: "project_workflow", invoke };
    const args = { path: "/missing", op: "read" };
    const state = stateWithCalls(
      [{ id: "call-2", name: "project_workflow", args }],
      [receipt("project_workflow", args, false)],
    );

    const update = await makeToolsNode(specWith(tool))(state);

    expect(invoke).not.toHaveBeenCalled();
    expect(update.step_receipts).toEqual([]);
    const msg = update.scratch?.[0];
    expect(msg && String((msg as { content: unknown }).content)).toMatch(/already failed/i);
  });

  it("does NOT short-circuit when the identical prior call SUCCEEDED (only failures are guarded)", async () => {
    const invoke = vi.fn(async () => "fresh result");
    const tool: KernelTool = { name: "github_read", invoke };
    const args = { repo: "founderos", path: "README.md" };
    const state = stateWithCalls(
      [{ id: "call-2", name: "github_read", args }],
      [receipt("github_read", args, true)],
    );

    await makeToolsNode(specWith(tool))(state);

    expect(invoke).toHaveBeenCalledOnce();
  });

  it("does NOT short-circuit when the args differ (different args = a genuinely new call)", async () => {
    const invoke = vi.fn(async () => "fresh result");
    const tool: KernelTool = { name: "project_workflow", invoke };
    const state = stateWithCalls(
      [{ id: "call-2", name: "project_workflow", args: { path: "/other" } }],
      [receipt("project_workflow", { path: "/missing" }, false)],
    );

    await makeToolsNode(specWith(tool))(state);

    expect(invoke).toHaveBeenCalledOnce();
  });

  it("dedupes within one batch: the FIRST identical call runs and fails, the SECOND is short-circuited", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("ENOENT: no such file");
    });
    const tool: KernelTool = { name: "project_workflow", invoke };
    const args = { path: "/missing" };
    const state = stateWithCalls(
      [
        { id: "call-1", name: "project_workflow", args },
        { id: "call-2", name: "project_workflow", args },
      ],
      [],
    );

    const update = await makeToolsNode(specWith(tool))(state);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(update.step_receipts).toHaveLength(1);
    expect(update.scratch).toHaveLength(2);
    expect(String((update.scratch![1] as { content: unknown }).content)).toMatch(/already failed/i);
  });
});

describe("makeToolsNode — cross-step duplicate FAILED call guard (within one turn)", () => {
  it("short-circuits a call that already FAILED in an EARLIER completed step this turn (receipts on state.results)", async () => {
    const invoke = vi.fn(async () => "should not run");
    const tool: KernelTool = { name: "github_read", invoke };
    const args = { repo: "founderos", path: "missing.md" };
    // step_receipts is empty (fresh step) but a prior OK-collected step carries
    // the failing receipt for this exact call.
    const state = stateWithCalls(
      [{ id: "call-x", name: "github_read", args }],
      [],
      [{ tool_receipts: [receipt("github_read", args, false)] }],
    );

    const update = await makeToolsNode(specWith(tool))(state);

    expect(invoke).not.toHaveBeenCalled();
    expect(update.step_receipts).toEqual([]);
    expect(String((update.scratch![0] as { content: unknown }).content)).toMatch(/already failed/i);
  });

  it("does NOT short-circuit when the identical prior-step call SUCCEEDED", async () => {
    const invoke = vi.fn(async () => "fresh result");
    const tool: KernelTool = { name: "github_read", invoke };
    const args = { repo: "founderos", path: "README.md" };
    const state = stateWithCalls(
      [{ id: "call-x", name: "github_read", args }],
      [],
      [{ tool_receipts: [receipt("github_read", args, true)] }],
    );

    await makeToolsNode(specWith(tool))(state);

    expect(invoke).toHaveBeenCalledOnce();
  });
});
