/**
 * Phase C — context tools unit tests
 *
 * These tests verify that:
 * - read_context returns a sensible empty-state message when no data is stored
 * - update_context merges and persists data
 *
 * search_knowledge has its own dedicated suite (knowledge.test.ts) since it
 * moved to the Turicks Brain vector store — it is no longer a DB-query tool.
 *
 * All tests mock the DB queries to avoid needing a live Postgres instance.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DB queries before importing tools
const mockGetFounderContext = vi.fn(async () => ({}));
const mockUpsertFounderContext = vi.fn(async () => {});

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    getFounderContext: mockGetFounderContext,
    upsertFounderContext: mockUpsertFounderContext,
  };
});

const { readContext, updateContext } = await import("../../../src/tools/context.js");

describe("readContext tool", () => {
  beforeEach(() => {
    mockGetFounderContext.mockResolvedValue({});
  });

  it("returns a prompt to set context when empty", async () => {
    const result = await readContext.invoke({});
    expect(result).toContain("No business context stored yet");
  });

  it("formats stored context as bullet points", async () => {
    mockGetFounderContext.mockResolvedValue({
      active_clients: ["Acme Corp", "Beta Ltd"],
      current_priorities: ["Close Acme deal"],
      last_updated: "2026-06-01T00:00:00.000Z",
    });
    const result = await readContext.invoke({});
    expect(result).toContain("active clients: Acme Corp, Beta Ltd");
    expect(result).toContain("current priorities: Close Acme deal");
    expect(result).toContain("Last updated: 2026-06-01");
  });
});

describe("updateContext tool", () => {
  beforeEach(() => {
    mockGetFounderContext.mockResolvedValue({});
    mockUpsertFounderContext.mockResolvedValue(undefined);
  });

  it("calls upsertFounderContext with provided updates", async () => {
    await updateContext.invoke({ updates: { active_clients: ["TestCo"] } });
    expect(mockUpsertFounderContext).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ active_clients: ["TestCo"] }),
    );
  });

  it("returns a confirmation message listing updated keys", async () => {
    const result = await updateContext.invoke({
      updates: { active_clients: ["TestCo"], current_priorities: ["Ship Phase C"] },
    });
    expect(result).toContain("Context updated");
    expect(result).toContain("active_clients");
  });
});
