import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { sweepBoards, DEAD_BOARD_CONSECUTIVE_FAILURES } = await import(
  "../../../src/tools/jobhunt/free-ats-source.js"
);
import type { FreeBoard } from "../../../src/tools/jobhunt/free-boards.js";

function board(overrides: Partial<FreeBoard> = {}): FreeBoard {
  return {
    name: "Acme B.V.",
    ats: "greenhouse",
    token: "acme",
    markets: ["NL"],
    ...overrides,
  };
}

function errorResponse(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({}),
    body: { cancel: async () => {} },
  };
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("dead board pruning", () => {
  it(`skips a board after ${DEAD_BOARD_CONSECUTIVE_FAILURES} consecutive failures`, async () => {
    const testBoard = board({ token: "dead" });
    const counters = new Map<string, number>();
    counters.set("greenhouse:dead", DEAD_BOARD_CONSECUTIVE_FAILURES);

    const sweep = await sweepBoards([testBoard], counters);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(sweep.boardsPolled).toBe(0);
    expect(sweep.skippedDead).toEqual([
      "greenhouse/dead: disabled (10 consecutive failures)",
    ]);
    expect(sweep.failures).toEqual([]);
  });

  it("resets the counter when a board succeeds after 9 failures", async () => {
    const testBoard = board({ token: "recovering" });
    const counters = new Map<string, number>();
    counters.set("greenhouse:recovering", DEAD_BOARD_CONSECUTIVE_FAILURES - 1);

    mockFetch.mockResolvedValueOnce(okResponse({ jobs: [] }));

    const sweep = await sweepBoards([testBoard], counters);

    expect(mockFetch).toHaveBeenCalled();
    expect(sweep.boardsPolled).toBe(1);
    expect(sweep.skippedDead).toEqual([]);
    expect(counters.get("greenhouse:recovering")).toBe(0);
  });

  it("counts the skip in the returned result but continues sweeping the rest", async () => {
    const goodBoard = board({ token: "good" });
    const deadBoard = board({ token: "dead" });

    const counters = new Map<string, number>();
    counters.set("greenhouse:dead", DEAD_BOARD_CONSECUTIVE_FAILURES);

    mockFetch.mockResolvedValueOnce(okResponse({ jobs: [] }));

    const sweep = await sweepBoards([goodBoard, deadBoard], counters);

    // Only "good" is polled
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sweep.boardsPolled).toBe(1); // active boards only
    expect(sweep.skippedDead).toEqual([
      "greenhouse/dead: disabled (10 consecutive failures)",
    ]);
    expect(counters.get("greenhouse:good")).toBe(0);
  });

  it("treats a board that was never polled as having zero failures", async () => {
    const newBoard = board({ token: "new" });
    const counters = new Map<string, number>(); // Empty

    // Mock 404 failure so we can observe the counter going 0 -> 1
    // We need to provide headers object since free-ats-transport expects it on error
    const headers = new Headers();
    mockFetch.mockResolvedValueOnce({ 
      ok: false, 
      status: 404, 
      headers,
      body: { cancel: async () => {} }
    });

    const sweep = await sweepBoards([newBoard], counters);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sweep.boardsPolled).toBe(1);
    expect(counters.get("greenhouse:new")).toBe(1);
    expect(sweep.failures[0]).toContain("greenhouse/new: HTTP 404");
  });
});
