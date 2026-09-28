/**
 * MCP search_knowledge honours its `limit`.
 * ========================================
 * The MCP tool advertises `limit` ("Max results (default 5)") and the handler
 * passed it on as `limit` — a key search_knowledge's schema never had, so zod
 * stripped it and every external client got 5 results whatever it asked for.
 * search_knowledge now takes `top_k`; the handler maps `limit` onto it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const engine = vi.hoisted(() => ({ topKs: [] as number[] }));
vi.mock("../../../src/db/rag-query.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/db/rag-query.js")>()),
  runRagSearch: vi.fn(async (_table: string, _query: string, topK: number) => {
    engine.topKs.push(topK);
    return { hits: [], mode: "hybrid" as const };
  }),
}));

const { handleMcpToolCall } = await import("../../../src/mcp/server.js");

beforeEach(() => {
  engine.topKs.length = 0;
});

describe("MCP search_knowledge — limit reaches the engine", () => {
  it("forwards limit as the result count", async () => {
    await handleMcpToolCall("search_knowledge", { query: "HITL interrupt", limit: 8 });
    expect(engine.topKs).toEqual([8]);
  });

  it("asks for 5 when no limit is given", async () => {
    await handleMcpToolCall("search_knowledge", { query: "HITL interrupt" });
    expect(engine.topKs).toEqual([5]);
  });
});
