/**
 * Unit tests for the FounderOS MCP server.
 *
 * Tests the server's tool registry and handler logic in isolation —
 * no actual HTTP server started, no real API calls made.
 *
 * TDD: RED until src/mcp/server.ts is implemented.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FOUNDEROS_MCP_TOOLS,
  handleMcpToolCall,
  type McpToolName,
} from "../../../src/mcp/server.js";

// ── Tool registry ─────────────────────────────────────────────────────────────

describe("FOUNDEROS_MCP_TOOLS registry", () => {
  it("exports at least 6 tools (3 original + 3 memory data-source tools)", () => {
    expect(FOUNDEROS_MCP_TOOLS.length).toBeGreaterThanOrEqual(6);
  });

  it("includes search_web tool", () => {
    const tool = FOUNDEROS_MCP_TOOLS.find((t) => t.name === "search_web");
    expect(tool).toBeDefined();
    expect(tool?.description).toBeTruthy();
    expect(tool?.inputSchema).toBeDefined();
  });

  it("includes github_read tool", () => {
    const tool = FOUNDEROS_MCP_TOOLS.find((t) => t.name === "github_read");
    expect(tool).toBeDefined();
    expect(tool?.description).toBeTruthy();
  });

  it("includes read_context tool", () => {
    const tool = FOUNDEROS_MCP_TOOLS.find((t) => t.name === "read_context");
    expect(tool).toBeDefined();
  });

  it("all tools have a name, description, and inputSchema", () => {
    for (const tool of FOUNDEROS_MCP_TOOLS) {
      expect(tool.name, `${tool.name} missing name`).toBeTruthy();
      expect(tool.description, `${tool.name} missing description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} missing inputSchema`).toBeDefined();
    }
  });

  it("includes search_memory tool", () => {
    const tool = FOUNDEROS_MCP_TOOLS.find((t) => t.name === "search_memory");
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/memory|episodic|conversation/i);
  });

  it("includes search_knowledge tool", () => {
    const tool = FOUNDEROS_MCP_TOOLS.find((t) => t.name === "search_knowledge");
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/knowledge|turicks|brain/i);
  });

  it("includes read_cv tool", () => {
    const tool = FOUNDEROS_MCP_TOOLS.find((t) => t.name === "read_cv");
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/cv|career|personal/i);
  });

  it("no write/HITL tools exposed (read-only contract)", () => {
    const names = FOUNDEROS_MCP_TOOLS.map((t) => t.name);
    // Write tools must NOT be exposed via MCP — they require HITL approval
    expect(names).not.toContain("send_email");
    expect(names).not.toContain("linkedin_post");
    expect(names).not.toContain("github_write");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("run_shell");
    expect(names).not.toContain("browser");
  });
});

// ── handleMcpToolCall ─────────────────────────────────────────────────────────

describe("handleMcpToolCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an error result for unknown tool names", async () => {
    const result = await handleMcpToolCall("nonexistent_tool" as McpToolName, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/unknown tool|not found/i);
  });

  it("search_web calls the web search tool and returns text content", async () => {
    // Mock the underlying Firecrawl call
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          { title: "Test Result", url: "https://example.com", description: "A test snippet" },
        ],
      }),
    }));

    const result = await handleMcpToolCall("search_web", { query: "LangGraph multi-agent" });
    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBeTruthy();
  });

  it("search_web returns error content (not throw) on Firecrawl failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const result = await handleMcpToolCall("search_web", { query: "test" });
    // Should not throw — MCP errors are returned as error content
    expect(result.content[0]?.text).toBeTruthy();
    // May be an error or empty — but it must not throw
  });

  it("github_read returns error content when GITHUB_TOKEN missing", async () => {
    const savedToken = process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_TOKEN"];

    const result = await handleMcpToolCall("github_read", { action: "get_stats" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/token|key|configured/i);

    if (savedToken) process.env["GITHUB_TOKEN"] = savedToken;
  });

  it("read_context returns text content without throwing", async () => {
    // context.ts reads from Postgres — but should handle missing DB gracefully
    const result = await handleMcpToolCall("read_context", {});
    // Either returns context or an error — must not throw
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]?.type).toBe("text");
  });

  it("search_memory returns text content without throwing", async () => {
    const result = await handleMcpToolCall("search_memory", { query: "FounderOS decisions" });
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]?.type).toBe("text");
  });

  it("search_knowledge returns text content without throwing", async () => {
    const result = await handleMcpToolCall("search_knowledge", { query: "HITL interrupt" });
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]?.type).toBe("text");
  });

  it("read_cv returns text content without throwing", async () => {
    const result = await handleMcpToolCall("read_cv", { query: "LangGraph experience" });
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]?.type).toBe("text");
  });
});
