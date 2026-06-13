import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
const { embedText } = await import("../../../src/lib/embed.js");

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
