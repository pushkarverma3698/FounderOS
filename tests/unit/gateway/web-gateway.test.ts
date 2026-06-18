/**
 * Web gateway — auth + route smoke tests (no live office).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createWebApp } from "../../../src/gateway/web.js";
import { resetStreamHubs } from "../../../src/gateway/stream-hub.js";

describe("web gateway", () => {
  beforeEach(() => {
    resetStreamHubs();
    delete process.env["WEB_GATEWAY_TOKEN"];
  });

  afterEach(() => {
    delete process.env["WEB_GATEWAY_TOKEN"];
  });

  it("GET /api/v1/health returns ok", async () => {
    const app = createWebApp();
    const res = await app.request("http://localhost/api/v1/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("rejects POST messages without text", async () => {
    const app = createWebApp();
    const res = await app.request("http://localhost/api/v1/sessions/test/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("requires bearer token when WEB_GATEWAY_TOKEN is set", async () => {
    process.env["WEB_GATEWAY_TOKEN"] = "secret-token";
    const app = createWebApp();
    const res = await app.request("http://localhost/api/v1/health");
    expect(res.status).toBe(401);
    const ok = await app.request("http://localhost/api/v1/health", {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(ok.status).toBe(200);
  });

  it("accepts query token for SSE stream when WEB_GATEWAY_TOKEN is set", async () => {
    process.env["WEB_GATEWAY_TOKEN"] = "secret-token";
    const app = createWebApp();
    const deny = await app.request("http://localhost/api/v1/sessions/test/stream");
    expect(deny.status).toBe(401);
    const ok = await app.request("http://localhost/api/v1/sessions/test/stream?token=secret-token");
    expect(ok.status).toBe(200);
  });

  it("GET miso/status returns status text", async () => {
    const app = createWebApp();
    const res = await app.request("http://localhost/api/v1/sessions/test/miso/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toContain("MISO");
  });
});
