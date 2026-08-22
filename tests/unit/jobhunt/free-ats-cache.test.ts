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
});
