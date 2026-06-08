import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { ollamaGenerate, ollamaEmbed, OLLAMA_MODEL_MAP } from "../../../src/lib/ollama.js";

describe("ollamaGenerate", () => {
  beforeEach(() => {
    delete process.env["DISABLE_LOCAL_MODELS"];
    delete process.env["OLLAMA_URL"];
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["DISABLE_LOCAL_MODELS"];
    delete process.env["OLLAMA_URL"];
  });

  it("returns generated text on success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ response: "engineering" }), { status: 200 }),
    );

    const result = await ollamaGenerate("classify", "route this message");
    expect(result).toBe("engineering");
  });

  it("uses the correct model for each alias", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ response: "ok" }), { status: 200 }),
    );

    await ollamaGenerate("summarize", "some text");

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1]!.body as string));
    expect(body.model).toBe(OLLAMA_MODEL_MAP["summarize"]);
  });

  it("posts to /api/generate with stream: false", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ response: "ok" }), { status: 200 }),
    );

    await ollamaGenerate("classify", "test");

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain("/api/generate");
    const body = JSON.parse(opts!.body as string);
    expect(body.stream).toBe(false);
  });

  it("returns null on HTTP 500", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));
    expect(await ollamaGenerate("classify", "test")).toBeNull();
  });

  it("returns null on HTTP 404 (model not found)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    expect(await ollamaGenerate("classify", "test")).toBeNull();
  });

  it("returns null on network throw (Ollama down)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await ollamaGenerate("classify", "test")).toBeNull();
  });

  it("returns null on timeout (AbortError)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new DOMException("signal timed out", "TimeoutError"));
    expect(await ollamaGenerate("classify", "test")).toBeNull();
  });

  it("returns null when response.response is missing", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ done: true }), { status: 200 }));
    expect(await ollamaGenerate("classify", "test")).toBeNull();
  });

  it("returns null immediately when DISABLE_LOCAL_MODELS=1 (no fetch called)", async () => {
    process.env["DISABLE_LOCAL_MODELS"] = "1";
    expect(await ollamaGenerate("classify", "test")).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("uses OLLAMA_URL env var as base URL", async () => {
    process.env["OLLAMA_URL"] = "http://my-ollama-host:11434";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ response: "ok" }), { status: 200 }),
    );

    await ollamaGenerate("classify", "test");

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain("http://my-ollama-host:11434");
  });
});

describe("ollamaEmbed", () => {
  beforeEach(() => {
    delete process.env["DISABLE_LOCAL_MODELS"];
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["DISABLE_LOCAL_MODELS"];
  });

  it("returns embedding array on success", async () => {
    const embedding = [0.1, 0.2, 0.3];
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding }), { status: 200 }),
    );

    const result = await ollamaEmbed("some text to embed");
    expect(result).toEqual(embedding);
  });

  it("posts to /api/embeddings with nomic-embed-text model", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: [0.1] }), { status: 200 }),
    );

    await ollamaEmbed("test text");

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain("/api/embeddings");
    const body = JSON.parse(opts!.body as string);
    expect(body.model).toBe(OLLAMA_MODEL_MAP["embed"]);
  });

  it("returns null on HTTP 500", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("error", { status: 500 }));
    expect(await ollamaEmbed("text")).toBeNull();
  });

  it("returns null on network throw", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await ollamaEmbed("text")).toBeNull();
  });

  it("returns null when embedding field is missing", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ done: true }), { status: 200 }));
    expect(await ollamaEmbed("text")).toBeNull();
  });

  it("returns null immediately when DISABLE_LOCAL_MODELS=1", async () => {
    process.env["DISABLE_LOCAL_MODELS"] = "1";
    expect(await ollamaEmbed("text")).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
