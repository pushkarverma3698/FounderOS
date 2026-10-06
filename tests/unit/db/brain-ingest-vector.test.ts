/**
 * brainIngest must hand drizzle's `vector` column a number[].
 *
 * 2026-09-28: it passed the pre-formatted string `[a,b,c]` (cast `as any`).
 * drizzle's vector mapper serializes a string as JSON, so Postgres received
 * `"[a,b,c]"` (quoted) and pgvector rejected it: "invalid input syntax for type
 * vector". Every turicks-brain MCP write (remember / save_decision / save_bug)
 * failed in production, for every IDE.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const captured: { values?: Record<string, unknown>; set?: Record<string, unknown> } = {};
let existing: Array<{ id: string; content: string }> = [];

vi.mock("../../../src/lib/embed.js", () => ({ embedText: vi.fn(async () => [0.25, -0.5, 1]) }));
vi.mock("../../../src/db/client.js", () => {
  const chain = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => existing }) }) }),
    insert: () => ({ values: (v: Record<string, unknown>) => { captured.values = v; return { returning: async () => [{ id: "new-id" }] }; } }),
    update: () => ({ set: (v: Record<string, unknown>) => { captured.set = v; return { where: async () => undefined }; } }),
  };
  return { db: chain };
});

const { brainIngest } = await import("../../../src/db/brain-ingest.js");

describe("brainIngest provenance", () => {
  beforeEach(() => { captured.values = undefined; captured.set = undefined; existing = []; });

  it("merges provenance into metadata and keeps existing keys", async () => {
    const provenance = { origin: "agent" as const, client: "claude-code", machine: "mac", occurred_at: "2026-10-06T10:00:00.000Z", visibility: "all" as const };
    await brainIngest({ memoryType: "decision", content: "d", metadata: { tags: ["a"] }, provenance });
    expect(captured.values?.["metadata"]).toEqual({ tags: ["a"], ...provenance });
  });

  it("without provenance, metadata is unchanged", async () => {
    await brainIngest({ memoryType: "note", content: "n" });
    expect(captured.values?.["metadata"]).toEqual({});
  });
});

describe("brainIngest vector parameter", () => {
  beforeEach(() => { captured.values = undefined; captured.set = undefined; existing = []; });

  it("inserts the embedding as a number[], not a pre-formatted string", async () => {
    await brainIngest({ memoryType: "note", content: "new fact", project: "founderos" });
    expect(captured.values?.["embedding"]).toEqual([0.25, -0.5, 1]);
    expect(captured.values?.["project"]).toBe("founderos");
  });

  it("updates the embedding as a number[] when content changed", async () => {
    existing = [{ id: "old-id", content: "older text" }];
    await brainIngest({ memoryType: "note", content: "changed fact" });
    expect(captured.set?.["embedding"]).toEqual([0.25, -0.5, 1]);
  });
});
