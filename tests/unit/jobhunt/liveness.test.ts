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

const { classifyHttpStatus, livenessReason, verifyLiveness } = await import(
  "../../../src/tools/jobhunt/liveness.js"
);
const { INDEED_SOURCE } = await import("../../../src/tools/jobhunt/indeed-source.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockLookup.mockResolvedValue(new Map());
});

describe("classifyHttpStatus", () => {
  it("treats 404 and 410 as gone", () => {
    expect(classifyHttpStatus(404)).toBe("expired");
    expect(classifyHttpStatus(410)).toBe("expired");
  });

  it("treats 2xx as live", () => {
    expect(classifyHttpStatus(200)).toBe("live");
  });

  it("does NOT treat a redirect as gone", () => {
    // Many ATS platforms redirect a live posting to its canonical URL. Reading
    // that as a closure would expire half the pipeline in one sweep.
    expect(classifyHttpStatus(301)).toBe("live");
    expect(classifyHttpStatus(302)).toBe("live");
  });

  it("treats server errors and rate limits as unverifiable, not expired", () => {
    // A 503 is the site's problem, not the job's.
    expect(classifyHttpStatus(500)).toBe("unverifiable");
    expect(classifyHttpStatus(503)).toBe("unverifiable");
    expect(classifyHttpStatus(429)).toBe("unverifiable");
  });

  it("treats a 403 as unverifiable — a bot block is not a closed job", () => {
    expect(classifyHttpStatus(403)).toBe("unverifiable");
  });
});

describe("livenessReason", () => {
  it("says explicitly that an unconfirmed row is not evidence of closure", () => {
    const reason = livenessReason("unverifiable", "timeout");
    expect(reason).toContain("NOT evidence it closed");
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
});
