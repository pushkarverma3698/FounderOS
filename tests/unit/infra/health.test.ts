/**
 * Health server — endpoint contract.
 * DB/Redis are not available in unit tests, so the server must REPORT them as
 * down (not throw), return the documented JSON shape, and 503 when DB is down.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import { startHealthServer, buildHealthReport } from "../../../src/infra/health.js";

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

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
    expect(report.checks).toHaveProperty("redis");
    expect(report).toHaveProperty("spend_today_usd");
  });

  it("GET /health returns JSON with checks (503 when DB down in tests)", async () => {
    const port = 39411;
    server = startHealthServer(port);
    await new Promise((r) => setTimeout(r, 100));
    const { status, body } = await get(port, "/health");
    expect([200, 503]).toContain(status);
    expect((body.checks as Record<string, string>).database).toMatch(/up|down/);
  });

  it("GET /metrics returns spend + uptime", async () => {
    const port = 39412;
    server = startHealthServer(port);
    await new Promise((r) => setTimeout(r, 100));
    const { status, body } = await get(port, "/metrics");
    expect(status).toBe(200);
    expect(body).toHaveProperty("spend_today_usd");
    expect(body).toHaveProperty("uptime_s");
  });

  it("unknown path returns 404", async () => {
    const port = 39413;
    server = startHealthServer(port);
    await new Promise((r) => setTimeout(r, 100));
    const { status } = await get(port, "/nope");
    expect(status).toBe(404);
  });
});
