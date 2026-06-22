/**
 * Unit tests for the RAGFlow REST client.
 * All HTTP calls are mocked via vi.stubGlobal — no real server needed.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

describe("getRagflowClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns null when RAG_BACKEND is pgvector (default)", async () => {
    vi.stubEnv("RAG_BACKEND", "pgvector");
    const { getRagflowClient } = await import("../../../src/infra/ragflow.js");
    expect(getRagflowClient()).toBeNull();
  });

  it("returns null when RAG_BACKEND=ragflow but required vars missing", async () => {
    vi.stubEnv("RAG_BACKEND", "ragflow");
    vi.stubEnv("RAGFLOW_BASE_URL", "");
    vi.stubEnv("RAGFLOW_API_KEY", "");
    vi.stubEnv("RAGFLOW_DATASET_ID", "");
    const { getRagflowClient } = await import("../../../src/infra/ragflow.js");
    expect(getRagflowClient()).toBeNull();
  });

  it("returns a RagflowClient when all vars are set", async () => {
    vi.stubEnv("RAG_BACKEND", "ragflow");
    vi.stubEnv("RAGFLOW_BASE_URL", "http://localhost:9380");
    vi.stubEnv("RAGFLOW_API_KEY", "ragflow-test");
    vi.stubEnv("RAGFLOW_DATASET_ID", "abc-123");
    const { getRagflowClient, RagflowClient } = await import("../../../src/infra/ragflow.js");
    expect(getRagflowClient()).toBeInstanceOf(RagflowClient);
  });
});

describe("RagflowClient.search", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("returns parsed chunks on 200 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          chunks: [
            { content: "RAGFlow chunk 1", similarity: 0.91, document_name: "adr-001.md" },
            { content: "RAGFlow chunk 2", similarity: 0.75, document_name: "roadmap.md" },
          ],
        },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const { RagflowClient } = await import("../../../src/infra/ragflow.js");
    const client = new RagflowClient("http://localhost:9380", "key", "dataset-1");

    const hits = await client.search("LangGraph decision", 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.content).toBe("RAGFlow chunk 1");
    expect(hits[0]?.score).toBeCloseTo(0.91);
    expect(hits[0]?.document_name).toBe("adr-001.md");
  });

  it("returns [] on API error (fail-open)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "err" }));
    const { RagflowClient } = await import("../../../src/infra/ragflow.js");
    const client = new RagflowClient("http://localhost:9380", "key", "dataset-1");
    expect(await client.search("query")).toEqual([]);
  });

  it("returns [] on network failure (fail-open)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const { RagflowClient } = await import("../../../src/infra/ragflow.js");
    const client = new RagflowClient("http://localhost:9380", "key", "dataset-1");
    expect(await client.search("query")).toEqual([]);
  });

  it("posts correct payload including dataset_ids and top_k", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { chunks: [] } }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const { RagflowClient } = await import("../../../src/infra/ragflow.js");
    const client = new RagflowClient("http://localhost:9380", "api-key", "ds-abc");
    await client.search("test query", 3);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.question).toBe("test query");
    expect(body.dataset_ids).toEqual(["ds-abc"]);
    expect(body.top_k).toBe(3);
  });

  it("clamps top_k to max 10", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { chunks: [] } }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const { RagflowClient } = await import("../../../src/infra/ragflow.js");
    const client = new RagflowClient("http://localhost:9380", "k", "d");
    await client.search("q", 999);

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.top_k).toBe(10);
  });
});
