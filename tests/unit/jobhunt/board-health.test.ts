/**
 * Unit tests — the persisted dead-board record (`board-health.ts`).
 *
 * WHY THIS FILE EXISTS. Measured on prod 2026-09-29: 670 `free-boards` sweeps in
 * seven days, and every sampled run's `error` said "30–33 board(s) failed:
 * greenhouse HTTP 404 ×16–18; ashby HTTP 404 ×3–4; lever HTTP 404 ×3…" — the same
 * dead boards asked again every thirty minutes, forever. The unmerged
 * `fix/jobhunt-pipeline-audit-fixes` counted those failures in a process-lifetime
 * Map, so a deploy reset the count, and it never asked a skipped board again.
 * These tests pin the persisted version: the streak lives in
 * `${FOUNDEROS_DATA_ROOT}/board-health.json`, and a skipped board is re-probed.
 *
 * Every test takes an injected clock and its own temp data root. Nothing here
 * reads the real `/opt/founderos-data`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const { warn, fsCalls } = vi.hoisted(() => ({
  warn: vi.fn(),
  fsCalls: { written: [] as string[], renamed: [] as Array<[string, string]> },
}));
// Observed, not replaced: every call still reaches the real fs. This is how the tests can say
// WHERE a save wrote, which a reader racing the writer can only ever catch by luck.
vi.mock("node:fs/promises", async (orig) => {
  const actual = await orig<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: (async (path: string, ...rest: unknown[]) => {
      fsCalls.written.push(String(path));
      return (actual.writeFile as (...args: unknown[]) => Promise<void>)(path, ...rest);
    }) as typeof actual.writeFile,
    rename: async (from: string, to: string) => {
      fsCalls.renamed.push([String(from), String(to)]);
      return actual.rename(from, to);
    },
  };
});
vi.mock("../../../src/infra/logger.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/infra/logger.js")>()),
  childLogger: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { dataRoot } from "../../../src/core/data-root.js";
import {
  BOARD_HEALTH_FILE,
  DEAD_BOARD_REPROBE_MS,
  DEAD_BOARD_STREAK,
  appendSkippedDead,
  boardHealthDeps,
  boardHealthPath,
  isSkipped,
  loadBoardHealth,
  nextBoardHealth,
  recordBoardOutcomes,
  saveBoardHealth,
  splitBySkip,
  splitSweepError,
  type BoardHealth,
  type BoardHealthEntry,
  type BoardOutcome,
} from "../../../src/tools/jobhunt/board-health.js";

const T0 = new Date("2026-09-29T12:00:00.000Z");
const later = (ms: number): Date => new Date(T0.getTime() + ms);
const HALF_HOUR = 30 * 60 * 1000;

const ok = (ats: string, token: string): BoardOutcome => ({ board: { ats, token }, ok: true });
const notFound = (ats: string, token: string): BoardOutcome => ({
  board: { ats, token },
  ok: false,
  status: 404,
});
const failed = (ats: string, token: string, status?: number): BoardOutcome => ({
  board: { ats, token },
  ok: false,
  ...(status === undefined ? {} : { status }),
});
const entry = (streak: number, lastProbe: Date, first = "2026-09-20T00:00:00.000Z"): BoardHealthEntry => ({
  streak,
  first_failed_at: first,
  last_probe_at: lastProbe.toISOString(),
});

let root: string;
beforeEach(async () => {
  warn.mockClear();
  root = await mkdtemp(join(tmpdir(), "board-health-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Warnings that name THIS test's temp root, so a leaked one from a sibling test cannot count. */
const warningsFor = (needle: string): unknown[][] =>
  warn.mock.calls.filter((call) => JSON.stringify(call).includes(needle));

describe("nextBoardHealth — what a sweep's answers do to each board's streak", () => {
  it("counts a 404, remembers when the streak began, and moves last_probe_at each time", () => {
    // A healthy neighbour on the same platform is what makes the 404 credible: see the
    // "nothing answered" test below.
    const first = nextBoardHealth({}, [ok("greenhouse", "good"), notFound("greenhouse", "dead")], T0);
    expect(first).toEqual({
      "greenhouse:dead": { streak: 1, first_failed_at: T0.toISOString(), last_probe_at: T0.toISOString() },
    });

    const second = nextBoardHealth(first, [ok("greenhouse", "good"), notFound("greenhouse", "dead")], later(HALF_HOUR));
    expect(second["greenhouse:dead"]).toEqual({
      streak: 2,
      first_failed_at: T0.toISOString(),
      last_probe_at: later(HALF_HOUR).toISOString(),
    });
  });

  it("a board that was never recorded starts from zero, not from someone else's count", () => {
    const next = nextBoardHealth({ "lever:other": entry(7, T0) }, [ok("lever", "good"), notFound("lever", "new")], T0);
    expect(next["lever:new"]?.streak).toBe(1);
    expect(next["lever:other"]?.streak).toBe(7);
  });

  it("a 200 resets the streak — the entry goes, so the file only ever lists boards that are failing", () => {
    const before: BoardHealth = { "greenhouse:flaky": entry(DEAD_BOARD_STREAK - 1, T0) };
    const after = nextBoardHealth(before, [ok("greenhouse", "flaky")], later(HALF_HOUR));
    expect(after).toEqual({});
  });

  it("a 404, then a 200, then a 404 starts a NEW streak at 1 (consecutive means consecutive)", () => {
    let health: BoardHealth = {};
    health = nextBoardHealth(health, [ok("ashby", "good"), notFound("ashby", "flip")], T0);
    health = nextBoardHealth(health, [ok("ashby", "good"), ok("ashby", "flip")], later(HALF_HOUR));
    health = nextBoardHealth(health, [ok("ashby", "good"), notFound("ashby", "flip")], later(2 * HALF_HOUR));
    expect(health["ashby:flip"]?.streak).toBe(1);
    expect(health["ashby:flip"]?.first_failed_at).toBe(later(2 * HALF_HOUR).toISOString());
  });

  it("a 429, a 5xx or a transport error never counts — twenty rate-limited sweeps leave the board alive", () => {
    let health: BoardHealth = {};
    for (let sweep = 0; sweep < 20; sweep++) {
      health = nextBoardHealth(
        health,
        [
          ok("recruitee", "good"),
          failed("recruitee", "limited", 429),
          failed("recruitee", "down", 503),
          failed("recruitee", "broken", 500),
          failed("recruitee", "timeout"), // no status: an abort, a socket reset or a parse error
        ],
        later(sweep * HALF_HOUR),
      );
    }
    expect(health).toEqual({});
  });

  it("a 429 in the middle of a streak neither advances nor resets it, and leaves the re-probe clock alone", () => {
    const before: BoardHealth = { "greenhouse:x": entry(5, T0) };
    const after = nextBoardHealth(
      before,
      [ok("greenhouse", "good"), failed("greenhouse", "x", 429)],
      later(HALF_HOUR),
    );
    expect(after["greenhouse:x"]).toEqual(before["greenhouse:x"]);
  });

  it("ignores 404s from a platform where NOTHING answered — that is a broken adapter, not a graveyard", () => {
    // If Ashby moved its API, every ashby board 404s at once. Counting those would mark the
    // whole platform dead in five hours and silence it for a week.
    const after = nextBoardHealth(
      {},
      [notFound("ashby", "a"), notFound("ashby", "b"), ok("lever", "fine"), notFound("lever", "gone")],
      T0,
    );
    expect(Object.keys(after)).toEqual(["lever:gone"]);
  });

  it("never mutates its input", () => {
    const before: BoardHealth = Object.freeze({ "greenhouse:x": Object.freeze(entry(3, T0)) });
    expect(() => nextBoardHealth(before, [ok("greenhouse", "g"), notFound("greenhouse", "x")], later(HALF_HOUR))).not.toThrow();
    expect(before["greenhouse:x"]?.streak).toBe(3);
  });
});

describe("splitBySkip — which boards this sweep asks", () => {
  const board = (token: string) => ({ ats: "greenhouse", token });

  it("asks a board with no history", () => {
    const { poll, skipped } = splitBySkip([board("new")], {}, T0);
    expect(poll).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it("asks a board one 404 short of the threshold, and skips it at DEAD_BOARD_STREAK", () => {
    const health = (streak: number): BoardHealth => ({ "greenhouse:b": entry(streak, T0) });
    expect(splitBySkip([board("b")], health(DEAD_BOARD_STREAK - 1), later(HALF_HOUR)).poll).toHaveLength(1);
    expect(splitBySkip([board("b")], health(DEAD_BOARD_STREAK), later(HALF_HOUR)).skipped).toHaveLength(1);
    expect(splitBySkip([board("b")], health(DEAD_BOARD_STREAK + 5), later(HALF_HOUR)).skipped).toHaveLength(1);
  });

  it("re-probes a skipped board exactly DEAD_BOARD_REPROBE_MS after its last probe — not a moment earlier", () => {
    const health: BoardHealth = { "greenhouse:b": entry(DEAD_BOARD_STREAK, T0) };
    expect(splitBySkip([board("b")], health, later(DEAD_BOARD_REPROBE_MS - 1)).skipped).toHaveLength(1);
    expect(splitBySkip([board("b")], health, later(DEAD_BOARD_REPROBE_MS)).poll).toHaveLength(1);
    expect(splitBySkip([board("b")], health, later(DEAD_BOARD_REPROBE_MS + 3 * 86_400_000)).poll).toHaveLength(1);
  });

  it("asks a board whose last_probe_at is unreadable or in the future — the direction that cannot hide a live board", () => {
    expect(isSkipped({ streak: 99, first_failed_at: "x", last_probe_at: "not a date" }, T0)).toBe(false);
    expect(isSkipped(entry(99, later(3 * 86_400_000)), T0)).toBe(false);
  });

  it("keeps the caller's own board objects, so extra fields survive the split", () => {
    const rich = { ats: "greenhouse", token: "b", name: "Acme B.V.", markets: ["NL"] };
    const { poll } = splitBySkip([rich], {}, T0);
    expect(poll[0]).toBe(rich);
  });
});

describe("loadBoardHealth — a bad file must never skip anything, and never crash a sweep", () => {
  it("a missing file starts empty and warns once", async () => {
    expect(await loadBoardHealth(root)).toEqual({});
    expect(await loadBoardHealth(root)).toEqual({});
    expect(warningsFor(root)).toHaveLength(1);
  });

  it("a corrupt file starts empty and warns once, however many sweeps read it", async () => {
    await writeFile(boardHealthPath(root), '{"greenhouse:x": {"streak": 12, ', "utf8"); // cut off mid-write
    expect(await loadBoardHealth(root)).toEqual({});
    expect(await loadBoardHealth(root)).toEqual({});
    expect(await loadBoardHealth(root)).toEqual({});
    const warnings = warningsFor(root);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain(BOARD_HEALTH_FILE);
  });

  it("a file of the wrong shape is corrupt too — a bad entry is never read as 'skip'", async () => {
    for (const text of ["[]", "null", '{"greenhouse:x": {"streak": "twelve"}}', '{"greenhouse:x": 12}']) {
      await writeFile(boardHealthPath(root), text, "utf8");
      expect(await loadBoardHealth(root), text).toEqual({});
    }
  });

  it("a path that cannot be read as a file (a directory) starts empty instead of throwing", async () => {
    await mkdir(boardHealthPath(root));
    await expect(loadBoardHealth(root)).resolves.toEqual({});
    expect(warningsFor(root)).toHaveLength(1);
  });

  it("reads back exactly what was saved", async () => {
    const saved: BoardHealth = { "greenhouse:x": entry(12, T0), "lever:y": entry(3, T0) };
    await saveBoardHealth(root, saved);
    expect(await loadBoardHealth(root)).toEqual(saved);
    expect(warningsFor(root)).toHaveLength(0);
  });
});

describe("saveBoardHealth — atomic, so a reader never sees a torn file", () => {
  it("writes readable JSON with sorted keys and leaves no temp file behind", async () => {
    await saveBoardHealth(root, { "lever:b": entry(2, T0), "ashby:a": entry(1, T0) });
    const text = await readFile(boardHealthPath(root), "utf8");
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["ashby:a", "lever:b"]);
    expect(await readdir(root)).toEqual([BOARD_HEALTH_FILE]);
  });

  it("publishes only by rename: the target itself is never written to", async () => {
    fsCalls.written.length = 0;
    fsCalls.renamed.length = 0;
    const target = boardHealthPath(root);

    await saveBoardHealth(root, { "lever:b": entry(2, T0) });

    expect(fsCalls.written).toHaveLength(1);
    expect(fsCalls.written).not.toContain(target); // a reader could catch a write-in-place half done
    const [from, to] = fsCalls.renamed[0]!;
    expect(to).toBe(target);
    expect(from).toBe(fsCalls.written[0]); // what was written is exactly what was renamed
    expect(dirname(from)).toBe(dirname(target)); // same directory, so the rename cannot cross a filesystem
    expect(from.endsWith(".tmp")).toBe(true);
  });

  it("gives every write its own temp file, so two writers can never interleave into one", async () => {
    fsCalls.written.length = 0;
    await Promise.all([saveBoardHealth(root, {}), saveBoardHealth(root, {}), saveBoardHealth(root, {})]);
    expect(new Set(fsCalls.written).size).toBe(3);
  });

  it("creates the data root when it does not exist yet", async () => {
    const nested = join(root, "not", "there", "yet");
    await saveBoardHealth(nested, { "lever:b": entry(1, T0) });
    expect(await loadBoardHealth(nested)).toEqual({ "lever:b": entry(1, T0) });
  });

  it("two processes writing at once: every read parses, and the last writer wins (a lost increment is acceptable)", async () => {
    // `saveBoardHealth` is called UNLOCKED here on purpose: the in-process lock does not span
    // processes, so this is what a second process looks like from the file's point of view.
    // ~44 KB per write, so a non-atomic writer (open-truncate-write) is caught mid-file.
    const states = Array.from({ length: 40 }, (_, n): BoardHealth =>
      Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`greenhouse:w${n}-${i}`, entry(n + 1, T0)])),
    );

    let writing = true;
    let reads = 0;
    const reader = async (): Promise<void> => {
      while (writing) {
        let text: string;
        try {
          text = await readFile(boardHealthPath(root), "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // before the first rename
          throw err;
        }
        JSON.parse(text); // a torn file throws here and fails the test
        reads += 1;
      }
    };
    const readers = [reader(), reader(), reader(), reader()];

    await Promise.all(states.map((state) => saveBoardHealth(root, state)));
    writing = false;
    await Promise.all(readers);

    expect(reads).toBeGreaterThan(0);
    const final = await loadBoardHealth(root);
    expect(states.some((state) => isDeepStrictEqual(state, final))).toBe(true); // one writer's whole state, not a blend
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("recordBoardOutcomes — the sweep's one read-modify-write", () => {
  const deps = (now: Date = T0) => ({ root, now: () => now });

  it("persists the streak, so a restart (a fresh deps object over the same root) keeps counting", async () => {
    await recordBoardOutcomes([ok("greenhouse", "g"), notFound("greenhouse", "dead")], deps());
    await recordBoardOutcomes([ok("greenhouse", "g"), notFound("greenhouse", "dead")], deps(later(HALF_HOUR)));
    expect((await loadBoardHealth(root))["greenhouse:dead"]?.streak).toBe(2);
  });

  it("two overlapping sweeps in one process both land — the read-modify-write is serialised", async () => {
    await Promise.all([
      recordBoardOutcomes([ok("greenhouse", "g"), notFound("greenhouse", "a")], deps()),
      recordBoardOutcomes([ok("greenhouse", "g"), notFound("greenhouse", "b")], deps()),
      recordBoardOutcomes([ok("greenhouse", "g"), notFound("greenhouse", "a")], deps()),
    ]);
    const health = await loadBoardHealth(root);
    expect(health["greenhouse:a"]?.streak).toBe(2);
    expect(health["greenhouse:b"]?.streak).toBe(1);
  });

  it("a write that fails is logged once with the path and the fix, and never throws into the sweep", async () => {
    await mkdir(boardHealthPath(root)); // a directory where the file should be: rename() cannot replace it
    await expect(
      recordBoardOutcomes([ok("greenhouse", "g"), notFound("greenhouse", "dead")], deps()),
    ).resolves.toBeUndefined();
    await recordBoardOutcomes([ok("greenhouse", "g"), notFound("greenhouse", "dead")], deps(later(HALF_HOUR)));

    const saveWarnings = warningsFor(root).filter((call) => JSON.stringify(call).includes("persist"));
    expect(saveWarnings).toHaveLength(1);
    expect(JSON.stringify(saveWarnings[0])).toContain("FOUNDEROS_DATA_ROOT");
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("names a board in the log the moment it is marked dead — once, not on every later 404", async () => {
    await saveBoardHealth(root, { "greenhouse:dead": entry(DEAD_BOARD_STREAK - 1, T0) });
    warn.mockClear();

    await recordBoardOutcomes([ok("greenhouse", "g"), notFound("greenhouse", "dead")], deps(later(HALF_HOUR)));
    const marked = warn.mock.calls.filter((call) => JSON.stringify(call).includes("greenhouse:dead"));
    expect(marked).toHaveLength(1);
    expect(JSON.stringify(marked[0])).toMatch(/dead/i);

    warn.mockClear();
    await recordBoardOutcomes([ok("greenhouse", "g"), notFound("greenhouse", "dead")], deps(later(2 * HALF_HOUR)));
    expect(warn.mock.calls.filter((call) => JSON.stringify(call).includes("greenhouse:dead"))).toHaveLength(0);
  });

  it("does nothing to the file when the sweep changed nothing", async () => {
    await recordBoardOutcomes([ok("greenhouse", "g")], deps());
    expect(await readdir(root)).toEqual([]);
  });
});

describe("the sweep summary line", () => {
  const FAILURES = "3 board(s) failed: greenhouse HTTP 404 ×2; ashby HTTP 500 ×1";

  it("says how many dead boards were skipped, instead of listing them as failures", () => {
    expect(appendSkippedDead("", 27)).toBe("skipped 27 dead boards");
  });

  it("keeps the existing 'N board(s) failed: …' text intact and appends the skip count as its own clause", () => {
    const line = appendSkippedDead(FAILURES, 27);
    expect(line.startsWith(FAILURES)).toBe(true);
    expect(line).toBe(`${FAILURES} | skipped 27 dead boards`);
  });

  it("adds nothing when nothing was skipped", () => {
    expect(appendSkippedDead(FAILURES, 0)).toBe(FAILURES);
    expect(appendSkippedDead("", 0)).toBe("");
  });

  it("splitSweepError reads both clauses back, for whoever consumes job_ingest_runs.error", () => {
    expect(splitSweepError(appendSkippedDead(FAILURES, 27))).toEqual({ failures: FAILURES, skippedDead: 27 });
    expect(splitSweepError("skipped 30 dead boards")).toEqual({ failures: "", skippedDead: 30 });
    expect(splitSweepError(FAILURES)).toEqual({ failures: FAILURES, skippedDead: 0 });
    expect(splitSweepError(null)).toEqual({ failures: "", skippedDead: 0 });
  });
});

describe("where the record lives", () => {
  it("defaults to /opt/founderos-data, the same root apply-profile.ts uses", () => {
    expect(dataRoot({})).toBe("/opt/founderos-data");
    expect(boardHealthDeps({}).root).toBe("/opt/founderos-data");
    expect(boardHealthPath("/opt/founderos-data")).toBe("/opt/founderos-data/board-health.json");
  });

  it("honours FOUNDEROS_DATA_ROOT, trimmed, and treats a blank value as unset", () => {
    expect(dataRoot({ FOUNDEROS_DATA_ROOT: "  /srv/data  " })).toBe("/srv/data");
    expect(dataRoot({ FOUNDEROS_DATA_ROOT: "   " })).toBe("/opt/founderos-data");
  });

  it("the production clock is the real one", () => {
    const before = Date.now();
    const now = boardHealthDeps({}).now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
