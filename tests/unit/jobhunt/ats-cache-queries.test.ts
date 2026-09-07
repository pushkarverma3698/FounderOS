import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadBoardCacheEntries,
  loadBoardCacheEntry,
  saveBoardCacheEntry,
  touchBoardCacheEntry,
  recordBoardCacheFailure,
  clearBoardCache,
} from "../../../src/db/ats-cache-queries.js";

const TEST_URL = "https://boards-api.greenhouse.io/v1/boards/acme-test/jobs";

describe("ats-cache-queries", () => {
  beforeEach(async () => {
    await clearBoardCache();
  });

  afterEach(async () => {
    await clearBoardCache();
  });

  it("saves and loads a board cache record", async () => {
    await saveBoardCacheEntry({
      url: TEST_URL,
      etag: '"test-etag-123"',
      lastModified: "Wed, 21 Oct 2026 07:28:00 GMT",
      payloadHash: "abc123hash",
      payload: JSON.stringify({ jobs: [{ id: 1, title: "Staff Engineer" }] }),
      status: 200,
      failureCount: 0,
    });

    const entry = await loadBoardCacheEntry(TEST_URL);
    expect(entry).not.toBeNull();
    expect(entry?.url).toBe(TEST_URL);
    expect(entry?.etag).toBe('"test-etag-123"');
    expect(entry?.last_modified).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(entry?.payload_hash).toBe("abc123hash");
    expect(entry?.status).toBe(200);
    expect(entry?.failure_count).toBe(0);

    const all = await loadBoardCacheEntries();
    expect(all).toHaveLength(1);
    expect(all[0]?.url).toBe(TEST_URL);
  });

  it("updates metadata on touch without destroying the payload", async () => {
    await saveBoardCacheEntry({
      url: TEST_URL,
      etag: '"etag-1"',
      payload: '{"jobs":[]}',
      status: 200,
    });

    await touchBoardCacheEntry(TEST_URL, 304);

    const updated = await loadBoardCacheEntry(TEST_URL);
    expect(updated?.status).toBe(304);
    expect(updated?.etag).toBe('"etag-1"');
    expect(updated?.payload).toBe('{"jobs":[]}');
    expect(updated?.failure_count).toBe(0);
  });

  it("increments failure count and updates status on failure", async () => {
    await recordBoardCacheFailure(TEST_URL, 429);
    let row = await loadBoardCacheEntry(TEST_URL);
    expect(row?.status).toBe(429);
    expect(row?.failure_count).toBe(1);

    await recordBoardCacheFailure(TEST_URL, 429);
    row = await loadBoardCacheEntry(TEST_URL);
    expect(row?.status).toBe(429);
    expect(row?.failure_count).toBe(2);
  });
});
