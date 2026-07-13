/**
 * Unit tests for the external MCP bridge manifest schema, loader, and the pure
 * read/write classification function (ADR-041).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import {
  bridgeManifestSchema,
  loadManifest,
  departmentsOf,
  type McpServerEntry,
} from "../../../src/mcp/bridge-manifest.js";
import { isWriteTool, bridgedToolName } from "../../../src/mcp/bridge-classify.js";

// Temp files live under $HOME — path-guard's SYSTEM_ROOTS blocks /tmp on macOS.
const tmpDirs: string[] = [];
function tmpManifest(content: string): string {
  const dir = mkdtempSync(join(homedir(), ".founderos-mcp-test-"));
  tmpDirs.push(dir);
  const path = join(dir, "mcp-bridge.json");
  writeFileSync(path, content, "utf8");
  return path;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("bridgeManifestSchema", () => {
  it("parses a valid stdio server and defaults write to []", () => {
    const parsed = bridgeManifestSchema.parse({
      servers: { blender: { command: "uvx", args: ["blender-mcp"], department: "personal" } },
    });
    const entry = parsed.servers["blender"] as McpServerEntry;
    expect(entry.command).toBe("uvx");
    expect(entry.write).toEqual([]);
    expect(entry.transport).toBe("stdio");
    expect(entry.env).toEqual([]);
  });

  it("rejects a server missing the command field", () => {
    const r = bridgeManifestSchema.safeParse({
      servers: { broken: { args: [], department: "comms" } },
    });
    expect(r.success).toBe(false);
  });

  it("accepts a department array", () => {
    const parsed = bridgeManifestSchema.parse({
      servers: { x: { command: "npx", department: ["comms", "marketing"] } },
    });
    expect(departmentsOf(parsed.servers["x"] as McpServerEntry)).toEqual(["comms", "marketing"]);
  });

  it("normalises a single department string to an array", () => {
    const parsed = bridgeManifestSchema.parse({
      servers: { x: { command: "npx", department: "personal" } },
    });
    expect(departmentsOf(parsed.servers["x"] as McpServerEntry)).toEqual(["personal"]);
  });

  it("parses an http server with defaulted headers/headerEnv (Tier 1)", () => {
    const parsed = bridgeManifestSchema.parse({
      servers: { deepwiki: { transport: "http", url: "https://mcp.deepwiki.com/mcp", department: "research" } },
    });
    const entry = parsed.servers["deepwiki"] as McpServerEntry;
    expect(entry.transport).toBe("http");
    if (entry.transport !== "http") throw new Error("narrowing");
    expect(entry.url).toBe("https://mcp.deepwiki.com/mcp");
    expect(entry.headers).toEqual({});
    expect(entry.headerEnv).toEqual({});
    expect(entry.write).toEqual([]);
  });

  it("keeps secret header values out of the manifest — headerEnv holds env-var NAMES", () => {
    const parsed = bridgeManifestSchema.parse({
      servers: {
        notion: {
          transport: "http",
          url: "https://mcp.notion.com/mcp",
          headerEnv: { Authorization: "NOTION_MCP_TOKEN" },
          department: "admin",
          write: ["create-pages"],
        },
      },
    });
    const entry = parsed.servers["notion"] as McpServerEntry;
    if (entry.transport !== "http") throw new Error("narrowing");
    expect(entry.headerEnv).toEqual({ Authorization: "NOTION_MCP_TOKEN" });
    expect(isWriteTool("notion", "create-pages", parsed)).toBe(true);
  });

  it("rejects an http server missing url", () => {
    const r = bridgeManifestSchema.safeParse({
      servers: { bad: { transport: "http", department: "research" } },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown transport", () => {
    const r = bridgeManifestSchema.safeParse({
      servers: { bad: { transport: "carrier-pigeon", url: "x", department: "research" } },
    });
    expect(r.success).toBe(false);
  });
});

describe("loadManifest", () => {
  it("loads and validates a manifest from disk", () => {
    const path = tmpManifest(
      JSON.stringify({
        servers: { slack: { command: "npx", args: ["-y", "x"], department: "comms", write: ["slack_post_message"] } },
      }),
    );
    const m = loadManifest(path);
    expect(m.servers["slack"]?.write).toEqual(["slack_post_message"]);
  });

  it("throws a clear error when the file is missing", () => {
    expect(() => loadManifest(join(homedir(), "does-not-exist-xyz.json"))).toThrow(/not found/);
  });

  it("throws on invalid JSON", () => {
    const path = tmpManifest("{ not json ");
    expect(() => loadManifest(path)).toThrow(/not valid JSON/);
  });

  it("throws on schema violation with the offending path", () => {
    const path = tmpManifest(JSON.stringify({ servers: { bad: { department: "comms" } } }));
    expect(() => loadManifest(path)).toThrow(/validation failed/);
  });
});

describe("isWriteTool (classification)", () => {
  const manifest = bridgeManifestSchema.parse({
    servers: {
      blender: { command: "uvx", department: "personal", write: ["execute_blender_code", "render_image"] },
      slack: { command: "npx", department: "comms", write: ["slack_post_message"] },
    },
  });

  it("returns true for a tool in the server write allowlist", () => {
    expect(isWriteTool("blender", "execute_blender_code", manifest)).toBe(true);
  });

  it("returns false for a tool not in the allowlist (read-through)", () => {
    expect(isWriteTool("blender", "get_scene_info", manifest)).toBe(false);
  });

  it("returns false for an unknown server (fail-safe)", () => {
    expect(isWriteTool("ghost", "anything", manifest)).toBe(false);
  });

  it("does not leak write classification across servers", () => {
    // execute_blender_code is gated for blender, not for slack
    expect(isWriteTool("slack", "execute_blender_code", manifest)).toBe(false);
  });

  it("gates every unlisted tool when gateUnlisted is true (M4 defense-in-depth)", () => {
    const paranoid = bridgeManifestSchema.parse({
      servers: { vault: { command: "x", department: "personal", write: [], gateUnlisted: true } },
    });
    expect(isWriteTool("vault", "anything_at_all", paranoid)).toBe(true);
  });

  it("defaults gateUnlisted to false (explicit-allowlist contract)", () => {
    expect(isWriteTool("blender", "get_scene_info", manifest)).toBe(false);
  });
});

describe("bridgedToolName", () => {
  it("namespaces tool names to avoid collisions with native tools", () => {
    expect(bridgedToolName("blender", "render_image")).toBe("mcp__blender__render_image");
  });
});
