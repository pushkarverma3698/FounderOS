/**
 * Unit tests — revalidating a board instead of re-downloading it.
 *
 * What this pins: a 304 is a SUCCESS that yields the cached payload, an ETag is
 * offered on the second request and not the first, and a board whose feed has
 * not changed costs no body. That last one is what makes a 2.26 MB Personio XML
 * feed affordable on a thirty-minute sweep.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { fetchPayload } = await import("../../../src/tools/jobhunt/free-ats-transport.js");
const { createEtagCache } = await import("../../../src/tools/jobhunt/free-ats-cache.js");

const URL_ = "https://acme.jobs.personio.com/xml";

function xmlResponse(body: string, etag: string | null) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "etag" ? etag : null) },
    text: async () => body,
    json: async () => ({}),
  };
}

const notModified = {
  ok: false,
  status: 304,
  headers: { get: () => null },
  body: { cancel: () => undefined },
};

beforeEach(() => mockFetch.mockReset());

describe("fetchPayload — conditional requests", () => {
  it("sends no validator on the first request, then offers the ETag on the next", async () => {
    const cache = createEtagCache();
    mockFetch.mockResolvedValueOnce(xmlResponse("<positions/>", '"v1"'));
    await fetchPayload(URL_, 1000, "xml", cache);

    expect(mockFetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match");

    mockFetch.mockResolvedValueOnce(notModified);
    await fetchPayload(URL_, 1000, "xml", cache);

    expect(mockFetch.mock.calls[1]?.[1]?.headers).toMatchObject({ "if-none-match": '"v1"' });
  });

  it("treats 304 as success and returns the payload it already holds", async () => {
    const cache = createEtagCache();
    mockFetch.mockResolvedValueOnce(xmlResponse("<positions>kept</positions>", '"v1"'));
    await fetchPayload(URL_, 1000, "xml", cache);

    mockFetch.mockResolvedValueOnce(notModified);
    const second = await fetchPayload(URL_, 1000, "xml", cache);

    // The whole point: unchanged board, zero bytes of body, same answer.
    expect(second).toBe("<positions>kept</positions>");
  });

  it("re-reads the body when the ETag moves on", async () => {
    const cache = createEtagCache();
    mockFetch.mockResolvedValueOnce(xmlResponse("<old/>", '"v1"'));
    await fetchPayload(URL_, 1000, "xml", cache);

    mockFetch.mockResolvedValueOnce(xmlResponse("<new/>", '"v2"'));
    expect(await fetchPayload(URL_, 1000, "xml", cache)).toBe("<new/>");
    expect(await cache.read(URL_)).toBe("<new/>");
  });

  it("asks unconditionally when no cache is supplied — the per-posting body path", async () => {
    mockFetch.mockResolvedValueOnce(xmlResponse("{}", '"v1"'));
    await fetchPayload("https://x.test/job/1", 1000, "json", null);

    expect(mockFetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match");
  });

  it("pays for the body when a 304 lands on a payload the cache can no longer produce", async () => {
    // The defect this pins, reintroduced when the cache moved to Postgres:
    // `headersFor` and `read` are now two separate round trips, so a row that
    // is dropped between them — or a cache DB that errors on the second read,
    // which fails open to `undefined` — turns a 304 into "this board has no
    // jobs". A board that silently contributes zero candidates reads exactly
    // like an employer with no openings, and is counted as neither a failure
    // nor a find. A cache miss must cost bandwidth, never correctness.
    const cache = {
      headersFor: async () => ({ "if-none-match": '"v1"' }),
      read: async () => undefined,
      store: async () => undefined,
    };

    mockFetch.mockResolvedValueOnce(notModified);
    mockFetch.mockResolvedValueOnce(xmlResponse("<positions>refetched</positions>", '"v1"'));

    expect(await fetchPayload(URL_, 1000, "xml", cache)).toBe("<positions>refetched</positions>");
    // The second attempt must carry no validator, or the server answers 304 again.
    expect(mockFetch.mock.calls[1]?.[1]?.headers).not.toHaveProperty("if-none-match");
  });

  it("does not retry-or-throw on a response that carries no headers", async () => {
    // The defect this pins: reading `.headers.get` on a header-less response
    // throws inside the fetch, which `isRetryable` cannot tell apart from a
    // dropped socket — so the board was retried three times and then reported
    // as broken. No headers simply means nothing to cache.
    const cache = createEtagCache();
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ a: 1 }) });

    await expect(fetchPayload(URL_, 1000, "json", cache)).resolves.toEqual({ a: 1 });
  });
});
