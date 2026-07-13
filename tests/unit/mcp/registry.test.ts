/**
 * Unit tests for the MCP registry mapping (ADR-041 Tier 3). Pure — no network:
 * mapRegistryServer/serverKey/toManifestEntry are exercised on registry-shaped
 * objects, matching the real registry.modelcontextprotocol.io response.
 */

import { describe, it, expect } from "vitest";
import { mapRegistryServer, serverKey, toManifestEntry } from "../../../src/mcp/registry.js";

describe("serverKey", () => {
  it("takes the last path/dot segment, lowercased and sanitized", () => {
    expect(serverKey("com.mcparmory/notion")).toBe("notion");
    expect(serverKey("ai.smithery/smithery-notion")).toBe("smithery-notion");
    expect(serverKey("io.github.Foo/Bar_Baz")).toBe("bar-baz");
  });
});

describe("mapRegistryServer", () => {
  it("maps a streamable-http remote to an http entry and extracts secret headers", () => {
    const s = mapRegistryServer({
      name: "ai.smithery/smithery-notion",
      description: "Notion",
      remotes: [
        {
          type: "streamable-http",
          url: "https://server.smithery.ai/@smithery/notion/mcp",
          headers: [{ name: "Authorization", value: "Bearer {smithery_api_key}", isSecret: true, isRequired: true }],
        },
      ],
    });
    expect(s.proposed).toEqual({
      transport: "http",
      url: "https://server.smithery.ai/@smithery/notion/mcp",
      headerEnv: { Authorization: "SMITHERY_API_KEY" },
    });
    expect(s.requiredSecrets).toEqual(["SMITHERY_API_KEY"]);
    expect(s.key).toBe("smithery-notion");
  });

  it("maps a uvx stdio package to a stdio entry", () => {
    const s = mapRegistryServer({
      name: "com.mcparmory/notion",
      packages: [{ registryType: "pypi", identifier: "mcparmory-notion", runtimeHint: "uvx", transport: { type: "stdio" } }],
    });
    expect(s.proposed).toEqual({ transport: "stdio", command: "uvx", args: ["mcparmory-notion"] });
    expect(s.requiredSecrets).toEqual([]);
  });

  it("maps an npx stdio package with the -y flag", () => {
    const s = mapRegistryServer({
      name: "org/thing",
      packages: [{ registryType: "npm", identifier: "@org/thing", runtimeHint: "npx", transport: { type: "stdio" } }],
    });
    expect(s.proposed).toEqual({ transport: "stdio", command: "npx", args: ["-y", "@org/thing"] });
  });

  it("prefers a hosted remote over a package when both exist", () => {
    const s = mapRegistryServer({
      name: "x/y",
      remotes: [{ type: "streamable-http", url: "https://h/mcp" }],
      packages: [{ registryType: "pypi", identifier: "y", runtimeHint: "uvx", transport: { type: "stdio" } }],
    });
    expect(s.proposed?.transport).toBe("http");
  });

  it("marks a docker/OCI-only server unsupported (no auto-wiring)", () => {
    const s = mapRegistryServer({
      name: "x/y",
      packages: [{ registryType: "oci", identifier: "ghcr.io/x/y:1", runtimeHint: "docker", transport: { type: "stdio" } }],
    });
    expect(s.proposed).toBeNull();
    expect(s.unsupported).toMatch(/Docker/i);
  });

  it("marks a server with no runnable transport unsupported", () => {
    const s = mapRegistryServer({ name: "x/y" });
    expect(s.proposed).toBeNull();
    expect(s.unsupported).toMatch(/no http/i);
  });
});

describe("toManifestEntry", () => {
  it("produces a fully-defaulted, schema-valid entry for the chosen department", () => {
    const entry = toManifestEntry({ transport: "http", url: "https://h/mcp" }, "research");
    expect(entry).toMatchObject({ transport: "http", url: "https://h/mcp", department: "research", write: [], gateUnlisted: false });
  });
});
