/** recent_memories: read-only "what was decided / what broke lately" for a project (session brief). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const limit = vi.fn();
const chain = { from: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit };
chain.from.mockReturnValue(chain);
chain.where.mockReturnValue(chain);
chain.orderBy.mockReturnValue(chain);
const select = vi.fn(() => chain);
vi.mock("../../../src/db/client.js", () => ({ db: { select: (...a: unknown[]) => select(...(a as [])) } }));
vi.mock("../../../src/db/rag-search.js", () => ({ searchBrain: vi.fn() }));
vi.mock("../../../src/db/brain-ingest.js", () => ({ brainIngest: vi.fn() }));

const { callBrainTool, BRAIN_TOOLS } = await import("../../../src/mcp/brain-tools.js");
const { hubTools } = await import("../../../src/mcp/hub-server.js");
function row(over: object) {
  const base = {
    id: "abcdef12",
    memory_type: "decision",
    content: "Use pg-boss for the queue.\nBecause cron drifts.",
    created_at: new Date("2026-10-25T08:00:00Z"),
  };
  return Object.assign(base, over);
}
const textOf = (r: Awaited<ReturnType<typeof callBrainTool>>) => r!.content[0]!.text;
describe("recent_memories", () => {
  beforeEach(() => { limit.mockReset(); select.mockClear(); });
  it("is listed for the brain scope and the all scope", () => {
    expect(BRAIN_TOOLS.some((t) => t.name === "recent_memories")).toBe(true);
    expect(hubTools("brain").some((t) => t.name === "recent_memories")).toBe(true);
    expect(hubTools("all").some((t) => t.name === "recent_memories")).toBe(true);
  });
  it("prints one plain line per row: id8 kind date title(first line)", async () => {
    const bug = row({});
    bug.id = "99999999";
    bug.memory_type = "bug";
    bug.content = "x".repeat(300);
    limit.mockResolvedValue([row({}), bug]);
    const proj = "proj";
    const args = { project: proj };
    const text = textOf(await callBrainTool("recent_memories", args));
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("abcdef12 decision 2026-10-25 Use pg-boss for the queue.");
    expect(lines[1]!.startsWith("99999999 bug 2026-10-25 ")).toBe(true);
    expect(lines[1]!.split(" ").slice(3).join(" ")).toHaveLength(160);
  });
  it("clamps limit to 40 and defaults to 15", async () => {
    const proj = "p";
    const big = { project: proj, limit: 999 };
    const dflt = { project: proj };
    limit.mockResolvedValue([]);
    await callBrainTool("recent_memories", big);
    expect(limit).toHaveBeenLastCalledWith(40);
    await callBrainTool("recent_memories", dflt);
    expect(limit).toHaveBeenLastCalledWith(15);
  });
  it("says so when nothing is recent", async () => {
    const args = { project: "p", days: 3 };
    limit.mockResolvedValue([]);
    const r = await callBrainTool("recent_memories", args);
    expect(textOf(r)).toBe("No decisions or bugs for p in the last 3 days.");
  });
  it("requires project", async () => {
    const r = await callBrainTool("recent_memories", {});
    expect(r!.isError).toBe(true);
    expect(select).not.toHaveBeenCalled();
  });
});
