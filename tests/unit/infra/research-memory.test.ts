/**
 * Unit tests for research-memory (src/infra/research-memory.ts)
 * ============================================================
 * Mocked Redis + Ollama embed + Postgres — $0, no live services. Covers:
 *  - cache helpers delegate to Redis with the hashed scrape key + configured TTL
 *  - ingestResearch chunks → embeds → idempotent delete + insert, returns count
 *  - empty pages skipped; embed/DB failure is fail-open (returns 0, never throws)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const cacheGet = vi.fn();
const cacheSet = vi.fn();
const execute = vi.fn().mockResolvedValue(undefined);
const embedTexts = vi.fn();
const chunkText = vi.fn();

vi.mock("../../../src/infra/redis.js", () => ({
  cacheGet,
  cacheSet,
  KEYS: { scrape: (k: string) => `scrape:HASH(${k})` },
}));
vi.mock("../../../src/lib/embed.js", () => ({ embedTexts, chunkText }));
vi.mock("../../../src/db/client.js", () => ({ db: { execute } }));

const { getCachedScrape, setCachedScrape, ingestResearch } = await import(
  "../../../src/infra/research-memory.js"
);
const { env } = await import("../../../src/core/config.js");

const page = (over: Partial<{ url: string; title: string; markdown: string; retrieved_at: string }> = {}) => ({
  url: "https://a.com",
  title: "A",
  markdown: "some long markdown body",
  retrieved_at: "2026-06-24T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cache helpers", () => {
  it("getCachedScrape reads the hashed scrape key via cacheGet", async () => {
    cacheGet.mockResolvedValueOnce([page()]);
    const out = await getCachedScrape("https://a.com");
    expect(cacheGet).toHaveBeenCalledWith("scrape:HASH(https://a.com)");
    expect(out).toEqual([page()]);
  });

  it("setCachedScrape writes with the configured TTL", async () => {
    env.RESEARCH_CACHE_TTL_SECONDS = 1234;
    await setCachedScrape("q", [page()]);
    expect(cacheSet).toHaveBeenCalledWith("scrape:HASH(q)", [page()], 1234);
  });
});

describe("ingestResearch", () => {
  it("chunks, embeds, deletes prior chunks, inserts each, and returns the count", async () => {
    chunkText.mockReturnValue(["c1", "c2"]);
    embedTexts.mockResolvedValue([[0.1], [0.2]]);

    const total = await ingestResearch([page()]);

    expect(total).toBe(2);
    expect(chunkText).toHaveBeenCalledWith("some long markdown body");
    expect(embedTexts).toHaveBeenCalledWith(["c1", "c2"]);
    // 1 idempotent DELETE (page has a url) + 2 INSERTs
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("skips pages with empty markdown", async () => {
    const total = await ingestResearch([page({ markdown: "" })]);
    expect(total).toBe(0);
    expect(chunkText).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("is fail-open: an embed failure returns 0 and never throws", async () => {
    chunkText.mockReturnValue(["c1"]);
    embedTexts.mockRejectedValue(new Error("Ollama down"));

    await expect(ingestResearch([page()])).resolves.toBe(0);
  });
});
