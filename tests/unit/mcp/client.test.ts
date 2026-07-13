/**
 * Unit tests for buildBridgedTools — per-server isolation + department mapping (ADR-041).
 * The MultiServerMCPClient is faked via the injectable factory; no processes spawn.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { buildBridgedTools, toConnection } from "../../../src/mcp/client.js";
import { bridgeManifestSchema, mcpServerSchema } from "../../../src/mcp/bridge-manifest.js";
import type { LoadedMcpTool } from "../../../src/agents/agent-tools/external-mcp.js";

function tool(name: string, annotations?: Record<string, unknown>): LoadedMcpTool {
  return {
    name,
    description: name,
    schema: z.object({}),
    ...(annotations ? { metadata: { annotations } } : {}),
    invoke: vi.fn().mockResolvedValue("ok"),
  };
}

function fakeClient(toolsByServer: Record<string, LoadedMcpTool[] | Error>) {
  return {
    getTools: vi.fn(async (server: string) => {
      const v = toolsByServer[server];
      if (v instanceof Error) throw v;
      return v ?? [];
    }),
  } as never;
}

const manifest = bridgeManifestSchema.parse({
  servers: {
    blender: { command: "uvx", department: "personal", write: ["execute_blender_code"] },
    slack: { command: "npx", department: ["comms", "marketing"], write: ["slack_post_message"] },
  },
});

describe("buildBridgedTools", () => {
  it("maps each server's tools to its declared department(s)", async () => {
    const client = fakeClient({
      blender: [tool("get_scene_info"), tool("execute_blender_code")],
      slack: [tool("slack_post_message")],
    });
    const { byDept } = await buildBridgedTools(manifest, () => client);

    expect(byDept["personal"]?.map((t) => t.name)).toEqual([
      "mcp__blender__get_scene_info",
      "mcp__blender__execute_blender_code",
    ]);
    // slack maps to BOTH departments
    expect(byDept["comms"]?.map((t) => t.name)).toEqual(["mcp__slack__slack_post_message"]);
    expect(byDept["marketing"]?.map((t) => t.name)).toEqual(["mcp__slack__slack_post_message"]);
  });

  it("isolates a failing server — others still load", async () => {
    const client = fakeClient({
      blender: new Error("connection refused"),
      slack: [tool("slack_post_message")],
    });
    const { byDept } = await buildBridgedTools(manifest, () => client);

    expect(byDept["personal"]).toBeUndefined();
    expect(byDept["comms"]?.map((t) => t.name)).toEqual(["mcp__slack__slack_post_message"]);
  });

  it("returns empty for an empty manifest without building a client", async () => {
    const factory = vi.fn();
    const { byDept, gatedNames } = await buildBridgedTools(
      bridgeManifestSchema.parse({ servers: {} }),
      factory as never,
    );
    expect(byDept).toEqual({});
    expect(gatedNames).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
  });

  it("reports gatedNames from the manifest write allowlist (no dead gate for failed servers)", async () => {
    const client = fakeClient({
      blender: [tool("get_scene_info"), tool("execute_blender_code")],
      slack: new Error("no token"), // fails → its write tool must NOT appear in gatedNames
    });
    const { gatedNames } = await buildBridgedTools(manifest, () => client);
    expect(gatedNames).toEqual(["mcp__blender__execute_blender_code"]);
  });

  it("gates a tool the SERVER annotates as not-read-only, even when unlisted (Tier 2)", async () => {
    // deepwiki declares no manifest `write`; the server annotates one tool mutating.
    const annotated = bridgeManifestSchema.parse({
      servers: { deepwiki: { transport: "http", url: "https://mcp.deepwiki.com/mcp", department: "research" } },
    });
    const client = fakeClient({
      deepwiki: [
        tool("read_wiki_structure", { readOnlyHint: true }),
        tool("submit_edit", { readOnlyHint: false }),
        tool("purge", { destructiveHint: true }),
        tool("ask_question"), // no annotation → read-through default preserved
      ],
    });
    const { gatedNames } = await buildBridgedTools(annotated, () => client);
    expect(gatedNames.sort()).toEqual(["mcp__deepwiki__purge", "mcp__deepwiki__submit_edit"]);
  });
});

describe("toConnection (transport mapping, Tier 1)", () => {
  it("maps a stdio entry and forwards resolved env-var values", () => {
    process.env.__MCP_TEST_TOKEN = "secret-value";
    const entry = mcpServerSchema.parse({
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: ["__MCP_TEST_TOKEN"],
      department: "comms",
    });
    const conn = toConnection(entry) as { transport: string; command: string; env: Record<string, string> };
    expect(conn.transport).toBe("stdio");
    expect(conn.command).toBe("npx");
    expect(conn.env).toEqual({ __MCP_TEST_TOKEN: "secret-value" });
    delete process.env.__MCP_TEST_TOKEN;
  });

  it("maps an http entry, merging literal headers with env-resolved secret headers", () => {
    process.env.__MCP_TEST_AUTH = "Bearer abc123";
    const entry = mcpServerSchema.parse({
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: { "X-Version": "2026-07" },
      headerEnv: { Authorization: "__MCP_TEST_AUTH" },
      department: "research",
    });
    const conn = toConnection(entry) as { transport: string; url: string; headers: Record<string, string> };
    expect(conn.transport).toBe("http");
    expect(conn.url).toBe("https://mcp.example.com/mcp");
    expect(conn.headers).toEqual({ "X-Version": "2026-07", Authorization: "Bearer abc123" });
    delete process.env.__MCP_TEST_AUTH;
  });

  it("omits a header whose env var is unset (never sends an empty secret)", () => {
    delete process.env.__MCP_MISSING;
    const entry = mcpServerSchema.parse({
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headerEnv: { Authorization: "__MCP_MISSING" },
      department: "research",
    });
    const conn = toConnection(entry) as { headers?: Record<string, string> };
    expect(conn.headers).toBeUndefined();
  });
});
