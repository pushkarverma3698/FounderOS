/**
 * JARVIS static asset server — path resolution + serving contract.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { resolveStaticFile, jarvisDistAvailable } from "../../../src/infra/jarvis-static.js";

const realFetch = (globalThis as { __realFetch?: typeof fetch }).__realFetch;
if (realFetch) vi.stubGlobal("fetch", realFetch);

describe("jarvis-static", () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("resolveStaticFile blocks path traversal", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "jarvis-static-"));
    writeFileSync(join(tmpRoot, "index.html"), "<html></html>");
    expect(resolveStaticFile("/../etc/passwd", tmpRoot)).toBeNull();
    expect(resolveStaticFile("/", tmpRoot)).toContain("index.html");
  });

  it("jarvisDistAvailable is false when index.html missing", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "jarvis-static-"));
    expect(jarvisDistAvailable(tmpRoot)).toBe(false);
  });
});

describe("health server JARVIS static", () => {
  let server: Server | undefined;
  let tmpRoot: string;

  afterEach(() => {
    server?.close();
    server = undefined;
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env["JARVIS_DIST_ROOT"];
  });

  it("GET / serves SPA when dist override exists", async () => {
    const { startHealthServer } = await import("../../../src/infra/health.js");
    tmpRoot = mkdtempSync(join(tmpdir(), "jarvis-health-"));
    writeFileSync(join(tmpRoot, "index.html"), "<!DOCTYPE html><html><body>JARVIS</body></html>");
    process.env["JARVIS_DIST_ROOT"] = tmpRoot;

    const port = 39420;
    server = startHealthServer(port);
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("JARVIS");
  });
});
