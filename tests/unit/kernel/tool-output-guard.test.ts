/**
 * Ironclad — tool-output guard unit tests (token protection).
 * clampToolOutput bounds every tool result the model re-reads;
 * pruneScratchForModel bounds a whole step's replayed scratch.
 * Receipts always keep the FULL-payload digest (worker.ts integration).
 */

import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage, ToolMessage, isToolMessage } from "@langchain/core/messages";
import {
  clampToolOutput,
  pruneScratchForModel,
  TOOL_OUTPUT_MAX_CHARS,
  TOOL_OUTPUT_TRUNCATED_MARKER,
  SCRATCH_KEEP_RECENT_TOOL_RESULTS,
  digestToolResult,
} from "../../../src/kernel/index.js";
import { isFailureResult } from "../../../src/kernel/worker.js";

describe("clampToolOutput", () => {
  it("passes in-budget results through byte-identical", () => {
    const small = JSON.stringify({ success: true, data: "ok" });
    expect(clampToolOutput(small)).toBe(small);
  });

  it("bounds a massive payload, keeps head + tail, and embeds the full-payload digest", () => {
    const huge = `{"rows":[${'"x",'.repeat(60_000)}"end-of-payload"]}`;
    expect(huge.length).toBeGreaterThan(200_000);

    const clamped = clampToolOutput(huge);
    // Bounded: cap + marker line overhead, never the raw 200k+.
    expect(clamped.length).toBeLessThan(TOOL_OUTPUT_MAX_CHARS + 400);
    expect(clamped).toContain(TOOL_OUTPUT_TRUNCATED_MARKER);
    expect(clamped.startsWith(huge.slice(0, 100))).toBe(true); // head preserved
    expect(clamped.endsWith(huge.slice(-50))).toBe(true); // tail preserved
    expect(clamped).toContain(digestToolResult(huge).slice(0, 12)); // cross-checkable vs receipt
    expect(clamped).toContain("do NOT re-call the tool");
  });

  it("preserves the failure marker head so isFailureResult still classifies clamped failures", () => {
    const failure = `❌ scrape_site failed: upstream 500 ${"x".repeat(30_000)}`;
    const clamped = clampToolOutput(failure);
    expect(isFailureResult(clamped)).toBe(true);
  });

  it("is idempotent for already-clamped output", () => {
    const once = clampToolOutput("y".repeat(50_000));
    expect(clampToolOutput(once)).toBe(once);
  });
});

describe("pruneScratchForModel", () => {
  const tool = (content: string, id: string) => new ToolMessage({ content, tool_call_id: id, name: "t" });

  it("returns the scratch untouched when under budget", () => {
    const scratch = [new HumanMessage("envelope"), new AIMessage("done")];
    expect(pruneScratchForModel(scratch)).toBe(scratch);
  });

  it("collapses the OLDEST tool results first and never the newest ones", () => {
    const big = "z".repeat(20_000);
    const scratch = [
      new HumanMessage("envelope"),
      new AIMessage("call 1"),
      tool(big, "c1"),
      new AIMessage("call 2"),
      tool(big, "c2"),
      new AIMessage("call 3"),
      tool(big, "c3"),
      tool(big, "c4"),
    ];
    const pruned = pruneScratchForModel(scratch, 45_000);
    const tools = pruned.filter((m) => isToolMessage(m));
    // Oldest collapsed to a stub carrying size + digest…
    expect(String(tools[0]!.content)).toContain("pruned to save context");
    expect(String(tools[0]!.content)).toContain(digestToolResult(big).slice(0, 12));
    // …newest SCRATCH_KEEP_RECENT_TOOL_RESULTS stay verbatim.
    const kept = tools.slice(-SCRATCH_KEEP_RECENT_TOOL_RESULTS);
    for (const k of kept) expect(String(k.content)).toBe(big);
    // AI messages (tool_calls pairing) untouched.
    expect(pruned.filter((m) => m instanceof AIMessage)).toHaveLength(3);
  });

  it("marks pruned FAILED results as FAILED so the model does not repeat them", () => {
    const failed = `❌ t threw: boom ${"x".repeat(60_000)}`;
    const scratch = [tool(failed, "c1"), tool("k".repeat(30_000), "c2"), tool("k".repeat(30_000), "c3")];
    const pruned = pruneScratchForModel(scratch, 40_000);
    expect(String(pruned[0]!.content)).toContain("outcome=FAILED");
  });

  it("never mutates the checkpointed originals", () => {
    const big = tool("q".repeat(80_000), "c1");
    const scratch = [big, tool("r".repeat(10_000), "c2"), tool("r".repeat(10_000), "c3")];
    pruneScratchForModel(scratch, 30_000);
    expect(String(big.content)).toHaveLength(80_000);
  });
});
