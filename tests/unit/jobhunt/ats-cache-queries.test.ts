/**
 * Unit tests — ATS board cache persistence (Postgres mocked).
 *
 * These ran against a LIVE database until 2026-09-08, which made them pass on a
 * laptop with `turicks-postgres` up and fail in CI, where there is none. That is
 * not a flaky test, it is an inverted one: green locally, red on the only run
 * that gates a merge. `pnpm test` is the $0 deterministic loop — it mocks.
 *
 * The behaviour that actually matters here is the FAIL-OPEN, and the live test
 * could not reach it at all. Every function in this module swallows a database
 * error and returns a benign value so a Postgres outage cannot take down a
 * sweep. That is the right call and it is also the dangerous one: it means a
 * missing migration degrades the persistent cache into a silent no-op. These
 * tests pin both halves — the happy path writes what it claims, and the failure
 * path returns the benign value rather than throwing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** A drizzle chain link that is both awaitable and further chainable. */
function thenable<T>(value: T, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject),
  };
}

interface Recorded {
  readonly op: string;
  readonly arg?: unknown;
}

let rows: Record<string, unknown>[] = [];
let recorded: Recorded[] = [];
let dbThrows = false;

function fakeDb() {
  const rec = (op: string, arg?: unknown) => recorded.push({ op, arg });
  return {
    select: () => ({
      from: () => thenable(rows, { where: () => thenable(rows, { limit: () => thenable(rows) }) }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        rec("insert.values", v);
        return {
          onConflictDoUpdate: (c: { set: unknown }) => {
            rec("insert.onConflictDoUpdate", c.set);
            return Promise.resolve();
          },
        };
      },
    }),
    update: () => ({
      set: (v: unknown) => {
        rec("update.set", v);
        return { where: () => Promise.resolve() };
      },
    }),
    delete: () => {
      rec("delete");
      return Promise.resolve();
    },
  };
}

const mockGetDb = vi.fn();

vi.mock("../../../src/db/client.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, getDb: () => mockGetDb() };
});

const {
  loadBoardCacheEntries,
  loadBoardCacheEntry,
  saveBoardCacheEntry,
  touchBoardCacheEntry,
  recordBoardCacheFailure,
  clearBoardCache,
} = await import("../../../src/db/ats-cache-queries.js");

const TEST_URL = "https://boards-api.greenhouse.io/v1/boards/acme-test/jobs";

beforeEach(() => {
  rows = [];
  recorded = [];
  dbThrows = false;
  mockGetDb.mockImplementation(() => {
    if (dbThrows) throw new Error("ECONNREFUSED");
    return fakeDb();
  });
});

describe("ats-cache-queries — happy path", () => {
  it("loads every stored entry", async () => {
    rows = [{ url: TEST_URL, etag: '"e1"' }];
    expect(await loadBoardCacheEntries()).toEqual(rows);
  });

  it("loads a single entry, and null when the url is unknown", async () => {
    rows = [{ url: TEST_URL, etag: '"e1"', status: 200 }];
    expect((await loadBoardCacheEntry(TEST_URL))?.url).toBe(TEST_URL);

    rows = [];
    expect(await loadBoardCacheEntry(TEST_URL)).toBeNull();
  });

  it("upserts both validators and the payload hash on a 200", async () => {
    await saveBoardCacheEntry({
      url: TEST_URL,
      etag: '"test-etag-123"',
      lastModified: "Wed, 21 Oct 2026 07:28:00 GMT",
      payloadHash: "abc123hash",
      payload: JSON.stringify({ jobs: [{ id: 1 }] }),
      status: 200,
    });

    const values = recorded.find((r) => r.op === "insert.values")?.arg as Record<string, unknown>;
    expect(values).toMatchObject({
      url: TEST_URL,
      etag: '"test-etag-123"',
      last_modified: "Wed, 21 Oct 2026 07:28:00 GMT",
      payload_hash: "abc123hash",
      status: 200,
      failure_count: 0,
    });
  });

  it("clears the failure count on a 304 touch without writing the payload", async () => {
    await touchBoardCacheEntry(TEST_URL, 304);

    const set = recorded.find((r) => r.op === "update.set")?.arg as Record<string, unknown>;
    expect(set).toMatchObject({ status: 304, failure_count: 0 });
    // A touch means "unchanged" — overwriting the payload here would drop the
    // cached body the 304 is telling us is still valid.
    expect(set).not.toHaveProperty("payload");
  });

  it("increments rather than overwrites the failure count", async () => {
    await recordBoardCacheFailure(TEST_URL, 429);

    const set = recorded.find((r) => r.op === "insert.onConflictDoUpdate")?.arg as Record<string, unknown>;
    expect(set["status"]).toBe(429);
    // A literal 1 here would make a board that fails forever look like it failed
    // once, and the backoff would never widen.
    expect(String(set["failure_count"])).not.toBe("1");
  });

  it("wipes the table on clear", async () => {
    await clearBoardCache();
    expect(recorded.some((r) => r.op === "delete")).toBe(true);
  });
});

describe("ats-cache-queries — Postgres unreachable", () => {
  // The sweep polls ~1,300 boards. A database outage must cost a cold cache,
  // never the sweep. Nothing below may throw.
  beforeEach(() => {
    dbThrows = true;
  });

  it("degrades reads to empty rather than throwing", async () => {
    expect(await loadBoardCacheEntries()).toEqual([]);
    expect(await loadBoardCacheEntry(TEST_URL)).toBeNull();
  });

  it("degrades writes to no-ops rather than throwing", async () => {
    await expect(saveBoardCacheEntry({ url: TEST_URL })).resolves.toBeUndefined();
    await expect(touchBoardCacheEntry(TEST_URL, 304)).resolves.toBeUndefined();
    await expect(recordBoardCacheFailure(TEST_URL, 500)).resolves.toBeUndefined();
    await expect(clearBoardCache()).resolves.toBeUndefined();
  });
});
