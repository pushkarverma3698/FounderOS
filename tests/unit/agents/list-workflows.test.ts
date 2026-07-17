/**
 * list_workflows admin tool — read-only view of the saved-workflow catalog.
 * The DB is mocked; we assert the founder-facing formatting (most-run first,
 * run counts, S3 presence) and the empty-state message.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTopWorkflows = vi.fn();

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, topWorkflows: mockTopWorkflows };
});

const { listWorkflows } = await import("../../../src/agents/agent-tools/workflows.js");

async function invoke(args: Record<string, unknown> = {}): Promise<string> {
  // LangChain tools accept the raw arg object via .invoke.
  return (await listWorkflows.invoke(args as never)) as string;
}

describe("list_workflows tool", () => {
  beforeEach(() => mockTopWorkflows.mockReset());

  it("returns the empty-state message when nothing is catalogued", async () => {
    mockTopWorkflows.mockResolvedValue([]);
    const out = await invoke();
    expect(out).toContain("No workflows catalogued yet");
  });

  it("lists workflows most-run first with counts and S3 presence", async () => {
    mockTopWorkflows.mockResolvedValue([
      { slug: "weekly-svg-report", tool: "vps_run", run_count: 5, last_used_at: new Date("2026-07-18T01:04:01Z"), s3_keys: ["agent-runs/r1/x.svg"] },
      { slug: "refactor-auth", tool: "claude_code", run_count: 2, last_used_at: new Date("2026-07-17T09:00:00Z"), s3_keys: [] },
    ]);
    const out = await invoke({ limit: 10 });
    expect(out).toContain("1. weekly-svg-report — vps_run · 5× run · last 2026-07-18 01:04:01 UTC · 1 S3 artifact(s)");
    expect(out).toContain("2. refactor-auth — claude_code · 2× run · last 2026-07-17 09:00:00 UTC · no S3 artifacts");
  });

  it("clamps the limit into [1, 50]", async () => {
    mockTopWorkflows.mockResolvedValue([]);
    await invoke({ limit: 999 });
    expect(mockTopWorkflows).toHaveBeenCalledWith(expect.any(String), 50);
    await invoke({ limit: 0 });
    expect(mockTopWorkflows).toHaveBeenCalledWith(expect.any(String), 1);
  });
});
