/**
 * Unit tests — a board that answers 404 sweep after sweep stops being asked.
 *
 * Adapted from the four cases in the unmerged `fix/jobhunt-pipeline-audit-fixes`
 * (skip at the threshold · reset on a success · count the skip but keep sweeping ·
 * a never-polled board has no failures), with the two things that branch got wrong
 * put right:
 *
 *   · its counters were a process-lifetime Map, so a deploy started every dead board
 *     over — here the streak is read from `board-health.json` (see the "restart"
 *     test, which throws the whole module graph away between sweeps);
 *   · it counted ANY failure and never asked a skipped board again — here only a 404
 *     counts (a 429 or a 5xx is a different failure), and a skipped board is asked
 *     once every seven days so a revived board comes back.
 *
 * Real `sweepBoards`, real adapters, real files in a temp dir, stubbed `fetch`, and
 * an injected clock. No network, no shared state with `/opt/founderos-data`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../../src/infra/logger.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/infra/logger.js")>()),
  childLogger: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const { sweepBoards } = await import("../../../src/tools/jobhunt/free-ats-source.js");
const { DEAD_BOARD_STREAK, DEAD_BOARD_REPROBE_MS, BOARD_HEALTH_FILE } = await import(
  "../../../src/tools/jobhunt/board-health.js"
);
import type { FreeBoard } from "../../../src/tools/jobhunt/free-boards.js";

const T0 = Date.parse("2026-09-29T12:00:00.000Z");
const HALF_HOUR = 30 * 60 * 1000;

function board(token: string, overrides: Partial<FreeBoard> = {}): FreeBoard {
  return { name: "Acme B.V.", ats: "greenhouse", token, markets: ["NL"], ...overrides };
}

const errorResponse = (status: number) => ({
  ok: false,
  status,
  headers: { get: () => null },
  json: async () => ({}),
  body: { cancel: async () => {} },
});
const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

/** Answer per token: 404 for `dead`, a 200 empty board for everyone else. */
function answers(byToken: Record<string, () => unknown>): void {
  mockFetch.mockImplementation(async (url: string) => {
    for (const [token, respond] of Object.entries(byToken)) {
      if (url.includes(`/boards/${token}/`)) return respond();
    }
    return okResponse({ jobs: [] });
  });
}
const fetchedTokens = (): string[] =>
  mockFetch.mock.calls.map(([url]) => /\/boards\/([^/]+)\//.exec(String(url))?.[1] ?? "?");

let root: string;
let clock: number;
const deps = () => ({ root, now: () => new Date(clock) });
const healthPath = () => join(root, BOARD_HEALTH_FILE);
const readHealth = async (): Promise<Record<string, { streak: number; last_probe_at: string }>> =>
  JSON.parse(await readFile(healthPath(), "utf8")) as Record<string, { streak: number; last_probe_at: string }>;
const seed = (entries: Record<string, { streak: number; lastProbe: number }>) =>
  writeFile(
    healthPath(),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(entries).map(([key, e]) => [
          key,
          {
            streak: e.streak,
            first_failed_at: new Date(e.lastProbe - 86_400_000).toISOString(),
            last_probe_at: new Date(e.lastProbe).toISOString(),
          },
        ]),
      ),
    ),
    "utf8",
  );

beforeEach(async () => {
  mockFetch.mockReset();
  warn.mockClear();
  root = await mkdtemp(join(tmpdir(), "dead-boards-"));
  clock = T0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("dead board pruning", () => {
  it(`skips a board after ${DEAD_BOARD_STREAK} consecutive 404s, without asking it`, async () => {
    await seed({ "greenhouse:dead": { streak: DEAD_BOARD_STREAK, lastProbe: T0 - HALF_HOUR } });

    const sweep = await sweepBoards([board("dead")], deps());

    expect(mockFetch).not.toHaveBeenCalled();
    expect(sweep.boardsPolled).toBe(0); // what was POLLED, not what is on file
    expect(sweep.skippedDead).toEqual(["greenhouse/dead"]);
    expect(sweep.failures).toEqual([]); // a skipped board is not a failure: that is the point
  });

  it("resets the streak when a board answers 200 after DEAD_BOARD_STREAK - 1 404s", async () => {
    await seed({ "greenhouse:recovering": { streak: DEAD_BOARD_STREAK - 1, lastProbe: T0 - HALF_HOUR } });
    answers({});

    const sweep = await sweepBoards([board("recovering")], deps());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sweep.boardsPolled).toBe(1);
    expect(sweep.skippedDead).toEqual([]);
    expect(await readHealth()).toEqual({}); // streak back to 0: the board no longer appears in the file
  });

  it("counts the skip in the result but keeps sweeping everything else", async () => {
    await seed({ "greenhouse:dead": { streak: DEAD_BOARD_STREAK, lastProbe: T0 - HALF_HOUR } });
    answers({
      good: () =>
        okResponse({
          jobs: [
            {
              id: 1,
              title: "Financial Analyst",
              absolute_url: "https://x.example/1",
              location: { name: "Amsterdam" },
              first_published: "2026-09-28T00:00:00Z",
            },
          ],
        }),
    });

    const sweep = await sweepBoards([board("good"), board("dead")], deps());

    expect(fetchedTokens()).toEqual(["good"]);
    expect(sweep.boardsPolled).toBe(1);
    expect(sweep.skippedDead).toEqual(["greenhouse/dead"]);
    expect(sweep.candidates.map((c) => c.title)).toEqual(["Financial Analyst"]);
  });

  it("treats a board that was never polled as having zero failures: its first 404 is a streak of 1", async () => {
    answers({ fresh: () => errorResponse(404) });

    const sweep = await sweepBoards([board("good"), board("fresh")], deps());

    expect(sweep.boardsPolled).toBe(2);
    expect(sweep.failures).toHaveLength(1);
    expect(sweep.failures[0]).toContain("greenhouse/fresh: HTTP 404");
    expect((await readHealth())["greenhouse:fresh"]?.streak).toBe(1);
  });

  it("ten sweeps of 404s, half an hour apart, and the eleventh does not ask", async () => {
    answers({ dead: () => errorResponse(404) });

    for (let sweepNo = 1; sweepNo <= DEAD_BOARD_STREAK; sweepNo++) {
      const sweep = await sweepBoards([board("good"), board("dead")], deps());
      expect(sweep.failures, `sweep ${sweepNo} still asks and reports it`).toHaveLength(1);
      clock += HALF_HOUR;
    }
    expect((await readHealth())["greenhouse:dead"]?.streak).toBe(DEAD_BOARD_STREAK);

    mockFetch.mockClear();
    const eleventh = await sweepBoards([board("good"), board("dead")], deps());
    expect(fetchedTokens()).toEqual(["good"]);
    expect(eleventh.skippedDead).toEqual(["greenhouse/dead"]);
    expect(eleventh.failures).toEqual([]);
  });

  it("survives a restart: the streak comes from the file, not from process memory", async () => {
    answers({ dead: () => errorResponse(404) });
    for (let sweepNo = 1; sweepNo <= DEAD_BOARD_STREAK; sweepNo++) {
      await sweepBoards([board("good"), board("dead")], deps());
      clock += HALF_HOUR;
    }

    // The whole module graph is thrown away: this is what a deploy does to the stale
    // branch's `defaultFailureCounters` Map.
    vi.resetModules();
    mockFetch.mockClear();
    const restarted = await import("../../../src/tools/jobhunt/free-ats-source.js");
    const sweep = await restarted.sweepBoards([board("good"), board("dead")], deps());

    expect(fetchedTokens()).toEqual(["good"]);
    expect(sweep.skippedDead).toEqual(["greenhouse/dead"]);
  });

  it("asks a skipped board again once DEAD_BOARD_REPROBE_MS has passed, and a revived board comes back", async () => {
    await seed({ "greenhouse:revived": { streak: DEAD_BOARD_STREAK + 2, lastProbe: T0 } });
    answers({});

    clock = T0 + DEAD_BOARD_REPROBE_MS - HALF_HOUR;
    const early = await sweepBoards([board("revived")], deps());
    expect(early.skippedDead).toEqual(["greenhouse/revived"]);
    expect(mockFetch).not.toHaveBeenCalled();

    clock = T0 + DEAD_BOARD_REPROBE_MS;
    const probe = await sweepBoards([board("revived")], deps());
    expect(fetchedTokens()).toEqual(["revived"]);
    expect(probe.skippedDead).toEqual([]);
    expect(await readHealth()).toEqual({});

    mockFetch.mockClear();
    clock += HALF_HOUR;
    const after = await sweepBoards([board("revived")], deps());
    expect(fetchedTokens()).toEqual(["revived"]); // back in the normal rotation
    expect(after.skippedDead).toEqual([]);
  });

  it("a board still dead at its re-probe stays skipped for another full week", async () => {
    await seed({ "greenhouse:dead": { streak: DEAD_BOARD_STREAK, lastProbe: T0 } });
    answers({ dead: () => errorResponse(404) });

    clock = T0 + DEAD_BOARD_REPROBE_MS;
    await sweepBoards([board("good"), board("dead")], deps());
    expect(fetchedTokens()).toContain("dead");
    const health = await readHealth();
    expect(health["greenhouse:dead"]?.streak).toBe(DEAD_BOARD_STREAK + 1);
    expect(health["greenhouse:dead"]?.last_probe_at).toBe(new Date(clock).toISOString());

    mockFetch.mockClear();
    clock += HALF_HOUR;
    await sweepBoards([board("good"), board("dead")], deps());
    expect(fetchedTokens()).toEqual(["good"]);

    mockFetch.mockClear();
    clock = T0 + 2 * DEAD_BOARD_REPROBE_MS;
    await sweepBoards([board("good"), board("dead")], deps());
    expect(fetchedTokens()).toContain("dead");
  });

  it("does not count a 429 or a 5xx: rate-limited and broken hosts are not dead boards", async () => {
    answers({ limited: () => errorResponse(429), down: () => errorResponse(503) });

    const sweep = await sweepBoards([board("good"), board("limited"), board("down")], deps());

    expect(sweep.failures.map((f) => f.split(": ")[1]).sort()).toEqual(["HTTP 429", "HTTP 503"]);
    // Neither failure left a mark, so neither can ever add up to a skip.
    await expect(readFile(healthPath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("a corrupt board-health.json never skips anything and never stops the sweep", async () => {
    await writeFile(healthPath(), "{ this is not json", "utf8");
    answers({});

    const sweep = await sweepBoards([board("a"), board("b")], deps());

    expect(fetchedTokens().sort()).toEqual(["a", "b"]);
    expect(sweep.boardsPolled).toBe(2);
    expect(sweep.skippedDead).toEqual([]);
    expect(warn.mock.calls.filter((c) => JSON.stringify(c).includes(root))).toHaveLength(1);
  });

  it("two sweeps overlapping in one process both count, and the file stays valid JSON", async () => {
    answers({ dead: () => errorResponse(404) });

    await Promise.all([
      sweepBoards([board("good"), board("dead")], deps()),
      sweepBoards([board("good"), board("dead")], deps()),
    ]);

    expect((await readHealth())["greenhouse:dead"]?.streak).toBe(2);
  });

  it("without a health store — a script, a one-off run — nothing is skipped and the record is not touched", async () => {
    // Even with a data root configured and a board already marked dead in it: only the
    // cron entrypoint (`runFreeSweep`) opts in, so a probe script run on the VPS cannot
    // read, skip by, or advance production state.
    await seed({ "greenhouse:dead": { streak: DEAD_BOARD_STREAK, lastProbe: T0 } });
    const before = await readFile(healthPath(), "utf8");
    answers({ dead: () => errorResponse(404) });
    vi.stubEnv("FOUNDEROS_DATA_ROOT", root);
    try {
      const sweep = await sweepBoards([board("dead")]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sweep.boardsPolled).toBe(1);
      expect(sweep.skippedDead).toEqual([]);
      expect(await readFile(healthPath(), "utf8")).toBe(before);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
