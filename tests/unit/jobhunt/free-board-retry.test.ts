/**
 * Unit tests — retrying a board that rate-limited us, and reporting the ones
 * that stayed broken.
 *
 * WHY THIS FILE EXISTS. Measured on prod 2026-08-21, from the Hetzner box: 36 of
 * 113 Recruitee boards failed EVERY sweep with HTTP 429, and lowering the
 * in-flight limit to 1 only moved it to 15 of 113 — a third of the Dutch
 * registry was unreachable on a permanent basis. Recruitee rate-limits the
 * CALLER, not the board, so the fix is to wait and ask again rather than to ask
 * more slowly. `scripts/jobhunt-import-sponsor-boards.ts` already proved the
 * pattern during the import (45 dead → 8).
 *
 * The second half pins the reporting: `recordQueryCost` stored only the first
 * THREE failure strings, and the three it happened to store were always the same
 * harmless Greenhouse 404s — so those 36 real failures were invisible to the
 * founder, which is the exact "a broken lane looks like a quiet market" failure
 * this lane is built to prevent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { fetchBoard, retryDelayMs, summariseFailures, BOARD_ATTEMPTS } = await import(
  "../../../src/tools/jobhunt/free-ats-source.js"
);
import type { FreeBoard } from "../../../src/tools/jobhunt/free-boards.js";

function board(overrides: Partial<FreeBoard> = {}): FreeBoard {
  return { name: "Acme B.V.", ats: "recruitee", token: "acme", markets: ["NL"], ...overrides };
}

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const errorResponse = (status: number) => ({
  ok: false,
  status,
  json: async () => ({}),
  body: { cancel: async () => {} },
});

/** No real waiting: the delays are asserted separately, on the pure function. */
const noSleep = { sleep: async () => {} };

beforeEach(() => {
  mockFetch.mockReset();
});

describe("fetchBoard — retrying a rate-limited board", () => {
  it("retries a 429 and returns the postings the second attempt served", async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(okResponse({ offers: [] }));

    const result = await fetchBoard(board(), noSleep);

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after a bounded number of attempts and names the status", async () => {
    mockFetch.mockResolvedValue(errorResponse(429));

    const result = await fetchBoard(board(), noSleep);

    expect(result.ok).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(BOARD_ATTEMPTS);
    if (!result.ok) expect(result.error).toContain("429");
  });

  it("retries a 503, because a host that is briefly down is not a dead board", async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(okResponse({ offers: [] }));

    await fetchBoard(board(), noSleep);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 404 — a rotated token 404s forever and retrying it is pure delay", async () => {
    mockFetch.mockResolvedValue(errorResponse(404));

    const result = await fetchBoard(board(), noSleep);

    expect(result.ok).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries a transport failure, which is what an aborted socket looks like", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(okResponse({ offers: [] }));

    const result = await fetchBoard(board(), noSleep);

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("fetchBoard — Workday, the only platform that pages", () => {
  const wdBoard = board({ ats: "workday", token: "acme/wd5/careers" });

  const page = (total: number, titles: readonly string[]) =>
    okResponse({
      total,
      jobPostings: titles.map((title, i) => ({
        title,
        externalPath: `/job/loc/${title}_${i}`,
        locationsText: "Amsterdam",
        postedOn: "Posted Today",
      })),
    });

  it("issues a POST with a JSON body, not a GET", async () => {
    mockFetch.mockResolvedValueOnce(page(1, ["Backend Engineer"]));

    await fetchBoard(wdBoard, noSleep);

    const [, init] = mockFetch.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ limit: 20, offset: 0 });
  });

  it("stops after one page when total fits inside it — no wasted requests", async () => {
    mockFetch.mockResolvedValueOnce(page(3, ["A", "B", "C"]));

    const result = await fetchBoard(wdBoard, noSleep);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.ok && result.candidates).toHaveLength(3);
  });

  it("pages until the reported total is reached, advancing the offset", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `Job ${i}`);
    mockFetch.mockResolvedValueOnce(page(25, twenty)).mockResolvedValueOnce(page(25, ["Job 20"]));

    const result = await fetchBoard(wdBoard, noSleep);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockFetch.mock.calls[1]![1].body)).toMatchObject({ offset: 20 });
    expect(result.ok && result.candidates).toHaveLength(21);
  });

  it("stops at maxPages even when the board claims far more, bounding one employer's cost", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `Job ${i}`);
    mockFetch.mockResolvedValue(page(4000, twenty));

    const result = await fetchBoard(wdBoard, noSleep);

    // 5 pages × 20 — the cap in adapters/workday.ts, not the 200 the board claims.
    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(result.ok && result.candidates).toHaveLength(100);
  });

  it("reports a dead tenant as a counted failure rather than throwing", async () => {
    mockFetch.mockResolvedValue(errorResponse(404));

    const result = await fetchBoard(wdBoard, noSleep);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("404");
  });

  it("fails the board, not the sweep, when its token is malformed", async () => {
    // A token that cannot address a tenant must surface as this board's failure —
    // never as an exception that takes the other 922 boards down with it.
    const result = await fetchBoard(board({ ats: "workday", token: "no-slashes" }), noSleep);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("tenant");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("retryDelayMs", () => {
  it("grows with each attempt, so a rate limiter sees the caller back off", () => {
    expect(retryDelayMs(2, 0)).toBeGreaterThan(retryDelayMs(1, 0));
    expect(retryDelayMs(3, 0)).toBeGreaterThan(retryDelayMs(2, 0));
  });

  it("stays inside the sweep's window — a full backoff cannot outlast the 30-minute tick", () => {
    // Every attempt of every board, worst case, must leave the sweep room to finish.
    const worstCase = [1, 2, 3, 4, 5].reduce((sum, n) => sum + retryDelayMs(n, 1), 0);
    expect(worstCase).toBeLessThan(60_000);
  });

  it("adds jitter, so 26 boards rate-limited together do not retry in lockstep", () => {
    expect(retryDelayMs(1, 1)).toBeGreaterThan(retryDelayMs(1, 0));
  });
});

describe("summariseFailures", () => {
  it("counts every failure, never just the first three", () => {
    const failures = [
      ...Array.from({ length: 36 }, (_, i) => `recruitee/board-${i}: HTTP 429`),
      "greenhouse/gone: HTTP 404",
    ];

    const summary = summariseFailures(failures);

    expect(summary).toContain("37");
    expect(summary).toContain("36");
    expect(summary).toContain("429");
  });

  it("groups by platform and reason so one loud pattern is readable at a glance", () => {
    const summary = summariseFailures([
      "recruitee/a: HTTP 429",
      "recruitee/b: HTTP 429",
      "greenhouse/c: HTTP 404",
    ]);

    expect(summary).toMatch(/recruitee[^\n]*429[^\n]*2/);
    expect(summary).toMatch(/greenhouse[^\n]*404[^\n]*1/);
  });

  it("is empty when nothing failed, so a healthy sweep records no error at all", () => {
    expect(summariseFailures([])).toBe("");
  });

  it("stays bounded — a total outage must not write a 623-line string to the ledger", () => {
    const everyBoardDead = Array.from(
      { length: 623 },
      (_, i) => `greenhouse/board-${i}: HTTP ${500 + (i % 5)}`,
    );

    expect(summariseFailures(everyBoardDead).length).toBeLessThan(1_000);
  });
});
