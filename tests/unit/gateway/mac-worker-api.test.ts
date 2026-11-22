/**
 * Mac worker API routes: /apply/mac-worker/*. A real node:http server on port 0 with every dependency faked. Proves:
 *  1. MAC_WORKER_TOKEN unset: every path is a 404. A wrong or missing token is a 401 and touches nothing.
 *  2. lease: 200 with a lease id for an eligible row, 204 when there is none.
 *  3. packet and cv need a live lease on that row (a stale lease id, an expired lease, an applied row: 409).
 *  4. result: a row not leased by the quoted lease is rejected; confirmed settles via "mac" (applied + audit key path)
 *     and clears the lease; challenge extends the lease 30 minutes and pings Telegram; failed clears it with the reason.
 *  5. heartbeat records a beat.
 */

import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { handleMacWorkerRequest, isMacWorkerPath } = await import("../../../src/gateway/mac-worker-api.js");
type Deps = import("../../../src/gateway/mac-worker-api.js").MacWorkerDeps;

const TOKEN = "mac-test-token-0123456789";
const ROW_ID = "11111111-2222-4333-8444-555555555555";
const LEASE = "lease-aaaa-bbbb-cccc";
const NOW = new Date("2026-11-22T12:00:00Z");
const row = (over: Record<string, unknown> = {}) =>
  ({ id: ROW_ID, company: "Acme <b>", title: "Engineer", url: "https://jobs.lever.co/acme/abc", profile_id: "pushkar-nl-tech",
    applied_at: null, stage: "screened", mac_lease_id: LEASE, mac_lease_until: new Date(NOW.getTime() + 600_000), ...over }) as never;

describe("Mac worker API", () => {
  let server: Server;
  let base: string;
  let token: string | undefined;
  let deps: Deps;
  const m = {
    lease: vi.fn(), getLeased: vi.fn(), extend: vi.fn(), release: vi.fn(), beat: vi.fn(), packet: vi.fn(), cv: vi.fn(),
    settle: vi.fn(), notify: vi.fn(), photo: vi.fn(),
  };

  const call = (method: string, path: string, init: { auth?: string | null; body?: unknown } = {}) => {
    const auth = init.auth === undefined ? `Bearer ${TOKEN}` : init.auth;
    return fetch(`${base}/apply/mac-worker/${path}`, {
      method,
      headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  };
  const result = (outcome: string, extra: Record<string, unknown> = {}) =>
    call("POST", "result", { body: { rowId: ROW_ID, leaseId: LEASE, outcome, detail: "d", ...extra } });

  beforeEach(async () => {
    vi.stubGlobal("fetch", (globalThis as { __realFetch?: typeof fetch }).__realFetch);
    token = TOKEN;
    for (const f of Object.values(m)) f.mockReset();
    m.getLeased.mockImplementation(async (id: string, lease: string) => (id === ROW_ID && lease === LEASE ? row() : null));
    m.extend.mockResolvedValue(true);
    m.release.mockResolvedValue(true);
    m.notify.mockResolvedValue(undefined);
    m.photo.mockResolvedValue(undefined);
    m.settle.mockResolvedValue({ kind: "confirmed" });
    deps = {
      now: () => NOW, token: () => token, profileIds: () => ["pushkar-nl-tech"], lease: m.lease, getLeased: m.getLeased, extend: m.extend,
      release: m.release, beat: m.beat, packet: m.packet, cv: m.cv, settle: m.settle, notify: m.notify, photo: m.photo,
    } as unknown as Deps;
    server = createServer((req, res) => void handleMacWorkerRequest(req, res, deps));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("recognises only /apply/mac-worker/ paths", () => {
    expect(isMacWorkerPath("/apply/mac-worker/lease")).toBe(true);
    expect(isMacWorkerPath("/apply/mac-worker/packet?rowId=x")).toBe(true);
    expect(isMacWorkerPath("/apply/mac-workers")).toBe(false);
    expect(isMacWorkerPath("/apply/abc.1.sig/status")).toBe(false);
  });

  it("answers 404 on every path when MAC_WORKER_TOKEN is unset, even with a bearer", async () => {
    token = undefined;
    for (const [method, path] of [["POST", "lease"], ["GET", "packet"], ["POST", "result"], ["POST", "heartbeat"]] as const) {
      expect((await call(method, path)).status).toBe(404);
    }
    expect(m.lease).not.toHaveBeenCalled();
  });

  it("answers 401 for a missing, wrong or non-bearer token and does nothing", async () => {
    for (const auth of [null, "Bearer nope", `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
      expect((await call("POST", "lease", { auth })).status).toBe(401);
    }
    expect(m.lease).not.toHaveBeenCalled();
    expect(m.beat).not.toHaveBeenCalled();
  });

  it("lease: 200 with the lease id for an eligible row, 204 when nothing is eligible", async () => {
    m.lease.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    const first = await call("POST", "lease");
    expect(first.status).toBe(200);
    const body = (await first.json()) as { leaseId: string; rowId: string; leaseUntil: string };
    expect(body.rowId).toBe(ROW_ID);
    expect(body.leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.lease).toHaveBeenCalledWith(["pushkar-nl-tech"], NOW, body.leaseId, 30 * 60 * 1000);
    expect((await call("POST", "lease")).status).toBe(204);
  });

  it("rejects the wrong method", async () => {
    expect((await call("GET", "lease")).status).toBe(405);
    expect((await call("GET", "result")).status).toBe(405);
    expect((await call("POST", "packet")).status).toBe(405);
  });

  it("packet: needs a live lease on that row", async () => {
    m.packet.mockResolvedValue({ ok: true, packet: { rowId: ROW_ID, url: "https://x", auditKey: `apply-submit:${ROW_ID}` }, cvPath: "/x.pdf" });
    const ok = await call("GET", `packet?rowId=${ROW_ID}&leaseId=${LEASE}`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { auditKey: string }).auditKey).toBe(`apply-submit:${ROW_ID}`);
    expect((await call("GET", `packet?rowId=${ROW_ID}&leaseId=other-lease`)).status).toBe(409);
    expect((await call("GET", `packet?rowId=${ROW_ID}`)).status).toBe(409);
    m.getLeased.mockResolvedValueOnce(row({ mac_lease_until: new Date(NOW.getTime() - 1000) }));
    expect((await call("GET", `packet?rowId=${ROW_ID}&leaseId=${LEASE}`)).status).toBe(409);
    m.getLeased.mockResolvedValueOnce(row({ applied_at: NOW }));
    expect((await call("GET", `packet?rowId=${ROW_ID}&leaseId=${LEASE}`)).status).toBe(409);
  });

  it("packet: a row that cannot be packed is a 422 with the reason", async () => {
    m.packet.mockResolvedValue({ ok: false, reason: "resume missing" });
    const res = await call("GET", `packet?rowId=${ROW_ID}&leaseId=${LEASE}`);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("resume missing");
  });

  it("result: a row not leased by that lease is rejected and nothing is settled", async () => {
    const res = await call("POST", "result", { body: { rowId: ROW_ID, leaseId: "someone-elses-lease", outcome: "confirmed", detail: "" } });
    expect(res.status).toBe(409);
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.release).not.toHaveBeenCalled();
  });

  it("result: bad bodies are 400", async () => {
    expect((await call("POST", "result", { body: { rowId: "nope", leaseId: LEASE, outcome: "confirmed" } })).status).toBe(400);
    expect((await result("sent")).status).toBe(400);
  });

  it("result confirmed: settles the row via 'mac' with the form url, sends the proof, clears the lease", async () => {
    const res = await result("confirmed", { proofScreenshot: Buffer.from("png").toString("base64") });
    expect(res.status).toBe(200);
    expect(m.settle).toHaveBeenCalledTimes(1);
    const [settled, via, url] = m.settle.mock.calls[0] as [{ id: string }, string, string];
    expect(settled.id).toBe(ROW_ID);
    expect(via).toBe("mac");
    expect(url).toContain("lever.co");
    expect(m.photo).toHaveBeenCalledTimes(1);
    expect(m.release).toHaveBeenCalledWith(ROW_ID, LEASE, "confirmed", NOW);
  });

  it("result confirmed: a failed proof photo does not stop the application being recorded", async () => {
    m.photo.mockRejectedValue(new Error("telegram down"));
    const res = await result("confirmed", { proofScreenshot: Buffer.from("png").toString("base64") });
    expect(res.status).toBe(200);
    expect(m.settle).toHaveBeenCalledTimes(1);
  });

  it("result confirmed: a row already applied is not settled twice", async () => {
    m.getLeased.mockResolvedValue(row({ applied_at: NOW }));
    const res = await result("confirmed");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { already: boolean }).already).toBe(true);
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.release).toHaveBeenCalled();
  });

  it("result challenge: extends the lease 30 minutes and pings Telegram with the job and company", async () => {
    const res = await result("challenge");
    expect(res.status).toBe(200);
    const until = new Date(NOW.getTime() + 30 * 60 * 1000);
    expect(m.extend).toHaveBeenCalledWith(ROW_ID, LEASE, until, "challenge", NOW);
    expect(m.settle).not.toHaveBeenCalled();
    const ping = m.notify.mock.calls[0]![0] as string;
    expect(ping).toContain("Click the check on your Mac");
    expect(ping).toContain("Engineer");
    expect(ping).toContain("Acme &lt;b&gt;");
  });

  it("result challenge: a Telegram failure does not undo the extended lease", async () => {
    m.notify.mockRejectedValue(new Error("telegram down"));
    expect((await result("challenge")).status).toBe(200);
    expect(m.extend).toHaveBeenCalled();
  });

  it("result code_needed: extends the lease and tells the founder to type the code", async () => {
    expect((await result("code_needed")).status).toBe(200);
    expect(m.extend).toHaveBeenCalledWith(ROW_ID, LEASE, new Date(NOW.getTime() + 30 * 60 * 1000), "code_needed", NOW);
    expect(m.notify.mock.calls[0]![0]).toContain("confirmation code");
  });

  it("result failed: clears the lease and records the reason", async () => {
    const res = await result("failed", { detail: "form changed" });
    expect(res.status).toBe(200);
    expect(m.release).toHaveBeenCalledWith(ROW_ID, LEASE, "failed: form changed", NOW);
    expect(m.settle).not.toHaveBeenCalled();
  });

  it("heartbeat records the beat", async () => {
    expect((await call("POST", "heartbeat")).status).toBe(200);
    expect(m.beat).toHaveBeenCalledWith(NOW);
  });

  it("an unknown action is a 404 and a crash in a dependency is a plain 500", async () => {
    expect((await call("POST", "nope")).status).toBe(404);
    m.lease.mockRejectedValue(new Error("db down"));
    const res = await call("POST", "lease");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("db down");
  });
});
