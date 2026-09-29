/**
 * Unit tests for Tool Dispatch Validation Layer with Jev AI rules (src/tools/index.ts).
 */
import { describe, it, expect } from "vitest";
import { executeToolWithValidation, validateToolDispatch, type UnifiedTool } from "../../../src/tools/index.js";

describe("Tool Dispatch Validation Layer — Jev AI Rules", () => {
  const sampleTool: UnifiedTool = {
    name: "sample_tool",
    description: "Sample tool for testing",
    async execute(args) {
      return { success: true, data: args };
    },
  };

  it("validates tool call args using Jev AI rules before dispatch", () => {
    const res = validateToolDispatch(sampleTool, { query: "valid" });
    expect(res.valid).toBe(true);
  });

  it("executes valid tool call successfully", async () => {
    const res = await executeToolWithValidation(sampleTool, { query: "valid" });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ query: "valid" });
  });

  it("blocks tool dispatch when validation fails", async () => {
    const badArgs = JSON.parse('{"__proto__": {"malicious": true}}');
    const res = await executeToolWithValidation(sampleTool, badArgs);
    expect(res.success).toBe(false);
    expect(res.error).toBe("Forbidden parameter in tool arguments");
  });
});
