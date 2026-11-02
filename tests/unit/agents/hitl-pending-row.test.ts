/**
 * hitlGate's pending-row rule (2026-10-03 lost-dispatch bug).
 *
 * A pending hitl_approvals row for the thread normally means "this is the resume
 * re-execution of the same gate" — skip the insert. But a pending row written for
 * a DIFFERENT payload belongs to an older, abandoned card: it must be expired and
 * replaced, otherwise the new card shares the old row's nonce and one tap
 * resolves a request the founder never approved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInterrupt = vi.fn();
vi.mock("@langchain/langgraph", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, interrupt: mockInterrupt };
});

const createInterrupt = vi.fn(async (..._a: unknown[]) => "new-id");
const getPendingInterrupt = vi.fn(async (..._a: unknown[]): Promise<unknown> => null);
const resolveInterrupt = vi.fn(async (..._a: unknown[]) => true);
vi.mock("../../../src/db/queries.js", () => ({
  createInterrupt: (...a: unknown[]) => createInterrupt(...a),
  getPendingInterrupt: (...a: unknown[]) => getPendingInterrupt(...a),
  resolveInterrupt: (...a: unknown[]) => resolveInterrupt(...a),
}));

const { hitlGate } = await import("../../../src/infra/hitl.js");

const A = { action: "dispatch_antigravity", title: "Dispatch A?", summary: "a", preview: "a", args: { n: 1 } };
const B = { action: "dispatch_antigravity", title: "Dispatch B?", summary: "b", preview: "b", args: { n: 2 } };
const config = { configurable: { thread_id: "turicks:1" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockInterrupt.mockReturnValue("approved");
  getPendingInterrupt.mockResolvedValue(null);
});

describe("hitlGate pending-row rule", () => {
  it("no pending row → creates one", async () => {
    await hitlGate(A, config);
    expect(createInterrupt).toHaveBeenCalledTimes(1);
  });

  it("pending row for the SAME payload (resume re-execution) → no second insert", async () => {
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "old", callback_data: JSON.stringify(A) });
    await hitlGate(A, config);
    expect(createInterrupt).not.toHaveBeenCalled();
    expect(resolveInterrupt).not.toHaveBeenCalled();
  });

  it("pending row for a DIFFERENT payload → old row expired, new row created", async () => {
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "old", callback_data: JSON.stringify(A) });
    await hitlGate(B, config);
    expect(resolveInterrupt).toHaveBeenCalledWith("old", "expired");
    expect(createInterrupt).toHaveBeenCalledTimes(1);
    expect((createInterrupt.mock.calls[0]![0] as { callback_data: string }).callback_data).toBe(JSON.stringify(B));
  });

  // Issue #1055: the gateway resolves the row BEFORE it resumes, so the replay finds no
  // pending row. It must not insert an orphan (prod 67c50034 → 553e5b7c, 64 of 149 rows).
  it("resume replay of the card the tap just resolved → no insert", async () => {
    const resumed = { configurable: { thread_id: "turicks:1", hitl_resumed: JSON.stringify(A) } };
    await hitlGate(A, resumed);
    expect(createInterrupt).not.toHaveBeenCalled();
  });

  it("a different gated call inside the resumed run → still gets its own row", async () => {
    const resumed = { configurable: { thread_id: "turicks:1", hitl_resumed: JSON.stringify(A) } };
    await hitlGate(B, resumed);
    expect(createInterrupt).toHaveBeenCalledTimes(1);
  });
});
