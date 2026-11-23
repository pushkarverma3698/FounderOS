/**
 * Claude hand-off lane over the Mac worker API (#1330): a real node:http server on port 0, every dependency faked. Proves:
 *  1. lease-claude: 204 when empty; max is clamped to 10 (and 1); one lease id for the batch; the Workday flag reaches the lease.
 *  2. filled_to_submit needs an http(s) link, records link + blanks, holds the lease 12 hours, and NEVER settles (no applied).
 *  3. submitted settles via "mac" only after filled_to_submit; before it, 409 and nothing settles.
 *  4. the TS worker's `confirmed` is refused on a Claude-lane row; failed clears the lease.
 *  5. claude-run sends one Telegram message per run (several when long) and nothing when nothing was filled.
 */

import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { handleMacWorkerRequest } = await import("../../../src/gateway/mac-worker-api.js");
const { formatFilledResult } = await import("../../../src/tools/jobhunt/claude-lane-rules.js");
type Deps = import("../../../src/gateway/mac-worker-api.js").MacWorkerDeps;

const TOKEN = "claude-lane-test-token-0123456789";
const ROW_ID = "11111111-2222-4333-8444-555555555555";
const LEASE = "lease-claude-aaaa-bbbb";
const NOW = new Date("2026-11-23T12:00:00Z");
const WIZARD = "Form not usable: multi-step wizard, next page never reached";
const FILLED = formatFilledResult({ link: "https://careers.example.test/apply/submit", blanks: ["Visa status"] });
const row = (over: Record<string, unknown> = {}) =>
  ({ id: ROW_ID, company: "Acme", title: "Engineer", url: "https://careers.example.test/job/1", profile_id: "pushkar-nl-tech", applied_at: null,
    apply_lane: "hand_off", apply_lane_reason: WIZARD, mac_result: null, mac_lease_id: LEASE, mac_lease_until: new Date(NOW.getTime() + 600_000), ...over }) as never;

describe("Claude hand-off lane API", () => {
  let server: Server;
  let base: string;
  let current: unknown;
  let workday = false;
  const m = {
    leaseClaude: vi.fn(), markFilled: vi.fn(), filledForLease: vi.fn(), getLeased: vi.fn(), release: vi.fn(),
    settle: vi.fn(), notify: vi.fn(), photo: vi.fn(),
  };
  const call = (path: string, body?: unknown) =>
    fetch(`${base}/apply/mac-worker/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const result = (outcome: string, extra: Record<string, unknown> = {}) => call("result", { rowId: ROW_ID, leaseId: LEASE, outcome, detail: "d", ...extra });

  beforeEach(async () => {
    vi.stubGlobal("fetch", (globalThis as { __realFetch?: typeof fetch }).__realFetch);
    for (const f of Object.values(m)) f.mockReset();
    workday = false;
    current = row();
    m.getLeased.mockImplementation(async (id: string, lease: string) => (id === ROW_ID && lease === LEASE ? current : null));
    m.markFilled.mockResolvedValue(true);
    m.release.mockResolvedValue(true);
    m.notify.mockResolvedValue(undefined);
    m.photo.mockResolvedValue(undefined);
    m.settle.mockResolvedValue({ kind: "confirmed" });
    const deps = {
      now: () => NOW, token: () => TOKEN, profileIds: () => ["pushkar-nl-tech"], claudeWorkday: () => workday,
      leaseClaude: m.leaseClaude, markFilled: m.markFilled, filledForLease: m.filledForLease, getLeased: m.getLeased, release: m.release,
      settle: m.settle, notify: m.notify, photo: m.photo,
    } as unknown as Deps;
    server = createServer((req, res) => void handleMacWorkerRequest(req, res, deps));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("lease-claude: 204 when nothing is eligible, else one lease id and the rows", async () => {
    m.leaseClaude.mockResolvedValueOnce([]);
    expect((await call("lease-claude")).status).toBe(204);
    m.leaseClaude.mockResolvedValueOnce([row(), row({ id: "22222222-2222-4333-8444-555555555555", company: "Beta" })]);
    const res = await call("lease-claude");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { leaseId: string; rows: { rowId: string; company: string }[] };
    expect(body.leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.rows.map((r) => r.company)).toEqual(["Acme", "Beta"]);
    expect(m.leaseClaude.mock.calls[1]?.[1]).toMatchObject({ leaseId: body.leaseId, max: 10, workday: false });
  });

  it("lease-claude clamps max to 1..10 and passes the Workday flag", async () => {
    m.leaseClaude.mockResolvedValue([]);
    await call("lease-claude?max=50");
    await call("lease-claude?max=0");
    await call("lease-claude?max=abc");
    workday = true;
    await call("lease-claude?max=3");
    expect(m.leaseClaude.mock.calls.map((c) => [c[1].max, c[1].workday])).toEqual([[10, false], [1, false], [10, false], [3, true]]);
  });

  it("filled_to_submit records link and blanks, holds the lease 12h, and never settles", async () => {
    const res = await result("filled_to_submit", { link: "https://careers.example.test/apply/submit", blanks: ["Visa status", "Notice period"] });
    expect(res.status).toBe(200);
    const [rowId, leaseId, report, until] = m.markFilled.mock.calls[0] as [string, string, { link: string; blanks: string[] }, Date];
    expect([rowId, leaseId]).toEqual([ROW_ID, LEASE]);
    expect(report).toEqual({ link: "https://careers.example.test/apply/submit", blanks: ["Visa status", "Notice period"] });
    expect(until.getTime() - NOW.getTime()).toBe(12 * 60 * 60 * 1000);
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.release).not.toHaveBeenCalled();
  });

  it("filled_to_submit without an http(s) link is a 400 and records nothing", async () => {
    expect((await result("filled_to_submit")).status).toBe(400);
    expect((await result("filled_to_submit", { link: "javascript:alert(1)" })).status).toBe(400);
    expect(m.markFilled).not.toHaveBeenCalled();
  });

  it("submitted before filled_to_submit is a 409 and nothing is applied", async () => {
    const res = await result("submitted");
    expect(res.status).toBe(409);
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.release).not.toHaveBeenCalled();
  });

  it("submitted after filled_to_submit settles as applied via mac and clears the lease", async () => {
    current = row({ mac_result: FILLED });
    const res = await result("submitted", { proofScreenshot: Buffer.from("png").toString("base64") });
    expect(res.status).toBe(200);
    expect(m.settle).toHaveBeenCalledTimes(1);
    expect(m.settle.mock.calls[0]?.[1]).toBe("mac");
    expect(m.release).toHaveBeenCalledWith(ROW_ID, LEASE, "confirmed", NOW);
  });

  it("the TS worker's confirmed is refused on a Claude-lane row and on a filled one", async () => {
    expect((await result("confirmed")).status).toBe(409);
    current = row({ mac_result: FILLED, apply_lane_reason: "something else" });
    expect((await result("confirmed")).status).toBe(409);
    expect(m.settle).not.toHaveBeenCalled();
  });

  it("confirmed still works for a row outside the Claude lane (the TS worker's CAPTCHA rows)", async () => {
    current = row({ apply_lane_reason: "CAPTCHA or reCAPTCHA widget on the form; a person has to solve it" });
    expect((await result("confirmed")).status).toBe(200);
    expect(m.settle).toHaveBeenCalledTimes(1);
  });

  it("failed after filling clears the lease with the reason", async () => {
    current = row({ mac_result: FILLED });
    expect((await result("failed", { detail: "page changed" })).status).toBe(200);
    expect(m.release).toHaveBeenCalledWith(ROW_ID, LEASE, "failed: page changed", NOW);
    expect(m.settle).not.toHaveBeenCalled();
  });

  it("a lost lease on filled_to_submit is a 409", async () => {
    m.markFilled.mockResolvedValue(false);
    expect((await result("filled_to_submit", { link: "https://careers.example.test/s" })).status).toBe(409);
  });

  it("claude-run sends one message for a few tabs, several for many, none for no tabs", async () => {
    const tab = (i: number) => ({ rowId: `r${i}`, company: `Company ${i}`, title: "Engineer", link: `https://c.example.test/${i}`, blanks: ["A long blank question label ".repeat(3)], filledAt: null });
    m.filledForLease.mockResolvedValueOnce([tab(1), tab(2)]);
    expect(await (await call("claude-run", { leaseId: LEASE })).json()).toEqual({ ok: true, messages: 1 });
    expect(m.notify).toHaveBeenCalledTimes(1);
    expect(m.notify.mock.calls[0]?.[0]).toContain("Company 2");

    m.notify.mockClear();
    m.filledForLease.mockResolvedValueOnce(Array.from({ length: 10 }, (_, i) => ({ ...tab(i + 1), blanks: Array.from({ length: 30 }, (_, j) => `Blank question ${j} ${"z".repeat(70)}`) })));
    const many = (await (await call("claude-run", { leaseId: LEASE })).json()) as { messages: number };
    expect(many.messages).toBeGreaterThan(1);
    expect(m.notify).toHaveBeenCalledTimes(many.messages);

    m.notify.mockClear();
    m.filledForLease.mockResolvedValueOnce([]);
    expect(await (await call("claude-run", { leaseId: LEASE })).json()).toEqual({ ok: true, messages: 0 });
    expect(m.notify).not.toHaveBeenCalled();
    expect((await call("claude-run", {})).status).toBe(400);
  });
});
