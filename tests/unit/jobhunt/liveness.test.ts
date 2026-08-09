/**
 * Unit tests — liveness verification (network mocked).
 *
 * The asymmetry this file defends:
 *   · calling a dead job live → one wasted application, and the founder finds out
 *   · calling a live job dead → the role leaves the brief, silently, forever
 *
 * Every ambiguous case must therefore resolve to `unverifiable`, never to
 * `expired`. If that ever inverts, these are the tests that catch it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLookup = vi.fn();

vi.mock("../../../src/tools/jobhunt/indeed-source.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, lookupJobKeys: mockLookup };
});

const {
  classifyResponse,
  livenessReason,
  mapWithConcurrencyLimit,
  verifyLiveness,
  URL_CHECK_CONCURRENCY,
} = await import("../../../src/tools/jobhunt/liveness.js");
const { INDEED_SOURCE } = await import("../../../src/tools/jobhunt/indeed-source.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockLookup.mockResolvedValue(new Map());
});

const defaultReq = { requestedUrl: "https://example.com/job/1", finalUrl: "https://example.com/job/1", redirected: false };

describe("classifyResponse", () => {
  it("treats 404 and 410 as gone", () => {
    expect(classifyResponse({ ...defaultReq, status: 404 })).toBe("expired");
    expect(classifyResponse({ ...defaultReq, status: 410 })).toBe("expired");
  });

  it("treats 2xx as live", () => {
    expect(classifyResponse({ ...defaultReq, status: 200 })).toBe("live");
  });

  it("does NOT treat a redirect as gone", () => {
    // Many ATS platforms redirect a live posting to its canonical URL. Reading
    // that as a closure would expire half the pipeline in one sweep.
    expect(classifyResponse({ ...defaultReq, status: 200, redirected: true, finalUrl: "https://example.com/job/1/" })).toBe("live");
  });

  it("treats server errors and rate limits as unverifiable, not expired", () => {
    // A 503 is the site's problem, not the job's.
    expect(classifyResponse({ ...defaultReq, status: 500 })).toBe("unverifiable");
    expect(classifyResponse({ ...defaultReq, status: 503 })).toBe("unverifiable");
    expect(classifyResponse({ ...defaultReq, status: 429 })).toBe("unverifiable");
  });

  it("treats a 403 as unverifiable — a bot block is not a closed job", () => {
    expect(classifyResponse({ ...defaultReq, status: 403 })).toBe("unverifiable");
  });
});

describe("livenessReason", () => {
  it("says explicitly that an unconfirmed row is not evidence of closure", () => {
    const reason = livenessReason("unverifiable", "timeout");
    expect(reason).toContain("NOT evidence it closed");
  });
});

describe("mapWithConcurrencyLimit", () => {
  it("refuses a limit below one rather than returning an array of holes", async () => {
    // `Math.min(0, n)` spawns zero workers, so every slot stays unwritten and
    // the caller receives `[undefined, undefined, …]` typed as R[] with no
    // error anywhere. Unreachable while URL_CHECK_CONCURRENCY is a constant —
    // and exactly the kind of silent-wrong-answer this pipeline keeps paying
    // for when a constant later becomes configurable.
    await expect(mapWithConcurrencyLimit([1, 2], 0, async (n) => n)).rejects.toThrow(/limit/i);
  });

  it("still handles an empty input list", async () => {
    expect(await mapWithConcurrencyLimit([], 6, async (n: number) => n)).toEqual([]);
  });
});

describe("verifyLiveness", () => {
  it("returns nothing for an empty shortlist without calling out", async () => {
    expect(await verifyLiveness([])).toEqual([]);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("routes an Indeed row through the job-key lookup, not an HTTP fetch", async () => {
    mockLookup.mockResolvedValue(new Map([["k1", "expired"]]));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const results = await verifyLiveness([
      { id: "a", url: "https://indeed.com/x", source: INDEED_SOURCE, externalId: "k1" },
    ]);

    expect(results[0]!.liveness).toBe("expired");
    expect(mockLookup).toHaveBeenCalledWith(["k1"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("marks a row with no URL and no key unverifiable, never expired", async () => {
    const results = await verifyLiveness([{ id: "a", url: null, source: "ats-ingest" }]);
    expect(results[0]!.liveness).toBe("unverifiable");
    expect(results[0]!.reason).toContain("no posting URL");
  });

  it("reads an ATS row's posting URL and classifies the status", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 404 }));

    const results = await verifyLiveness([
      { id: "a", url: "https://jobs.example.com/1", source: "ats-ingest" },
    ]);

    expect(results[0]!.liveness).toBe("expired");
    fetchSpy.mockRestore();
  });

  it("turns a thrown network error into unverifiable, NOT expired", async () => {
    // The single most important line in this file. A DNS blip must not silently
    // delete a live opportunity from the brief.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNRESET"));

    const results = await verifyLiveness([
      { id: "a", url: "https://jobs.example.com/1", source: "ats-ingest" },
    ]);

    expect(results[0]!.liveness).toBe("unverifiable");
    expect(results[0]!.reason).toContain("ECONNRESET");
    fetchSpy.mockRestore();
  });

  it("falls back to unverifiable when the lookup omits a key it was asked about", async () => {
    mockLookup.mockResolvedValue(new Map());
    const results = await verifyLiveness([
      { id: "a", url: null, source: INDEED_SOURCE, externalId: "missing" },
    ]);
    expect(results[0]!.liveness).toBe("unverifiable");
  });

  it("returns one result per target, preserving ids", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));
    mockLookup.mockResolvedValue(new Map([["k1", "live"]]));

    const results = await verifyLiveness([
      { id: "a", url: "https://x/1", source: "ats-ingest" },
      { id: "b", url: null, source: INDEED_SOURCE, externalId: "k1" },
      { id: "c", url: null, source: "manual" },
    ]);

    expect(results.map((r) => r.id)).toEqual(["a", "b", "c"]);
    fetchSpy.mockRestore();
  });

  it("returns results in input order even when later targets resolve first", async () => {
    // Concurrency means completion order and input order diverge. The target
    // requested FIRST is given the LONGEST delay here, so a naive
    // completion-order collection would return it last — this must not happen.
    const delayByUrl: Record<string, number> = {
      "https://jobs.example.com/0": 30,
      "https://jobs.example.com/1": 20,
      "https://jobs.example.com/2": 10,
      "https://jobs.example.com/3": 0,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const delay = delayByUrl[String(input)] ?? 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return new Response("", { status: 200 });
    });

    const targets = Object.keys(delayByUrl).map((url, i) => ({
      id: `t${i}`,
      url,
      source: "ats-ingest",
    }));

    const results = await verifyLiveness(targets);

    expect(results.map((r) => r.id)).toEqual(["t0", "t1", "t2", "t3"]);
    expect(results.every((r) => r.liveness === "live")).toBe(true);
    fetchSpy.mockRestore();
  });

  it("never has more than URL_CHECK_CONCURRENCY checks in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    // Descending delays, so the target claimed FIRST in each round finishes
    // LAST in it. 14 targets against a pool of 6 spans three rounds — the case
    // the four-target test above cannot reach, because there every call starts
    // in the same round and completion order alone could have produced the
    // right answer.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const index = Number(String(input).split("/").pop());
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15 - (index % URL_CHECK_CONCURRENCY)));
      inFlight -= 1;
      return new Response("", { status: 200 });
    });

    const targets = Array.from({ length: 14 }, (_, i) => ({
      id: `t${i}`,
      url: `https://jobs.example.com/${i}`,
      source: "ats-ingest",
    }));

    const results = await verifyLiveness(targets);

    expect(peak).toBe(URL_CHECK_CONCURRENCY);
    // Input order survives ACROSS rounds, not just within one. A result written
    // at the wrong index mislabels a live posting as closed on another row.
    expect(results.map((r) => r.id)).toEqual(targets.map((t) => t.id));
    fetchSpy.mockRestore();
  });

  it("releases the page body instead of leaving the socket holding it", async () => {
    // Only `response.status` is ever read, but under Node's undici an unread
    // body keeps the connection open and buffers the whole page until GC. The
    // budget went from 8 sequential checks to 25 across a 6-way pool on
    // 2026-08-06, so up to six full job pages can now be resident at once —
    // and `clearTimeout` has already fired by the time the headers arrive, so
    // that download is covered by no timeout at all.
    const response = new Response("<html>a very long job page</html>", { status: 200 });
    const cancel = vi.spyOn(response.body as ReadableStream, "cancel");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await verifyLiveness([{ id: "a", url: "https://jobs.example.com/1", source: "ats-ingest" }]);

    expect(cancel).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("resolves a mixed batch of Indeed-keyed and URL-only targets correctly and in order", async () => {
    mockLookup.mockResolvedValue(
      new Map([
        ["k1", "live"],
        ["k2", "expired"],
      ]),
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));

    const targets = [
      { id: "url-live", url: "https://jobs.example.com/a", source: "ats-ingest" },
      { id: "indeed-live", url: null, source: INDEED_SOURCE, externalId: "k1" },
      { id: "url-expired", url: "https://jobs.example.com/b", source: "ats-ingest" },
      { id: "indeed-expired", url: null, source: INDEED_SOURCE, externalId: "k2" },
      { id: "no-url", url: null, source: "manual" },
    ];

    const results = await verifyLiveness(targets);

    expect(results.map((r) => [r.id, r.liveness])).toEqual([
      ["url-live", "live"],
      ["indeed-live", "live"],
      ["url-expired", "expired"],
      ["indeed-expired", "expired"],
      ["no-url", "unverifiable"],
    ]);
    fetchSpy.mockRestore();
  });
});
