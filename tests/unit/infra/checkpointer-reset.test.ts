/**
 * Unit tests for clearThreadCheckpoints — wipes a thread's LangGraph history.
 *
 * Why this exists: thread IDs are stable per chat (turicks:{chatId}), so the
 * Postgres checkpointer accumulates the ENTIRE conversation forever. Old
 * (possibly wrong) assistant turns get replayed on every message, poisoning
 * behaviour and inflating token cost. /reset clears that thread's checkpoints.
 *
 * The pg pool is mocked — no live Postgres needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("../../../src/db/client.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    getPgPool: () => ({ query: mockQuery }),
  };
});

const { clearThreadCheckpoints } = await import("../../../src/infra/checkpointer.js");

describe("clearThreadCheckpoints", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("deletes from all three checkpoint tables for the given thread", async () => {
    mockQuery.mockResolvedValue({ rowCount: 5 });
    await clearThreadCheckpoints("turicks:123");

    const tablesTouched = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(tablesTouched.some((q) => q.includes("checkpoints"))).toBe(true);
    expect(tablesTouched.some((q) => q.includes("checkpoint_blobs"))).toBe(true);
    expect(tablesTouched.some((q) => q.includes("checkpoint_writes"))).toBe(true);
    // every delete must be scoped to the thread_id parameter
    for (const call of mockQuery.mock.calls) {
      expect(call[0]).toContain("thread_id");
      expect(call[1]).toEqual(["turicks:123"]);
    }
  });

  it("returns the total number of rows deleted across tables", async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 10 })
      .mockResolvedValueOnce({ rowCount: 20 })
      .mockResolvedValueOnce({ rowCount: 7 });
    const total = await clearThreadCheckpoints("turicks:123");
    expect(total).toBe(37);
  });

  it("tolerates a null rowCount (counts it as 0)", async () => {
    mockQuery.mockResolvedValue({ rowCount: null });
    const total = await clearThreadCheckpoints("turicks:123");
    expect(total).toBe(0);
  });

  it("does not throw if a table is missing — skips it and continues", async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockRejectedValueOnce(new Error('relation "checkpoint_blobs" does not exist'))
      .mockResolvedValueOnce({ rowCount: 4 });
    const total = await clearThreadCheckpoints("turicks:123");
    expect(total).toBe(7);
  });
});
