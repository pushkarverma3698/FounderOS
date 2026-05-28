/**
 * Unit tests for runToolExecutor (Phase 3A — two-phase LLM execution)
 *
 * runToolExecutor:
 *   1. Looks up tool by name
 *   2. Calls local Qwen (CASCADE["code"]) to validate/refine argsHint
 *   3. Falls back to argsHint if all LLM calls fail
 *   4. Executes tool.execute(finalArgs)
 *   5. Returns { toolResult, finalArgs, model }
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolResult, UnifiedTool } from "../../src/tools/index.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../../src/tools/index.js", () => {
  const mockWebSearch: UnifiedTool = {
    name: "webSearch",
    description: "Search the web for information",
    execute: vi.fn(),
  };
  const mockLinkedin: UnifiedTool = {
    name: "linkedinPost",
    description: "Post to LinkedIn",
    execute: vi.fn(),
  };
  return {
    getTool: vi.fn((name: string) => {
      if (name === "webSearch") return mockWebSearch;
      if (name === "linkedinPost") return mockLinkedin;
      return undefined;
    }),
    getToolsForAgent: vi.fn(() => [mockWebSearch]),
    webSearchTool: mockWebSearch,
    linkedinPostTool: mockLinkedin,
    linkedinAnalyticsTool: { name: "linkedinAnalytics", description: "", execute: vi.fn() },
    linkedinConnectTool: { name: "linkedinConnect", description: "", execute: vi.fn() },
  };
});

vi.mock("../../src/db/queries.js", () => ({
  logLlmCost: vi.fn().mockResolvedValue(undefined),
  getTodayCostUsd: vi.fn().mockResolvedValue(0),
}));

// Capture the fetch mock so we can control it per test
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOpenAIResponse(content: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    }),
  };
}

function makeErrorResponse(message: string, status = 500) {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message } }),
    statusText: message,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runToolExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refines argsHint via local LLM and executes the tool", async () => {
    const { getTool } = await import("../../src/tools/index.js");
    const mockTool = (getTool as ReturnType<typeof vi.fn>)("webSearch") as UnifiedTool;

    const refinedArgs = { query: "Notion.so pain points startup", maxResults: 5 };
    const toolResult: ToolResult = { success: true, data: [{ title: "Notion review" }] };

    // LLM returns refined args
    mockFetch.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(refinedArgs)));
    // Tool returns results
    (mockTool.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(toolResult);

    const { runToolExecutor } = await import("../../src/infra/llm.js");

    const result = await runToolExecutor(
      "webSearch",
      { query: "notion", maxResults: 3 },
      { agent: "prospecting_researcher" },
    );

    expect(result.toolResult).toEqual(toolResult);
    expect(result.finalArgs).toEqual(refinedArgs);
    expect(result.model).toBeDefined();
    expect(mockTool.execute).toHaveBeenCalledWith(refinedArgs);
  });

  it("falls back to argsHint directly when LLM fails", async () => {
    const { getTool } = await import("../../src/tools/index.js");
    const mockTool = (getTool as ReturnType<typeof vi.fn>)("webSearch") as UnifiedTool;

    const argsHint = { query: "Linear app competitors", maxResults: 5 };
    const toolResult: ToolResult = { success: true, data: [] };

    // All LLM entries fail
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse("LM Studio not running", 503))
      .mockResolvedValueOnce(makeErrorResponse("OpenRouter rate limited", 429))
      .mockResolvedValueOnce(makeErrorResponse("Gemini quota exceeded", 429));

    // Tool executes successfully with fallback args
    (mockTool.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(toolResult);

    const { runToolExecutor } = await import("../../src/infra/llm.js");

    const result = await runToolExecutor("webSearch", argsHint, { agent: "prospecting_researcher" });

    expect(result.toolResult).toEqual(toolResult);
    expect(result.finalArgs).toEqual(argsHint);
    expect(result.model).toBe("fallback");
    expect(mockTool.execute).toHaveBeenCalledWith(argsHint);
  });

  it("throws when tool name is not registered", async () => {
    const { runToolExecutor } = await import("../../src/infra/llm.js");

    await expect(
      runToolExecutor("nonExistentTool", { query: "test" }, { agent: "bdr" }),
    ).rejects.toThrow(/tool.*nonExistentTool.*not found/i);
  });

  it("falls back to argsHint when LLM returns invalid JSON", async () => {
    const { getTool } = await import("../../src/tools/index.js");
    const mockTool = (getTool as ReturnType<typeof vi.fn>)("webSearch") as UnifiedTool;

    const argsHint = { query: "startup growth" };
    const toolResult: ToolResult = { success: true, data: "ok" };

    // LLM returns non-JSON prose
    mockFetch.mockResolvedValueOnce(
      makeOpenAIResponse("I cannot help with that request right now."),
    );
    (mockTool.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(toolResult);

    const { runToolExecutor } = await import("../../src/infra/llm.js");

    const result = await runToolExecutor("webSearch", argsHint, { agent: "bdr" });

    // Should fall back gracefully
    expect(result.toolResult).toEqual(toolResult);
    expect(mockTool.execute).toHaveBeenCalledWith(argsHint);
  });

  it("propagates tool execution errors", async () => {
    const { getTool } = await import("../../src/tools/index.js");
    const mockTool = (getTool as ReturnType<typeof vi.fn>)("webSearch") as UnifiedTool;

    const argsHint = { query: "test query" };
    const refinedArgs = { query: "test query refined" };

    mockFetch.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(refinedArgs)));
    (mockTool.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Tavily API timeout"),
    );

    const { runToolExecutor } = await import("../../src/infra/llm.js");

    await expect(
      runToolExecutor("webSearch", argsHint, { agent: "prospecting_researcher" }),
    ).rejects.toThrow("Tavily API timeout");
  });

  it("includes context in the LLM prompt when provided", async () => {
    const { getTool } = await import("../../src/tools/index.js");
    const mockTool = (getTool as ReturnType<typeof vi.fn>)("webSearch") as UnifiedTool;

    const argsHint = { query: "notion competitors" };
    const toolResult: ToolResult = { success: true, data: [] };
    const context = "Researching Notion.so for ICP scoring";

    mockFetch.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(argsHint)));
    (mockTool.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(toolResult);

    const { runToolExecutor } = await import("../../src/infra/llm.js");

    await runToolExecutor("webSearch", argsHint, { agent: "prospecting_researcher", context });

    // Verify the context was included in the request body
    const requestBody = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1]?.body as string ?? "{}") as { messages?: Array<{ content: string }> };
    const allContent = requestBody.messages?.map((m) => m.content).join(" ") ?? "";
    expect(allContent).toContain(context);
  });
});
