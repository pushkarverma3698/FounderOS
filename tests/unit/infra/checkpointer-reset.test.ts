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

const { clearThreadCheckpoints, sweepStaleCheckpoints } = await import(
  "../../../src/infra/checkpointer.js"
);

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

describe("sweepStaleCheckpoints (P0: TTL backstop on unbounded checkpoint growth)", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("selects stale threads by latest-checkpoint age, parameterized on maxAgeDays", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // SELECT stale threads → none
    await sweepStaleCheckpoints(30);

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toMatch(/FROM agents\.checkpoints/);
    expect(sql).toMatch(/GROUP BY thread_id/);
    expect(sql).toMatch(/HAVING MAX\(\(checkpoint->>'ts'\)::timestamptz\)/); // newest turn, not oldest
    expect(sql).toMatch(/NOW\(\) - \(\$1 \|\| ' days'\)::interval/);
    expect(params).toEqual(["30"]); // value bound, never interpolated
  });

  it("clears every stale thread and sums rows deleted across them", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ thread_id: "turicks:1" }, { thread_id: "turicks:2" }] }) // SELECT
      // clearThreadCheckpoints("turicks:1") → 3 DELETEs
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
      // clearThreadCheckpoints("turicks:2") → 3 DELETEs
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 3 });

    const result = await sweepStaleCheckpoints(7);
    expect(result).toEqual({ threads: 2, rows: 10 });

    // every DELETE after the SELECT is thread-scoped to one of the stale ids
    const deleteCalls = mockQuery.mock.calls.slice(1);
    expect(deleteCalls).toHaveLength(6);
    for (const [sql, params] of deleteCalls) {
      expect(sql).toContain("thread_id");
      expect((params as string[])[0]).toMatch(/^turicks:(1|2)$/);
    }
  });

  it("returns zeros and does NOT throw if the checkpoints table is missing", async () => {
    mockQuery.mockRejectedValueOnce(new Error('relation "agents.checkpoints" does not exist'));
    const result = await sweepStaleCheckpoints(30);
    expect(result).toEqual({ threads: 0, rows: 0 });
    expect(mockQuery).toHaveBeenCalledTimes(1); // bailed after the failed SELECT, no DELETEs
  });

  it("rejects a non-positive maxAgeDays (guards an accidental wipe-everything)", async () => {
    await expect(sweepStaleCheckpoints(0)).rejects.toThrow(/positive number/);
    await expect(sweepStaleCheckpoints(-5)).rejects.toThrow(/positive number/);
    expect(mockQuery).not.toHaveBeenCalled(); // never touches the DB on bad input
  });
});
