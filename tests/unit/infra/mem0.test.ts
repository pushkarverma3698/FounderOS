/**
 * Unit tests for the mem0 client.
 * Pure behaviour tests — no real API calls (fetch is mocked via vi.stubGlobal).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("getMem0Client", () => {
  beforeEach(() => {
    // Reset the singleton between tests by re-importing the module
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns null when MEM0_API_KEY is not set", async () => {
    vi.stubEnv("MEM0_API_KEY", "");
    const { getMem0Client } = await import("../../../src/infra/mem0.js");
    expect(getMem0Client()).toBeNull();
  });

  it("returns a Mem0Client instance when MEM0_API_KEY is set", async () => {
    vi.stubEnv("MEM0_API_KEY", "test-key-123");
    const { getMem0Client, Mem0Client } = await import("../../../src/infra/mem0.js");
    expect(getMem0Client()).toBeInstanceOf(Mem0Client);
  });

  it("uses MEM0_USER_ID env when set", async () => {
    vi.stubEnv("MEM0_API_KEY", "test-key");
    vi.stubEnv("MEM0_USER_ID", "custom-user");
    const { getMem0Client } = await import("../../../src/infra/mem0.js");
    const client = getMem0Client();
    expect(client?.userId).toBe("custom-user");
  });

  it("falls back to FOUNDER_TENANT for userId", async () => {
    vi.stubEnv("MEM0_API_KEY", "test-key");
    vi.stubEnv("MEM0_USER_ID", "");
    vi.stubEnv("FOUNDER_TENANT", "turicks");
    const { getMem0Client } = await import("../../../src/infra/mem0.js");
    const client = getMem0Client();
    expect(client?.userId).toBe("turicks");
  });
});

describe("Mem0Client.search", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns parsed hits on 200 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { id: "1", memory: "Decided to use Stripe", score: 0.92 },
          { id: "2", memory: "Closed Acme deal", score: 0.8 },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    vi.resetModules();
    vi.stubEnv("MEM0_API_KEY", "key");
    const { Mem0Client } = await import("../../../src/infra/mem0.js");
    const client = new Mem0Client("key", "founder");

    const hits = await client.search("payment");
    expect(hits).toHaveLength(2);
    expect(hits[0]?.memory).toBe("Decided to use Stripe");
    expect(hits[0]?.score).toBe(0.92);
  });

  it("returns [] on non-ok response (fail-open)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
    vi.resetModules();
    const { Mem0Client } = await import("../../../src/infra/mem0.js");
    const client = new Mem0Client("bad-key", "founder");
    expect(await client.search("anything")).toEqual([]);
  });

  it("returns [] on network error (fail-open)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    vi.resetModules();
    const { Mem0Client } = await import("../../../src/infra/mem0.js");
    const client = new Mem0Client("key", "founder");
    expect(await client.search("query")).toEqual([]);
  });
});

describe("Mem0Client.add", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts messages to the mem0 API", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);
    vi.resetModules();
    const { Mem0Client } = await import("../../../src/infra/mem0.js");
    const client = new Mem0Client("key", "founder");
    await client.add([{ role: "user", content: "Test event" }]);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/memories/");
    const body = JSON.parse(options.body as string);
    expect(body.user_id).toBe("founder");
    expect(body.messages[0].content).toBe("Test event");
  });

  it("does not throw on API failure (fire-and-forget safe)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    vi.resetModules();
    const { Mem0Client } = await import("../../../src/infra/mem0.js");
    const client = new Mem0Client("key", "founder");
    await expect(client.add([{ role: "user", content: "x" }])).resolves.toBeUndefined();
  });
});
