/**
 * Unit tests — retiring boards that fail permanently, not only boards that 404.
 *
 * Prod 2026-10-04/05: every free sweep of 3,195 boards had 5-6 failures that never went away
 * (bamboohr x3 answering HTML where JSON was expected, workday 422 and 403) because the dead-board
 * record (board-health.ts) counted HTTP 404 alone. These tests pin the widened rule:
 *   · permanent-looking answers (4xx other than 408/425/429, and a body that is not JSON) count;
 *   · transient ones (429, 5xx, timeouts) do not;
 *   · a platform failing en masse is an outage, not a graveyard;
 *   · the sweep says WHICH board failed and WHY it was retired, and the founder's ping names the count.
 *
 * Real sweepBoards, real adapters, a temp dir, stubbed fetch, injected clock. No network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { info } = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../../../src/infra/logger.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/infra/logger.js")>()),
  childLogger: () => ({ warn: vi.fn(), info, debug: vi.fn(), error: vi.fn() }),
}));

const { sweepBoards } = await import("../../../src/tools/jobhunt/free-ats-source.js");
const { DEAD_BOARD_STREAK, BOARD_HEALTH_FILE, nextBoardHealth } = await import(
  "../../../src/tools/jobhunt/board-health.js"
);
const { isPermanentFailure, failureReason, platformsInOutage, retiredBoards, retiredLine, OUTAGE_MIN_BOARDS } =
  await import("../../../src/tools/jobhunt/board-failure.js");
import type { BoardOutcome } from "../../../src/tools/jobhunt/board-health.js";
import type { FreeBoard } from "../../../src/tools/jobhunt/free-boards.js";

const T0 = Date.parse("2026-10-05T12:00:00.000Z");
const HALF_HOUR = 30 * 60 * 1000;

const ok = (ats: string, token: string): BoardOutcome => ({ board: { ats, token }, ok: true });
const fail = (ats: string, token: string, extra: { status?: number; kind?: "not-json" }): BoardOutcome => ({
  board: { ats, token },
  ok: false,
  ...extra,
});

describe("isPermanentFailure — which answers say the board is gone", () => {
  it.each([400, 401, 403, 404, 410, 422])("HTTP %i is permanent-looking", (status) => {
    expect(isPermanentFailure({ status })).toBe(true);
  });
  it.each([408, 425, 429, 500, 502, 503, 504])("HTTP %i is transient", (status) => {
    expect(isPermanentFailure({ status })).toBe(false);
  });
  it("a body that is not JSON is permanent-looking; a timeout or parse error with no status is not", () => {
    expect(isPermanentFailure({ kind: "not-json" })).toBe(true);
    expect(isPermanentFailure({})).toBe(false);
  });
  it("names the reason in words the founder can read", () => {
    expect(failureReason({ status: 403 })).toBe("HTTP 403");
    expect(failureReason({ kind: "not-json" })).toBe("HTML instead of JSON");
    expect(failureReason({ status: 503 })).toBeUndefined();
  });
});

describe("nextBoardHealth — the widened rule", () => {
  it("counts a 403, a 422 and a non-JSON body, and remembers the reason of each", () => {
    const next = nextBoardHealth(
      {},
      [
        ok("workday", "good"),
        fail("workday", "blocked", { status: 403 }),
        fail("workday", "rejected", { status: 422 }),
        ok("bamboohr", "good"),
        fail("bamboohr", "html", { kind: "not-json" }),
      ],
      new Date(T0),
    );
    expect(next["workday:blocked"]).toMatchObject({ streak: 1, reason: "HTTP 403" });
    expect(next["workday:rejected"]).toMatchObject({ streak: 1, reason: "HTTP 422" });
    expect(next["bamboohr:html"]).toMatchObject({ streak: 1, reason: "HTML instead of JSON" });
  });

  it("a 5xx or a timeout still never counts", () => {
    let health = {};
    for (let i = 0; i < 20; i++) {
      health = nextBoardHealth(
        health,
        [ok("lever", "good"), fail("lever", "down", { status: 503 }), fail("lever", "slow", {})],
        new Date(T0 + i * HALF_HOUR),
      );
    }
    expect(health).toEqual({});
  });

  it("treats a platform where most polled boards fail permanently as an outage and counts none of them", () => {
    const tokens = Array.from({ length: OUTAGE_MIN_BOARDS }, (_, i) => `b${i}`);
    const outcomes = [
      ok("bamboohr", "survivor"),
      ...tokens.map((t) => fail("bamboohr", t, { kind: "not-json" as const })),
    ];
    expect(platformsInOutage(outcomes).has("bamboohr")).toBe(true);
    expect(nextBoardHealth({}, outcomes, new Date(T0))).toEqual({});
  });

  it("a handful of dead boards on a big healthy platform is not an outage", () => {
    const healthy = Array.from({ length: 40 }, (_, i) => ok("greenhouse", `g${i}`));
    const outcomes = [...healthy, fail("greenhouse", "dead", { status: 404 })];
    expect(platformsInOutage(outcomes).size).toBe(0);
    expect(Object.keys(nextBoardHealth({}, outcomes, new Date(T0)))).toEqual(["greenhouse:dead"]);
  });
});

describe("retiredBoards / retiredLine — the founder-facing line", () => {
  const entry = (streak: number, reason?: string) => ({
    streak,
    first_failed_at: "2026-10-01T00:00:00.000Z",
    last_probe_at: "2026-10-05T00:00:00.000Z",
    ...(reason === undefined ? {} : { reason }),
  });
  const boards = [
    { ats: "greenhouse", token: "a" },
    { ats: "workday", token: "b" },
    { ats: "bamboohr", token: "c" },
    { ats: "bamboohr", token: "still-counting" },
    { ats: "lever", token: "fine" },
  ];

  it("lists registry boards at or past the threshold, with their reason; a legacy entry reads as HTTP 404", () => {
    const retired = retiredBoards(boards, {
      "greenhouse:a": entry(DEAD_BOARD_STREAK), // written before reasons existed: it was a 404
      "workday:b": entry(DEAD_BOARD_STREAK + 3, "HTTP 403"),
      "bamboohr:c": entry(DEAD_BOARD_STREAK, "HTML instead of JSON"),
      "bamboohr:still-counting": entry(DEAD_BOARD_STREAK - 1, "HTML instead of JSON"),
      "ashby:not-in-registry": entry(DEAD_BOARD_STREAK, "HTTP 404"),
    }, DEAD_BOARD_STREAK);
    expect(retired).toEqual([
      { board: "greenhouse/a", reason: "HTTP 404" },
      { board: "workday/b", reason: "HTTP 403" },
      { board: "bamboohr/c", reason: "HTML instead of JSON" },
    ]);
  });

  it("is one line: the count, then the reasons with counts, biggest first", () => {
    const line = retiredLine([
      { board: "a/1", reason: "HTTP 404" },
      { board: "a/2", reason: "HTTP 404" },
      { board: "b/1", reason: "HTML instead of JSON" },
    ]);
    expect(line).toBe("Retired 3 dead boards, no longer polled: HTTP 404 ×2, HTML instead of JSON ×1.");
    expect(line).not.toContain("\n");
  });

  it("is empty when nothing is retired, so a healthy ping stays as short as it was", () => {
    expect(retiredLine([])).toBe("");
    expect(retiredLine(undefined)).toBe("");
  });
});

// ── through the real sweep ────────────────────────────────────────────────────

let root: string;
let clock: number;
const deps = () => ({ root, now: () => new Date(clock) });
const board = (token: string): FreeBoard => ({ name: "Acme B.V.", ats: "greenhouse", token, markets: ["NL"] });
const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const httpError = (status: number) => ({
  ok: false,
  status,
  headers: { get: () => null },
  json: async () => ({}),
  body: { cancel: async () => {} },
});
const htmlResponse = () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => {
    throw new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON");
  },
});

function answers(byToken: Record<string, () => unknown>): void {
  mockFetch.mockImplementation(async (url: string) => {
    for (const [token, respond] of Object.entries(byToken)) if (url.includes(`/boards/${token}/`)) return respond();
    return okResponse({ jobs: [] });
  });
}

beforeEach(async () => {
  mockFetch.mockReset();
  info.mockClear();
  root = await mkdtemp(join(tmpdir(), "retire-boards-"));
  clock = T0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("sweepBoards — HTML where JSON was expected, over consecutive sweeps", () => {
  const registry = [board("good"), board("html-board"), board("walled")];

  it(`retires a board after ${DEAD_BOARD_STREAK} sweeps of HTML or 403, names it and why, then stops asking`, async () => {
    answers({ "html-board": htmlResponse, walled: () => httpError(403) });
    let sweep = await sweepBoards(registry, deps());
    expect(sweep.failures).toHaveLength(2);
    expect(sweep.retired).toEqual([]);

    for (let i = 1; i < DEAD_BOARD_STREAK; i++) {
      clock += HALF_HOUR;
      sweep = await sweepBoards(registry, deps());
    }
    expect(sweep.retired).toEqual([
      { board: "greenhouse/html-board", reason: "HTML instead of JSON" },
      { board: "greenhouse/walled", reason: "HTTP 403" },
    ]);

    mockFetch.mockClear();
    clock += HALF_HOUR;
    const after = await sweepBoards(registry, deps());
    expect(after.boardsPolled).toBe(1);
    expect(after.failures).toEqual([]);
    expect(after.skippedDead).toEqual(["greenhouse/html-board", "greenhouse/walled"]);
    expect(after.retired).toHaveLength(2);
  });

  it("a single success resets the streak: nine bad sweeps, one good one, and the board is not retired", async () => {
    answers({ "html-board": htmlResponse });
    for (let i = 0; i < DEAD_BOARD_STREAK - 1; i++) {
      await sweepBoards(registry, deps());
      clock += HALF_HOUR;
    }
    answers({});
    await sweepBoards(registry, deps());
    clock += HALF_HOUR;
    answers({ "html-board": htmlResponse });
    const sweep = await sweepBoards(registry, deps());
    expect(sweep.retired).toEqual([]);
    expect(JSON.parse(await readFile(join(root, BOARD_HEALTH_FILE), "utf8"))).toMatchObject({
      "greenhouse:html-board": { streak: 1 },
    });
  });

  it("5xx and timeouts are failures in the sweep but are never retired, however long they last", async () => {
    answers({
      "html-board": () => httpError(503),
      walled: () => {
        throw new Error("aborted");
      },
    });
    let sweep = await sweepBoards(registry, deps());
    for (let i = 0; i < DEAD_BOARD_STREAK + 5; i++) {
      clock += HALF_HOUR;
      sweep = await sweepBoards(registry, deps());
    }
    expect(sweep.retired).toEqual([]);
    expect(sweep.boardsPolled).toBe(3);
  });

  it("the sweep log carries every failed board with its reason, and the retired ids", async () => {
    answers({ "html-board": htmlResponse, walled: () => httpError(403) });
    for (let i = 0; i < DEAD_BOARD_STREAK; i++) {
      await sweepBoards(registry, deps());
      clock += HALF_HOUR;
    }
    const complete = info.mock.calls.filter((c) => c[1] === "Free board sweep complete");
    const first = complete[0]![0] as Record<string, unknown>;
    expect(first["failedBoards"]).toEqual([
      { board: "greenhouse/html-board", reason: "HTML instead of JSON" },
      { board: "greenhouse/walled", reason: "HTTP 403" },
    ]);
    const last = complete.at(-1)![0] as Record<string, unknown>;
    expect(last["retired"]).toBe(2);
    expect(last["retiredBoards"]).toEqual(["greenhouse/html-board", "greenhouse/walled"]);
    expect(last["newlyRetired"]).toEqual(["greenhouse/html-board", "greenhouse/walled"]);
  });
});
