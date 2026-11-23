import { describe, expect, it } from "vitest";
import { createMacClient } from "../../../src/gateway/mac-worker-client.js";

function fake(responses: Response[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return responses.shift()!;
  }) as unknown as typeof fetch;
  return { seen, impl };
}

describe("createMacClient", () => {
  it("sends the bearer token and returns null on 204", async () => {
    const f = fake([new Response(null, { status: 204 })]);
    const api = createMacClient("https://vps.example/", "tok", f.impl);
    expect(await api.lease()).toBeNull();
    expect(f.seen[0]!.url).toBe("https://vps.example/apply/mac-worker/lease");
    expect((f.seen[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
  });

  it("reads the lease, asks for the packet by rowId and leaseId, and posts results as JSON", async () => {
    const f = fake([
      new Response(JSON.stringify({ leaseId: "L", rowId: "R", leaseUntil: null }), { status: 200 }),
      new Response(JSON.stringify({ rowId: "R" }), { status: 200 }),
      new Response("{}", { status: 200 }),
    ]);
    const api = createMacClient("https://vps.example", "tok", f.impl);
    const lease = await api.lease();
    expect(lease).toEqual({ leaseId: "L", rowId: "R" });
    await api.packet(lease!);
    expect(f.seen[1]!.url).toContain("packet?rowId=R&leaseId=L");
    await api.result({ rowId: "R", leaseId: "L", outcome: "failed", detail: "x" });
    expect(JSON.parse(f.seen[2]!.init.body as string)).toMatchObject({ outcome: "failed" });
  });

  it("throws on an error status so the loop can log it", async () => {
    const f = fake([new Response("nope", { status: 401 })]);
    await expect(createMacClient("https://v", "bad", f.impl).heartbeat()).rejects.toThrow(/HTTP 401/);
  });
});
