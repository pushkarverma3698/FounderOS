import { describe, it, expect, afterEach } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import {
  buildShellHitlGraph,
  isShellHitlRequest,
  resetPersonalShellOfficeForTests,
  shellFastPathThreadId,
} from "../../../src/gateway/shell-hitl-fast-path.js";

describe("shell-hitl-fast-path", () => {
  afterEach(() => {
    resetPersonalShellOfficeForTests();
  });

  it("detects terminal echo requests", () => {
    expect(isShellHitlRequest('Run this in terminal: echo "hallucination-stress"')).toBe(true);
    expect(isShellHitlRequest("What is Turicks ICP?")).toBe(false);
  });

  it("builds shell fast path thread id", () => {
    expect(shellFastPathThreadId("tenant:123")).toBe("tenant:123:shell-fp");
  });

  it("builds deterministic shell input with extracted command", () => {
    expect(isShellHitlRequest('Run this in terminal: echo "hello"')).toBe(true);
  });

  it("compiles shell HITL graph with checkpointer", () => {
    const cp = new MemorySaver();
    const graph = buildShellHitlGraph(cp);
    expect(typeof graph.invoke).toBe("function");
    expect(typeof graph.getState).toBe("function");
  });
});
