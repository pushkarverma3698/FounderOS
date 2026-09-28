/**
 * turicks-brain MCP write tools → brainIngest options.
 *
 * 2026-09-28: `remember` had no `project` argument, so every general memory an
 * IDE agent saved landed with project = NULL and was invisible to any
 * project-scoped `search_memory`. These tests pin that all three write tools
 * carry the project through, and that a blank project is treated as absent.
 */
import { describe, it, expect } from "vitest";
import { writeToolIngestOptions } from "../../../src/mcp/brain-write-args.js";

describe("writeToolIngestOptions", () => {
  it("remember passes project and tags through", () => {
    const opts = writeToolIngestOptions("remember", { content: "x", tags: "a, b", project: "oplify" });
    expect(opts).toMatchObject({ memoryType: "note", content: "x", project: "oplify", source: "ide_mcp" });
    expect(opts?.metadata).toEqual({ tags: ["a", "b"] });
  });

  it("remember without project stays untagged (backward compatible)", () => {
    const opts = writeToolIngestOptions("remember", { content: "x" });
    expect(opts?.project).toBeUndefined();
    expect(opts?.metadata).toEqual({ tags: [] });
  });

  it("save_decision and save_bug keep their project, type and importance", () => {
    expect(writeToolIngestOptions("save_decision", { decision: "d", project: "founderos" })).toMatchObject({
      memoryType: "decision", content: "d", project: "founderos", importance: 0.9,
    });
    expect(writeToolIngestOptions("save_bug", { bug: "b", project: "founderos" })).toMatchObject({
      memoryType: "bug", content: "b", project: "founderos", importance: 0.8,
    });
  });

  it("treats a blank project as absent rather than storing an empty tag", () => {
    expect(writeToolIngestOptions("remember", { content: "x", project: "  " })?.project).toBeUndefined();
  });

  it("returns null for tools that do not write", () => {
    expect(writeToolIngestOptions("search_memory", { query: "q" })).toBeNull();
  });
});
