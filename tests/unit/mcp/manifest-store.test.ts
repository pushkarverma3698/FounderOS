/**
 * Unit tests for the bridge manifest writer (ADR-041 Tier 3). Uses temp files
 * under $HOME (path-guard blocks /tmp on macOS, mirroring bridge-manifest.test).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { addServerToManifest } from "../../../src/mcp/manifest-store.js";
import { bridgeManifestSchema, type McpServerEntry } from "../../../src/mcp/bridge-manifest.js";

const dirs: string[] = [];
function tmpPath(seed?: string): string {
  const dir = mkdtempSync(join(homedir(), ".founderos-store-test-"));
  dirs.push(dir);
  const path = join(dir, "mcp-bridge.json");
  if (seed !== undefined) writeFileSync(path, seed, "utf8");
  return path;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const httpEntry = bridgeManifestSchema.parse({
  servers: { x: { transport: "http", url: "https://h/mcp", department: "research" } },
}).servers["x"] as McpServerEntry;

describe("addServerToManifest", () => {
  it("creates the entry when the file is missing", () => {
    const path = join(mkdtempSync(join(homedir(), ".founderos-store-test-")), "mcp-bridge.json");
    dirs.push(join(path, ".."));
    const res = addServerToManifest(path, "notion", httpEntry);
    expect(res.added).toBe(true);
    const written = bridgeManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(written.servers["notion"]?.department).toBe("research");
  });

  it("adds alongside existing servers without disturbing them", () => {
    const path = tmpPath(JSON.stringify({ servers: { blender: { command: "uvx", department: "personal" } } }));
    const res = addServerToManifest(path, "notion", httpEntry);
    expect(res.added).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(written.servers).sort()).toEqual(["blender", "notion"]);
  });

  it("refuses to overwrite an existing key", () => {
    const path = tmpPath(JSON.stringify({ servers: { notion: { transport: "http", url: "https://old/mcp", department: "admin" } } }));
    const res = addServerToManifest(path, "notion", httpEntry);
    expect(res.added).toBe(false);
    expect(res.reason).toMatch(/already/);
    // original untouched
    expect(JSON.parse(readFileSync(path, "utf8")).servers.notion.url).toBe("https://old/mcp");
  });

  it("refuses an invalid entry and leaves the file unwritten", () => {
    const path = tmpPath(JSON.stringify({ servers: {} }));
    const bad = { transport: "http", department: "research" } as unknown as McpServerEntry; // missing url
    const res = addServerToManifest(path, "bad", bad);
    expect(res.added).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).servers).toEqual({});
  });
});
