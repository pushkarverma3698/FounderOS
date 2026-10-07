/**
 * Write tool replies (AG-026): a write without a project still saves, and the reply says what it costs.
 */
import { describe, it, expect, vi } from "vitest";

const ingest = vi.fn(async () => ({ id: "id-1" }));
vi.mock("../../../src/db/brain-ingest.js", () => ({ brainIngest: ingest }));
vi.mock("../../../src/db/rag-search.js", () => ({ searchBrain: vi.fn() }));
vi.mock("../../../src/db/client.js", () => ({ db: {} }));

const { callBrainTool, BRAIN_TOOLS } = await import("../../../src/mcp/brain-tools.js");

describe("brain write replies", () => {
  it("warns when no project is given, but still saves", async () => {
    const res = await callBrainTool("save_decision", { decision: "d" });
    expect(res?.isError).toBeUndefined();
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(res?.content[0]?.text).toContain("Saved without a project tag: project-scoped searches will not find it. Pass project (founderos, oplify");
  });

  it("does not warn when a project is given", async () => {
    const res = await callBrainTool("save_bug", { bug: "b", project: "founderos" });
    expect(res?.content[0]?.text).not.toContain("Saved without a project tag");
  });

  it("write tools accept optional session_id and repo", () => {
    for (const name of ["remember", "save_decision", "save_bug"]) {
      const tool = BRAIN_TOOLS.find((t) => t.name === name) as { inputSchema: { properties: Record<string, unknown> } };
      expect(Object.keys(tool.inputSchema.properties)).toEqual(expect.arrayContaining(["session_id", "repo"]));
    }
  });
});
