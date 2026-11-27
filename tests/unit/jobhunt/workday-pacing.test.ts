/**
 * #1377: Workday answered 429 to ~350 of ~390 boards per sweep. A stub Workday that 429s any
 * request arriving inside a window proves the fetch plan stays under the rate (fake timers, no network).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { sweepBoards } = await import("../../../src/tools/jobhunt/free-ats-source.js");
const { createRequestGate, attemptsFor, resetWorkdayRotation } = await import("../../../src/tools/jobhunt/workday-pacing.js");
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

describe("#1387 cross-sweep rotation and backoff", () => {
  const T_MS = 60 * 60_000; // stub limiter: 429 while >= N starts landed in the last hour
  const N = 100;
  const SLOT_MS = 30 * 60_000;
  const reply429 = () => ({ ok: false, status: 429, json: async () => ({}), headers: new Headers(), body: { cancel: async () => {} } });
  const reply200 = () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ total: 0, jobPostings: [] }) });

  it("a simulated day of 48 sweeps fetches every board, never overruns the slot, and fails < 40 boards a sweep", async () => {
    const starts: number[] = [];
    const fetched = new Set<string>();
    mockFetch.mockImplementation(async (url: string) => {
      const t = Date.now();
      while (starts.length && starts[0]! <= t - T_MS) starts.shift();
      const hot = starts.length >= N;
      starts.push(t); // a refused request still keeps the limiter hot
      if (hot) return reply429();
      fetched.add(String(url));
      return reply200();
    });
    resetWorkdayRotation();
    const boards = Array.from({ length: 390 }, (_, i) => wdBoard(i));
    let worst = 0;
    let slowest = 0;
    for (let s = 0; s < 48; s++) {
      const t0 = Date.now();
      const run = sweepBoards(boards);
      await vi.runAllTimersAsync();
      const sweep = await run;
      slowest = Math.max(slowest, Date.now() - t0);
      worst = Math.max(worst, sweep.failures.length);
      vi.setSystemTime(t0 + SLOT_MS);
    }
    expect(worst).toBeLessThan(40);
    expect(slowest).toBeLessThan(SLOT_MS);
    expect(fetched.size).toBe(390);
  });

  it("the first 429 ends Workday for the sweep: no retries, the rest are deferred not failed, and the next sweep backs off", async () => {
    resetWorkdayRotation();
    mockFetch.mockImplementation(async () => reply429());
    const boards = Array.from({ length: 200 }, (_, i) => wdBoard(i));
    const first = sweepBoards(boards);
    await vi.runAllTimersAsync();
    const sweep = await first;
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(4); // one 429 per in-flight worker, no retries
    expect(sweep.failures.length).toBeLessThanOrEqual(4);
    expect(sweep.failures.join()).not.toContain("budget spent");

    mockFetch.mockClear();
    vi.setSystemTime(Date.now() + 30 * 60_000); // next slot, still inside the 1 h backoff
    const second = sweepBoards(boards);
    await vi.runAllTimersAsync();
    expect((await second).failures).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
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

  it("a 429 trips the gate: later requests fail fast, and reset() reopens it at the base gap", async () => {
    const g = gate();
    const p = g.run(async () => { throw new HttpStatusError(429, 3000); }).catch(() => "429");
    await vi.runAllTimersAsync();
    await p;
    expect(g.tripped()).toBe(true);
    const fn = vi.fn(async () => 1);
    await expect(g.run(fn)).rejects.toThrow(/paused/);
    expect(fn).not.toHaveBeenCalled();
    g.reset();
    expect(g.tripped()).toBe(false);
    expect(g.gapMs()).toBe(100);
  });

  it("gives Workday extra attempts and nobody else", () => {
    expect(attemptsFor("workday", 3)).toBeGreaterThan(3);
    expect(attemptsFor("greenhouse", 3)).toBe(3);
  });
});
