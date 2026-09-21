import { describe, test, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../../src/tools/registry/registry.js";
import type { ToolDefinition } from "../../../src/tools/registry/types.js";

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  const validTool: ToolDefinition = {
    id: "test_tool",
    name: "test_tool",
    description: "A test tool",
    layer: "founderos",
    transport: "internal",
    inputSchema: { type: "object", properties: {} },
    sideEffect: "read",
    approval: "none",
    enabled: true,
    capabilities: ["test_cap"],
  };

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  test("register and lookup", () => {
    registry.register(validTool);
    expect(registry.getTool("test_tool")).toEqual(validTool);
    expect(registry.getToolById("test_tool")).toEqual(validTool);
  });

  test("duplicate registration throws", () => {
    registry.register(validTool);
    expect(() => registry.register(validTool)).toThrow(/already registered/);
  });

  test("list returns all tools", () => {
    registry.register(validTool);
    expect(registry.listTools()).toHaveLength(1);
    expect(registry.listTools()[0]).toEqual(validTool);
  });

  test("filter by layer", () => {
    registry.register(validTool);
    const otherTool: ToolDefinition = { ...validTool, id: "other", name: "other", layer: "runtime" };
    registry.register(otherTool);

    const runtimeTools = registry.getToolsByLayer("runtime");
    expect(runtimeTools).toHaveLength(1);
    expect(runtimeTools[0]?.name).toBe("other");
  });

  test("filter by capability", () => {
    registry.register(validTool);
    expect(registry.getToolsByCapability("test_cap")).toHaveLength(1);
    expect(registry.getToolsByCapability("nonexistent")).toHaveLength(0);
  });

  test("schema metadata is exposed", () => {
    registry.register(validTool);
    expect(registry.getToolSchema("test_tool")).toEqual(validTool.inputSchema);
  });

  test("disabled tools can be filtered out", () => {
    registry.register(validTool);
    registry.register({ ...validTool, id: "disabled_tool", name: "disabled_tool", enabled: false });

    expect(registry.listTools()).toHaveLength(2);
    expect(registry.getEnabledTools()).toHaveLength(1);
    expect(registry.getEnabledTools()[0]?.name).toBe("test_tool");
  });
});
