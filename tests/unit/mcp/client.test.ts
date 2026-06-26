/**
 * Unit tests for buildBridgedTools — per-server isolation + department mapping (ADR-041).
 * The MultiServerMCPClient is faked via the injectable factory; no processes spawn.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { buildBridgedTools } from "../../../src/mcp/client.js";
import { bridgeManifestSchema } from "../../../src/mcp/bridge-manifest.js";
import type { LoadedMcpTool } from "../../../src/agents/agent-tools/external-mcp.js";

function tool(name: string): LoadedMcpTool {
  return { name, description: name, schema: z.object({}), invoke: vi.fn().mockResolvedValue("ok") };
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
    const byDept = await buildBridgedTools(manifest, () => client);

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
    const byDept = await buildBridgedTools(manifest, () => client);

    expect(byDept["personal"]).toBeUndefined();
    expect(byDept["comms"]?.map((t) => t.name)).toEqual(["mcp__slack__slack_post_message"]);
  });

  it("returns empty for an empty manifest without building a client", async () => {
    const factory = vi.fn();
    const byDept = await buildBridgedTools(bridgeManifestSchema.parse({ servers: {} }), factory as never);
    expect(byDept).toEqual({});
    expect(factory).not.toHaveBeenCalled();
  });
});
