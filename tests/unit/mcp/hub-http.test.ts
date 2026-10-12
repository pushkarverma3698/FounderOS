/**
 * FounderOS hub over Streamable HTTP — src/mcp/hub-http.ts.
 * ========================================================
 * For clients that cannot start the stdio hub over SSH: an OpenDots Connection
 * (Streamable HTTP + bearer only) and the OpenDots computers. These pin the
 * security boundary: the token picks the scope, a request without a known token
 * never reaches a tool, and the server refuses to listen on a public address.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHubHttpServer, readHubHttpConfig, scopeForAuthorization } from "../../../src/mcp/hub-http.js";

const ALL = "a".repeat(40);
const BRAIN = "b".repeat(40);
const tokens = [
  { token: ALL, scope: "all" as const },
  { token: BRAIN, scope: "brain" as const },
];

describe("hub-http — config", () => {
  it("maps HUB_HTTP_TOKEN to scope all and HUB_HTTP_BRAIN_TOKEN to scope brain", () => {
    const cfg = readHubHttpConfig({ HUB_HTTP_TOKEN: ALL, HUB_HTTP_BRAIN_TOKEN: BRAIN, HUB_HTTP_HOST: "172.21.0.1", HUB_HTTP_PORT: "3100" });
    expect(cfg).toEqual({ host: "172.21.0.1", port: 3100, tokens });
  });

  it("defaults to loopback and port 3100, and one token is enough", () => {
    expect(readHubHttpConfig({ HUB_HTTP_BRAIN_TOKEN: BRAIN })).toEqual({
      host: "127.0.0.1",
      port: 3100,
      tokens: [{ token: BRAIN, scope: "brain" }],
    });
  });

  it("refuses to start with no token, a short token, or the same token for both scopes", () => {
    expect(() => readHubHttpConfig({})).toThrow(/HUB_HTTP_TOKEN/);
    expect(() => readHubHttpConfig({ HUB_HTTP_TOKEN: "short" })).toThrow(/at least 32/);
    expect(() => readHubHttpConfig({ HUB_HTTP_TOKEN: ALL, HUB_HTTP_BRAIN_TOKEN: ALL })).toThrow(/differ/);
  });

  it("refuses a public or wildcard bind address", () => {
    for (const host of ["0.0.0.0", "::", "95.217.162.12", "172.32.0.1", "example.com"]) {
      expect(() => readHubHttpConfig({ HUB_HTTP_TOKEN: ALL, HUB_HTTP_HOST: host }), host).toThrow(/private/);
    }
    for (const host of ["127.0.0.1", "::1", "10.0.0.5", "172.16.0.1", "172.31.255.1", "192.168.1.2"]) {
      expect(readHubHttpConfig({ HUB_HTTP_TOKEN: ALL, HUB_HTTP_HOST: host }).host).toBe(host);
    }
  });
});

describe("hub-http — bearer → scope", () => {
  it("returns the scope of the matching token and null otherwise", () => {
    expect(scopeForAuthorization(`Bearer ${ALL}`, tokens)).toBe("all");
    expect(scopeForAuthorization(`bearer ${BRAIN}`, tokens)).toBe("brain");
    expect(scopeForAuthorization(undefined, tokens)).toBeNull();
    expect(scopeForAuthorization(ALL, tokens)).toBeNull();
    expect(scopeForAuthorization(`Bearer ${"c".repeat(40)}`, tokens)).toBeNull();
    expect(scopeForAuthorization(`Bearer ${ALL.slice(1)}`, tokens)).toBeNull();
  });
});

describe("hub-http — server", () => {
  let server: Server;
  let base: string;
  // A genuine loopback call to the server this suite started (the tests/setup.ts guard).
  beforeEach(() => {
    vi.stubGlobal("fetch", (globalThis as { __realFetch?: typeof fetch }).__realFetch);
  });
  beforeAll(async () => {
    server = createHubHttpServer({ host: "127.0.0.1", port: 0, tokens });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function client(token: string) {
    const c = new Client({ name: "test", version: "1" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return c;
  }

  it("serves every hub tool to the full token and only the brain to the brain token", async () => {
    const all = await client(ALL);
    const brain = await client(BRAIN);
    try {
      expect((await all.listTools()).tools).toHaveLength(9);
      const brainTools = (await brain.listTools()).tools.map((t) => t.name);
      expect(brainTools).toHaveLength(5);
      expect(brainTools).not.toContain("gmail_search");
      // Scope is enforced on the call too, not only in the list.
      const r = await brain.callTool({ name: "gmail_search", arguments: { query: "x" } });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toMatch(/not available in this hub \(scope: brain\)/);
    } finally {
      await all.close();
      await brain.close();
    }
  }, 30_000);

  it("rejects a missing or unknown token with 401 before any MCP handling", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const none = await fetch(`${base}/mcp`, { method: "POST", headers, body });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe("Bearer");
    const wrong = await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, authorization: `Bearer ${"z".repeat(40)}` }, body });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain("tools");
  });

  it("answers /healthz without a token and 404s other paths", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/other`, { headers: { authorization: `Bearer ${ALL}` } })).status).toBe(404);
  });
});
