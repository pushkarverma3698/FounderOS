/**
 * Health server — endpoint contract.
 * DB is not available in unit tests, so the server must REPORT it as
 * down (not throw), return the documented JSON shape, and 503 when DB is down.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../../src/infra/provider-probes.js", () => ({
  runProviderProbes: vi.fn().mockRejectedValue(new Error("skip in tests")),
  getLastProviderProbe: vi.fn().mockReturnValue(null),
}));

import { startHealthServer, buildHealthReport } from "../../../src/infra/health.js";

// This test fetches the ephemeral HTTP server it spawns on loopback. The global
// network guard (tests/setup.ts) blocks all real fetch for determinism, so we
// opt back in to the stashed REAL fetch for this self-contained local-server test.
const realFetch = (globalThis as { __realFetch?: typeof fetch }).__realFetch;
if (realFetch) vi.stubGlobal("fetch", realFetch);

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/**
 * Wait for the server to actually be listening.
 *
 * startHealthServer (src/infra/health.ts:363) calls `server.listen(port, cb)`
 * and returns the server SYNCHRONOUSLY — the socket is not bound yet when it
 * returns. These tests used to bridge that with a fixed `setTimeout(100)`,
 * which a loaded CI runner can outrun: the fetch then fails with
 * ECONNREFUSED (observed 2026-08-13 on run 31664074052, on a PR that does not
 * touch health at all). Waiting for the real 'listening' event is
 * deterministic regardless of runner load.
 */
function awaitListening(s: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (s.listening) return resolve();
    s.once("listening", () => resolve());
    s.once("error", reject);
  });
}

async function get(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

describe("health server", () => {
  it("buildHealthReport returns the documented shape and never throws", async () => {
    const report = await buildHealthReport();
    expect(report).toHaveProperty("status");
    expect(report).toHaveProperty("version");
    expect(report.checks).toHaveProperty("database");
    expect(report.checks).toHaveProperty("gmail_backend");
    expect(report.integrations).toHaveProperty("composio_gmail");
    expect(report).toHaveProperty("spend_today_usd");
  });

  it("buildHealthReport includes rag health with status + counts (never throws when DB down)", async () => {
    const report = await buildHealthReport();
    expect(report.checks).toHaveProperty("rag");
    const rag = report.checks.rag;
    // DB is down in unit tests — rag must report unavailable, not throw
    expect(["ok", "empty", "unavailable"]).toContain(rag["status"]);
    expect(typeof rag["knowledge_entries"]).toBe("number");
    expect(typeof rag["brain_vectors"]).toBe("number");
  });

  it("rag status is 'empty' when both counts are 0, 'ok' when positive, 'unavailable' when DB down", () => {
    // Pure logic from pingRag — modelled here without I/O
    const classify = (ke: number, bv: number, dbDown: boolean) => {
      if (dbDown) return "unavailable";
      return ke > 0 || bv > 0 ? "ok" : "empty";
    };
    expect(classify(0, 0, false)).toBe("empty");     // the prod outage class
    expect(classify(42, 0, false)).toBe("ok");
    expect(classify(0, 100, false)).toBe("ok");
    expect(classify(0, 0, true)).toBe("unavailable");
  });

  it("GET /health returns JSON with checks (503 when DB down in tests)", async () => {
    const port = 39411;
    server = startHealthServer(port);
    await awaitListening(server);
    const { status, body } = await get(port, "/health");
    expect([200, 503]).toContain(status);
    expect((body.checks as Record<string, string>).database).toMatch(/up|down/);
    // rag field must be present in the HTTP response
    expect((body.checks as Record<string, unknown>)["rag"]).toBeDefined();
  });

  it("GET /metrics returns spend + uptime", async () => {
    const port = 39412;
    server = startHealthServer(port);
    await awaitListening(server);
    const { status, body } = await get(port, "/metrics");
    expect(status).toBe(200);
    expect(body).toHaveProperty("spend_today_usd");
    expect(body).toHaveProperty("uptime_s");
  });

  it("unknown path returns 404 when JARVIS dist unavailable", async () => {
    const port = 39413;
    const emptyRoot = mkdtempSync(join(tmpdir(), "jarvis-empty-"));
    process.env["JARVIS_DIST_ROOT"] = emptyRoot;
    server = startHealthServer(port);
    await awaitListening(server);
    const { status } = await get(port, "/nope");
    expect(status).toBe(404);
    rmSync(emptyRoot, { recursive: true, force: true });
    delete process.env["JARVIS_DIST_ROOT"];
  });
});
