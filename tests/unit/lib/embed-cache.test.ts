/**
 * Query-embedding cache (spec §1.1 F3) — pure/injected, verified at $0.
 * Repeated founder queries ("what's our ICP?") must not re-embed the same string.
 * The cache is keyed by model+text, fail-open (a dead cache never blocks a query),
 * and — because embeddings are deterministic — can only change latency, never
 * which documents come back.
 *
 * TDD: RED until embedTextCached / embedCacheKey exist in src/lib/embed.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { embedTextCached, embedCacheKey, type EmbedCacheDeps } from "../../../src/lib/embed.js";

const VEC = [0.1, 0.2, 0.3];

function deps(over: Partial<EmbedCacheDeps>): EmbedCacheDeps {
  return {
    get: vi.fn().mockResolvedValue(null) as unknown as EmbedCacheDeps["get"],
    set: vi.fn(async () => {}),
    embed: vi.fn(async () => VEC),
    ...over,
  };
}

describe("embedCacheKey", () => {
  it("is stable for the same model+text and differs across either", () => {
    expect(embedCacheKey("hi", "m1")).toBe(embedCacheKey("hi", "m1"));
    expect(embedCacheKey("hi", "m1")).not.toBe(embedCacheKey("hi", "m2"));
    expect(embedCacheKey("hi", "m1")).not.toBe(embedCacheKey("ho", "m1"));
  });
  it("is namespaced under embed:", () => {
    expect(embedCacheKey("hi", "m1")).toMatch(/^embed:[0-9a-f]{64}$/);
  });
});

describe("embedTextCached", () => {
  it("returns the cached vector without embedding on a hit", async () => {
    const d = deps({ get: vi.fn().mockResolvedValue(VEC) as unknown as EmbedCacheDeps["get"] });
    const out = await embedTextCached("q", d);
    expect(out).toEqual(VEC);
    expect(d.embed).not.toHaveBeenCalled();
    expect(d.set).not.toHaveBeenCalled();
  });

  it("embeds and writes through on a miss", async () => {
    const d = deps({ get: vi.fn().mockResolvedValue(null) as unknown as EmbedCacheDeps["get"] });
    const out = await embedTextCached("q", d);
    expect(out).toEqual(VEC);
    expect(d.embed).toHaveBeenCalledWith("q");
    expect(d.set).toHaveBeenCalledWith(expect.any(String), VEC, expect.any(Number));
  });

  it("ignores an empty/garbage cached value and re-embeds (fail-safe)", async () => {
    const d = deps({ get: vi.fn().mockResolvedValue([]) as unknown as EmbedCacheDeps["get"] });
    const out = await embedTextCached("q", d);
    expect(out).toEqual(VEC);
    expect(d.embed).toHaveBeenCalled();
  });

  it("propagates a real embed failure (cache never masks a dead embedder)", async () => {
    const d = deps({
      get: vi.fn(async () => null),
      embed: vi.fn(async () => {
        throw new Error("Ollama down");
      }),
    });
    await expect(embedTextCached("q", d)).rejects.toThrow(/ollama/i);
  });
});
