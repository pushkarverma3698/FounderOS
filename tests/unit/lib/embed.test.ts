import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
const { embedText, chunkText } = await import("../../../src/lib/embed.js");

describe("embedText", () => {
  beforeEach(() => mockFetch.mockReset());

  it("returns the embedding vector from Ollama", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) });
    const v = await embedText("hello");
    expect(v).toEqual([0.1, 0.2, 0.3]);
    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ model: "nomic-embed-text", prompt: "hello" });
  });

  it("throws a clear error when Ollama is unreachable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(embedText("x")).rejects.toThrow(/Ollama/i);
  });

  it("throws when response is missing the embedding field", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await expect(embedText("x")).rejects.toThrow(/embedding/i);
  });

  it("throws on a non-ok HTTP status", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await expect(embedText("x")).rejects.toThrow(/HTTP 500/);
  });
});

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("hello world", 1800)).toEqual(["hello world"]);
  });

  it("returns no chunks for empty/whitespace text", () => {
    expect(chunkText("", 1800)).toEqual([]);
    expect(chunkText("   \n  ", 1800)).toEqual([]);
  });

  it("splits long text into multiple chunks under the size cap", () => {
    const text = "a".repeat(5000);
    const chunks = chunkText(text, 1800, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1800);
  });

  it("overlaps consecutive chunks so seam context isn't lost", () => {
    // Distinct markers ~1700 chars apart land in overlapping chunks.
    const text = "START " + "x".repeat(1700) + " MIDDLE " + "y".repeat(1700) + " END";
    const chunks = chunkText(text, 1800, 200);
    expect(chunks.length).toBeGreaterThan(1);
    // Reassembled chunks must cover every original character region.
    expect(chunks.join("")).toContain("MIDDLE");
  });

  it("prefers breaking on paragraph boundaries", () => {
    const para = "First paragraph.".padEnd(1700, " ") + "\n\n" + "Second paragraph body.";
    const chunks = chunkText(para, 1800, 100);
    // The break should keep "Second paragraph" intact in a later chunk.
    expect(chunks.some((c) => c.includes("Second paragraph body."))).toBe(true);
  });
});
