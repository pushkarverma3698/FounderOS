/**
 * #1377: Workday answered 429 to ~350 of ~390 boards per sweep. A stub Workday that 429s any
 * request arriving inside a window proves the fetch plan stays under the rate (fake timers, no network).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { sweepBoards } = await import("../../../src/tools/jobhunt/free-ats-source.js");
const { createRequestGate, attemptsFor, workdayGate } = await import("../../../src/tools/jobhunt/workday-pacing.js");
import { HttpStatusError } from "../../../src/tools/jobhunt/free-ats-transport.js";
import type { FreeBoard } from "../../../src/tools/jobhunt/free-boards.js";

const WINDOW_MS = 250; // stub limiter: two request starts closer than this earn a 429

function wdBoard(i: number): FreeBoard {
  return { name: `T${i}`, ats: "workday", token: `t${i}/wd5/site${i}`, markets: ["NL"] };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockFetch.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("workday pacing", () => {
  it("keeps Workday under the limiter's rate and finishes every board", async () => {
    let last = -Infinity;
    let rateLimited = 0;
    mockFetch.mockImplementation(async () => {
      const t = Date.now();
      const tooFast = t - last < WINDOW_MS;
      last = t;
      if (tooFast) {
        rateLimited++;
        return { ok: false, status: 429, json: async () => ({}), headers: new Headers(), body: { cancel: async () => {} } };
      }
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ total: 0, jobPostings: [] }) };
    });

    const boards = Array.from({ length: 40 }, (_, i) => wdBoard(i));
    const done = sweepBoards(boards); done.catch(() => {});
    await vi.runAllTimersAsync();
    const sweep = await done;

    expect(rateLimited).toBe(0);
    expect(sweep.failures).toEqual([]);
    expect(sweep.boardsPolled).toBe(40);
  });
});

describe("sweep budget and reset", () => {
  it("persistent 429s finish 390 boards inside 20 min, and the next sweep starts at the base gap", async () => {
    mockFetch.mockImplementation(async () => ({
      ok: false, status: 429, json: async () => ({}), headers: new Headers(), body: { cancel: async () => {} },
    }));
    const boards = Array.from({ length: 390 }, (_, i) => wdBoard(i));
    const t0 = Date.now();
    const first = sweepBoards(boards);
    await vi.runAllTimersAsync();
    const sweep = await first;
    expect(Date.now() - t0).toBeLessThan(20 * 60_000);
    expect(sweep.failures).toHaveLength(390);
    expect(sweep.failures.some((f) => f.includes("Workday pacing budget spent"))).toBe(true);

    let gapAtStart = -1;
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => {
      gapAtStart = workdayGate.gapMs();
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ total: 0, jobPostings: [] }) };
    });
    const second = sweepBoards([wdBoard(1000)]);
    await vi.runAllTimersAsync();
    expect((await second).failures).toEqual([]);
    expect(gapAtStart).toBe(300);
  });
});

describe("createRequestGate", () => {
  function gate() {
    return createRequestGate({ baseGapMs: 100, maxGapMs: 1000, maxCooldownMs: 5000 });
  }

  it("spaces request starts by the gap", async () => {
    const g = gate();
    const starts: number[] = [];
    const all = Promise.all([1, 2, 3].map(() => g.run(async () => void starts.push(Date.now()))));
    await vi.runAllTimersAsync();
    await all;
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(100);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(100);
  });

  it("a 429 with Retry-After holds every later request and widens the gap, once per burst", async () => {
    const g = gate();
    const t0 = Date.now();
    const p = g.run(async () => { throw new HttpStatusError(429, 3000); }).catch(() => "429");
    await vi.runAllTimersAsync();
    await p;
    expect(g.gapMs()).toBe(200);
    let startedAt = 0;
    const next = g.run(async () => void (startedAt = Date.now()));
    await vi.runAllTimersAsync();
    await next;
    expect(startedAt - t0).toBeGreaterThanOrEqual(3000);
  });

  it("gives Workday extra attempts and nobody else", () => {
    expect(attemptsFor("workday", 3)).toBeGreaterThan(3);
    expect(attemptsFor("greenhouse", 3)).toBe(3);
  });
});
