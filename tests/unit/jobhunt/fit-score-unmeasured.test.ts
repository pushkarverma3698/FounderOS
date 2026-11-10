/**
 * Unit tests — an unmeasurable posting is stored as "not measured", never as 0.0.
 *
 * `fit_score` is matched / asked, where `asked` is the number of dictionary skill
 * terms found in the posting body. A body that is empty, thin, or names no
 * dictionary term has asked = 0, and persistFitScores wrote ratio 0 as a real
 * score. Prod audit 2026-11-03..10: roles with a 0.0 score still passed and
 * dragged every group's average down, with nothing to say the 0.0 meant "unread".
 * Ranking is unchanged (rankRows already sorts an unmeasured row last).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRecord = vi.fn(async (_entries: ReadonlyArray<{ id: string; score: number | null; evidence: string }>) => {});
vi.mock("../../../src/db/job-queries.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  recordBriefRanks: vi.fn(async () => {}),
  recordFitScores: mockRecord,
}));

const { persistFitScores } = await import("../../../src/tools/jobhunt/brief-persist.js");
const { overlapScore } = await import("../../../src/tools/jobhunt/overlap.js");

const CV = "Backend engineer. Python, PostgreSQL, Docker, TypeScript, Node.js, Kubernetes.";

beforeEach(() => vi.clearAllMocks());

describe("persistFitScores", () => {
  it("stores null (not measured) for an empty body", async () => {
    const overlap = overlapScore("", CV);
    await persistFitScores([{ row: { id: "r1" } as never, overlap }]);
    const [entry] = mockRecord.mock.calls[0]![0];
    expect(entry!.score).toBeNull();
    expect(entry!.evidence).toMatch(/not measured/i);
  });

  it("stores null for a body that names no dictionary skill", async () => {
    const overlap = overlapScore("We are a friendly team that values kindness and curiosity.", CV);
    expect(overlap.asked).toBe(0);
    await persistFitScores([{ row: { id: "r2" } as never, overlap }]);
    expect(mockRecord.mock.calls[0]![0][0]!.score).toBeNull();
  });

  it("still stores a real 0 when the posting asks for skills the CV lacks entirely", async () => {
    const overlap = overlapScore("You will use Rust, Elixir and Terraform daily.", "Teacher of history.");
    expect(overlap.asked).toBeGreaterThan(0);
    expect(overlap.matched.length).toBe(0);
    await persistFitScores([{ row: { id: "r3" } as never, overlap }]);
    expect(mockRecord.mock.calls[0]![0][0]!.score).toBe(0);
  });

  it("stores the ratio for a measured posting", async () => {
    const overlap = overlapScore("Python and PostgreSQL, plus Rust.", CV);
    await persistFitScores([{ row: { id: "r4" } as never, overlap }]);
    expect(mockRecord.mock.calls[0]![0][0]!.score).toBeCloseTo(overlap.ratio, 5);
    expect(overlap.ratio).toBeGreaterThan(0);
  });
});
