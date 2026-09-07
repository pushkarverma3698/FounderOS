import { describe, it, expect } from "vitest";

import { createEtagCache } from "../../../src/tools/jobhunt/free-ats-cache.js";

describe("createEtagCache", () => {
  it("offers no validator for a URL it has never seen", () => {
    const cache = createEtagCache();
    expect(cache.headersFor("https://x.test/xml")).toEqual({});
    expect(cache.read("https://x.test/xml")).toBeUndefined();
  });

  it("offers the stored ETag as If-None-Match once a payload is held", () => {
    const cache = createEtagCache();
    cache.store("https://x.test/xml", '"abc"', "<xml/>");

    expect(cache.headersFor("https://x.test/xml")).toEqual({ "if-none-match": '"abc"' });
    expect(cache.read("https://x.test/xml")).toBe("<xml/>");
  });

  it("does not store a response that carried no ETag — nothing could revalidate it", () => {
    const cache = createEtagCache();
    cache.store("https://x.test/xml", null, "<xml/>");

    expect(cache.headersFor("https://x.test/xml")).toEqual({});
    expect(cache.size).toBe(0);
  });

  it("forgets a previously-cached URL when it comes back without an ETag", () => {
    const cache = createEtagCache();
    cache.store("https://x.test/xml", '"v1"', "old");
    cache.store("https://x.test/xml", undefined, "new");

    // Keeping "old" under the "v1" validator would revalidate against a payload
    // the server has already stopped agreeing with.
    expect(cache.headersFor("https://x.test/xml")).toEqual({});
    expect(cache.read("https://x.test/xml")).toBeUndefined();
  });

  it("replaces the payload when the ETag changes", () => {
    const cache = createEtagCache();
    cache.store("https://x.test/xml", '"v1"', "old");
    cache.store("https://x.test/xml", '"v2"', "new");

    expect(cache.headersFor("https://x.test/xml")).toEqual({ "if-none-match": '"v2"' });
    expect(cache.read("https://x.test/xml")).toBe("new");
    expect(cache.size).toBe(1);
  });

  it("never offers a validator whose payload has been evicted", () => {
    // The defect this guards: a 304 answers a validator we sent, and if the
    // payload behind it is gone the board silently contributes zero candidates
    // and reads as an employer with no openings.
    const cache = createEtagCache(2);
    cache.store("a", '"1"', "A");
    cache.store("b", '"2"', "B");
    cache.store("c", '"3"', "C");

    expect(cache.size).toBe(2);
    expect(cache.headersFor("a")).toEqual({});
    for (const url of ["a", "b", "c"]) {
      const offered = "if-none-match" in cache.headersFor(url);
      expect(offered).toBe(cache.read(url) !== undefined);
    }
  });

  it("moves a refreshed entry to the back of the eviction order", () => {
    const cache = createEtagCache(2);
    cache.store("a", '"1"', "A");
    cache.store("b", '"2"', "B");
    cache.store("a", '"1b"', "A2");
    cache.store("c", '"3"', "C");

    // "b" was the oldest insertion once "a" was refreshed, so "b" goes first.
    expect(cache.read("a")).toBe("A2");
    expect(cache.read("c")).toBe("C");
    expect(cache.read("b")).toBeUndefined();
  });

  it("stores and offers Last-Modified as If-Modified-Since", () => {
    const cache = createEtagCache();
    cache.store("https://x.test/feed", null, "Wed, 21 Oct 2026 07:28:00 GMT", "<feed/>");

    expect(cache.headersFor("https://x.test/feed")).toEqual({
      "if-modified-since": "Wed, 21 Oct 2026 07:28:00 GMT",
    });
    expect(cache.read("https://x.test/feed")).toBe("<feed/>");
  });

  it("offers both If-None-Match and If-Modified-Since when both are present", () => {
    const cache = createEtagCache();
    cache.store("https://x.test/feed", '"etag-123"', "Wed, 21 Oct 2026 07:28:00 GMT", "<feed/>");

    expect(cache.headersFor("https://x.test/feed")).toEqual({
      "if-none-match": '"etag-123"',
      "if-modified-since": "Wed, 21 Oct 2026 07:28:00 GMT",
    });
  });

  it("warms the in-memory cache from persistent DB records", () => {
    const cache = createEtagCache();
    cache.warmFromEntries([
      {
        url: "https://x.test/board1",
        etag: '"v1"',
        last_modified: "Wed, 21 Oct 2026 07:28:00 GMT",
        payload_hash: "abcd",
        payload: JSON.stringify({ jobs: [1, 2] }),
        status: 200,
        failure_count: 0,
        last_checked_at: new Date(),
      },
    ]);

    expect(cache.size).toBe(1);
    expect(cache.headersFor("https://x.test/board1")).toEqual({
      "if-none-match": '"v1"',
      "if-modified-since": "Wed, 21 Oct 2026 07:28:00 GMT",
    });
    expect(cache.read("https://x.test/board1")).toEqual({ jobs: [1, 2] });
  });

  it("updates metadata on touch and tracks failures on recordFailure", () => {
    const onTouch = (url: string, status: number) => {
      expect(url).toBe("https://x.test/a");
      expect(status).toBe(304);
    };
    const onFailure = (url: string, status?: number) => {
      expect(url).toBe("https://x.test/a");
      expect(status).toBe(429);
    };

    const cache = createEtagCache({ onTouch, onFailure });
    cache.store("https://x.test/a", '"e1"', "A");

    cache.touch("https://x.test/a", 304);
    expect(cache.getEntry("https://x.test/a")?.status).toBe(304);
    expect(cache.getEntry("https://x.test/a")?.failureCount).toBe(0);

    cache.recordFailure("https://x.test/a", 429);
    expect(cache.getEntry("https://x.test/a")?.status).toBe(429);
    expect(cache.getEntry("https://x.test/a")?.failureCount).toBe(1);
  });
});

describe("warmFromEntries — the LRU cap", () => {
  // `store()` evicts down to maxEntries; warming did not, so a restart loaded
  // every row the table held regardless of the cap. Harmless at 1,297 boards
  // against a 2,000 default and NOT harmless the moment the registry grows past
  // it — PR #639 takes it to 3,223. Each entry holds a full board payload, so
  // the overshoot is memory, silently, on the box that runs the sweep.
  it("respects maxEntries when warming from the database", () => {
    const cache = createEtagCache({ maxEntries: 3 });
    cache.warmFromEntries(
      Array.from({ length: 10 }, (_, i) => ({
        url: `https://boards.example.com/${i}`,
        etag: `"e${i}"`,
        payload: JSON.stringify({ jobs: [i] }),
      })),
    );
    expect(cache.size).toBe(3);
  });

  it("keeps the most recently warmed entries, not the oldest", () => {
    const cache = createEtagCache({ maxEntries: 2 });
    cache.warmFromEntries(
      Array.from({ length: 5 }, (_, i) => ({
        url: `https://boards.example.com/${i}`,
        etag: `"e${i}"`,
        payload: JSON.stringify({ jobs: [i] }),
      })),
    );
    expect(cache.read("https://boards.example.com/4")).toEqual({ jobs: [4] });
    expect(cache.read("https://boards.example.com/0")).toBeUndefined();
  });
});
