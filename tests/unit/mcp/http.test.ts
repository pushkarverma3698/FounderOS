/**
 * FounderOS MCP HTTP entry point — security-boundary tests (spec §1.2, item 6).
 *
 * The HTTP entry is the network ingress for the VPS MCP server. Its two
 * security invariants are the whole point of this file and are pinned here so
 * a regression fails CI at $0:
 *   1. Bearer-token auth happens BEFORE any tool dispatch (a request without a
 *      valid token never reaches the MCP server).
 *   2. The listener refuses to bind a non-loopback address unless the operator
 *      explicitly opts in with FOUNDEROS_MCP_ALLOW_PUBLIC=1.
 *
 * The dispatch handler is injected so the auth boundary is exercised against a
 * REAL Node http server (started on 127.0.0.1:0) without needing a full MCP
 * JSON-RPC handshake — a spy proves whether dispatch was reached.
 *
 * TDD: RED until src/mcp/http.ts is implemented.
 */

import { describe, it, expect, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  authorizeBearer,
  isLoopbackHost,
  assertBindAllowed,
  createMcpHttpServer,
} from "../../../src/mcp/http.js";

// The auth-boundary tests fetch the ephemeral HTTP server they spawn on
// loopback. The global network guard (tests/setup.ts) blocks all real fetch for
// determinism, so opt back in to the stashed REAL fetch for these self-contained
// local-server tests (same pattern as tests/unit/infra/health.test.ts).
const realFetch = (globalThis as { __realFetch?: typeof fetch }).__realFetch;
if (realFetch) vi.stubGlobal("fetch", realFetch);

// ── authorizeBearer (pure) ──────────────────────────────────────────────────

describe("authorizeBearer", () => {
  const TOKEN = "s3cr3t-token-value-0123456789abcdef";

  it("accepts a correct Bearer token", () => {
    expect(authorizeBearer(`Bearer ${TOKEN}`, TOKEN)).toEqual({ ok: true });
  });

  it("is case-insensitive on the scheme keyword", () => {
    expect(authorizeBearer(`bearer ${TOKEN}`, TOKEN).ok).toBe(true);
  });

  it("rejects a missing Authorization header with 401", () => {
    const r = authorizeBearer(undefined, TOKEN);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(401);
  });

  it("rejects a non-Bearer scheme with 401", () => {
    const r = authorizeBearer(`Basic ${TOKEN}`, TOKEN);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(401);
  });

  it("rejects a wrong token with 401", () => {
    const r = authorizeBearer("Bearer wrong-token-wrong-token-wrong", TOKEN);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(401);
  });

  it("rejects a token that is a prefix of the real one (length-guarded compare)", () => {
    const r = authorizeBearer(`Bearer ${TOKEN.slice(0, 10)}`, TOKEN);
    expect(r.ok).toBe(false);
  });

  it("fails with 500 when the server has no configured token (never open)", () => {
    const r = authorizeBearer(`Bearer ${TOKEN}`, "");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(500);
  });
});

// ── loopback bind guard (pure) ──────────────────────────────────────────────

describe("isLoopbackHost / assertBindAllowed", () => {
  it.each(["127.0.0.1", "::1", "localhost", "127.0.0.5"])("treats %s as loopback", (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });

  it.each(["0.0.0.0", "95.217.162.12", "::", "192.168.1.10"])("treats %s as non-loopback", (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });

  it("allows binding loopback without the public override", () => {
    expect(() => assertBindAllowed("127.0.0.1", false)).not.toThrow();
  });

  it("refuses to bind a public address without FOUNDEROS_MCP_ALLOW_PUBLIC", () => {
    expect(() => assertBindAllowed("0.0.0.0", false)).toThrow(/loopback|ALLOW_PUBLIC/i);
  });

  it("permits a public bind only when explicitly allowed", () => {
    expect(() => assertBindAllowed("0.0.0.0", true)).not.toThrow();
  });
});

// ── createMcpHttpServer — the auth boundary over a real socket ───────────────

async function withServer(
  opts: Parameters<typeof createMcpHttpServer>[0],
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createMcpHttpServer(opts);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("createMcpHttpServer auth boundary", () => {
  const TOKEN = "unit-test-token-0123456789abcdef0123";

  it("returns 401 and never dispatches when the token is missing", async () => {
    const dispatch = vi.fn(async (_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await withServer({ token: TOKEN, dispatch }, async (base) => {
      const res = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
      expect(res.status).toBe(401);
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it("returns 401 and never dispatches on a wrong token", async () => {
    const dispatch = vi.fn(async (_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await withServer({ token: TOKEN, dispatch }, async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { Authorization: "Bearer nope-nope-nope-nope-nope-nope" },
        body: "{}",
      });
      expect(res.status).toBe(401);
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it("reaches dispatch only when the token is valid", async () => {
    const dispatch = vi.fn(async (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reached: true }));
    });
    await withServer({ token: TOKEN, dispatch }, async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: "{}",
      });
      expect(res.status).toBe(200);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(await res.json()).toEqual({ reached: true });
    });
  });

  it("serves /healthz without auth and without dispatching", async () => {
    const dispatch = vi.fn(async (_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await withServer({ token: TOKEN, dispatch }, async (base) => {
      const res = await fetch(`${base}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ok" });
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});
