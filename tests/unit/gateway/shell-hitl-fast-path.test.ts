import { describe, it, expect, afterEach } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import {
  buildPersonalShellOffice,
  buildShellHitlInput,
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
    const msgs = buildShellHitlInput('Run this in terminal: echo "hello"');
    expect(String(msgs[0]?.content)).toContain('echo "hello"');
    expect(String(msgs[1]?.content)).toContain("personal department");
  });

  it("compiles personal shell office with checkpointer", () => {
    const cp = new MemorySaver();
    const graph = buildPersonalShellOffice(cp);
    expect(typeof graph.invoke).toBe("function");
    expect(typeof graph.getState).toBe("function");
  });
});
