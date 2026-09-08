import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEtagCache } from "../../../src/tools/jobhunt/free-ats-cache.js";

// Mock the DB queries with an in-memory Map
const store = new Map<string, any>();
vi.mock("../../../src/db/ats-board-cache-queries.js", () => ({
  getAtsCache: async (url: string) => store.get(url) ?? null,
  setAtsCache: async (url: string, etag: string | null | undefined, payload: unknown) => {
    if (!etag) {
      store.delete(url);
    } else {
      store.set(url, { etag, payload });
    }
  }
}));

describe("createEtagCache", () => {
  beforeEach(() => {
    store.clear();
  });

  it("offers no validator for a URL it has never seen", async () => {
    const cache = createEtagCache();
    expect(await cache.headersFor("https://x.test/xml")).toEqual({});
    expect(await cache.read("https://x.test/xml")).toBeUndefined();
  });

  it("offers the stored ETag as If-None-Match once a payload is held", async () => {
    const cache = createEtagCache();
    await cache.store("https://x.test/xml", '"abc"', "<xml/>");

    expect(await cache.headersFor("https://x.test/xml")).toEqual({ "if-none-match": '"abc"' });
    expect(await cache.read("https://x.test/xml")).toBe("<xml/>");
  });

  it("does not store a response that carried no ETag — nothing could revalidate it", async () => {
    const cache = createEtagCache();
    await cache.store("https://x.test/xml", null, "<xml/>");

    expect(await cache.headersFor("https://x.test/xml")).toEqual({});
  });

  it("forgets a previously-cached URL when it comes back without an ETag", async () => {
    const cache = createEtagCache();
    await cache.store("https://x.test/xml", '"v1"', "old");
    await cache.store("https://x.test/xml", undefined, "new");

    expect(await cache.headersFor("https://x.test/xml")).toEqual({});
    expect(await cache.read("https://x.test/xml")).toBeUndefined();
  });

  it("replaces the payload when the ETag changes", async () => {
    const cache = createEtagCache();
    await cache.store("https://x.test/xml", '"v1"', "old");
    await cache.store("https://x.test/xml", '"v2"', "new");

    expect(await cache.headersFor("https://x.test/xml")).toEqual({ "if-none-match": '"v2"' });
    expect(await cache.read("https://x.test/xml")).toBe("new");
  });
});
