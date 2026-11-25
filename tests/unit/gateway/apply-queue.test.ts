/**
 * Apply queue Mini App: GET /apply/queue, GET /apply/api/queue, and Send through the existing Submit endpoint.
 * A real node:http server on port 0 with fake queue/submit deps. Proves:
 *  1. Every /api/queue call needs initData; the wife's profile never sees the founder's rows.
 *  2. Rows land in the four groups; only rows with a snapshot carry the signed link; Send is offered for a ready row only.
 *  3. Send is the existing path: POST <answerUrl>/submit runs the shared Submit once, with via "miniapp".
 *  4. The shell has a per-request nonce, no user data, and the script reads server text with textContent only.
 */

import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobApplication } from "../../../src/db/schema.js";
import type { ApplySnapshot } from "../../../src/tools/jobhunt/apply-link.js";

const SECRET = "s3cret-for-tests-0123456789abcdef";
const BOT = "123456:TEST-bot-token";
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const id = (n: number): string => `11111111-2222-4333-8444-${String(n).padStart(12, "0")}`;

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/db/client.js", () => ({ getPgPool: () => ({ query: async () => ({ rows: [] }) }) }));

const { startJobsHealthServer } = await import("../../../src/jobs/health.js");
const { saveApplySnapshot } = await import("../../../src/tools/jobhunt/apply-link.js");
const { clearAutoApplySessionsForTests } = await import("../../../src/gateway/apply-session.js");
const { APPLY_QUEUE_SCRIPT } = await import("../../../src/gateway/apply-queue-script.js");
const { orderQueue, oneQuestionOf, macNoteFor } = await import("../../../src/gateway/apply-queue-api.js");
const { parseTaps } = await import("../../../src/gateway/apply-queue-taps.js");
const { applyFieldName } = await import("../../../src/gateway/apply-page.js");

const lane = (n: number, profile: string, company: string, apply_lane: string, apply_lane_reason: string): JobApplication =>
  ({ id: id(n), profile_id: profile, tenant_id: "turicks", company, title: `${company} Engineer`, url: `https://jobs.example.test/${n}`, apply_lane, apply_lane_reason }) as unknown as JobApplication;

const ROWS = [
  lane(1, "pushkar-nl-tech", "ReadyCo", "auto", "5 of 5 fields filled, no bot check"),
  lane(2, "pushkar-nl-tech", "NoSnapCo", "auto", "5 of 5 fields filled, no bot check"),
  lane(3, "pushkar-nl-tech", "AskCo", "needs_you", "1 required question(s) unanswered: Why us?"),
  lane(4, "pushkar-nl-tech", "MacCo", "hand_off", "CAPTCHA or reCAPTCHA widget on the form; a person has to solve it"),
  lane(5, "pushkar-nl-tech", "SiteCo", "hand_off", "Workday: needs an account"),
  lane(6, "pushkar-nl-tech", "SentCo", "auto", "auto-sent: confirmed"),
  lane(7, "wife-nl-finance", "ING", "auto", "fine"),
];

const snap = (n: number, company: string, platform = "ashby"): ApplySnapshot => ({
  rowId: id(n), chatId: "777", profileId: "pushkar-nl-tech", company, title: `${company} Engineer`, candidateName: "Pushkar Verma",
  targetUrl: `https://jobs.example.test/${n}`, platform, resumePath: "cv.pdf",
  summary: { filled: 5, total: 5, hasCaptcha: false, filledLabels: [], filledAnswers: [], unanswered: [] }, createdAt: 4242 + n,
});

function initData(userId: number): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(NOW / 1000) - 60), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const hash = createHmac("sha256", createHmac("sha256", "WebAppData").update(BOT).digest()).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

interface QueueBody {
  counts: Record<string, number>;
  macOnline: boolean;
  items: Array<{ id: string; group: string; company: string; jobUrl: string; answerUrl?: string; createdAt?: number; canSend: boolean; macNote?: string; question?: { label: string; field: string; draft?: string; options?: string[] } }>;
}

describe("apply queue Mini App", () => {
  let root: string;
  let server: ReturnType<typeof startJobsHealthServer>;
  let base: string;
  let beat: Date | null;
  const submit = vi.fn(async (..._args: unknown[]) => ({ kind: "confirmed" as const, row: {} as never, detail: "Application submitted and marked applied." }));
  const recordTaps = vi.fn(async (..._args: unknown[]) => undefined);
  const record = vi.fn(async (..._args: unknown[]) => undefined);
  // The re-fill after a Save: the row now has no open question and a newer snapshot, as the real one leaves it.
  const refill = vi.fn(async (snap: ApplySnapshot, _posted: unknown, held: () => void) => {
    saveApplySnapshot({ ...snap, summary: { ...snap.summary, unanswered: [] }, createdAt: snap.createdAt + 1000 }, root);
    held();
  });
  const call = (p: string, method = "GET", data?: string, body?: unknown) =>
    fetch(`${base}${p}`, {
      method,
      headers: { ...(data ? { "x-telegram-init-data": data } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const queue = async (data = initData(111)): Promise<QueueBody> => (await call("/apply/api/queue", "GET", data)).json() as Promise<QueueBody>;

  beforeEach(async () => {
    vi.stubGlobal("fetch", (globalThis as { __realFetch?: typeof fetch }).__realFetch);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "founderos-apply-queue-"));
    saveApplySnapshot(snap(1, "ReadyCo"), root);
    saveApplySnapshot({ ...snap(3, "AskCo"), summary: { ...snap(3, "AskCo").summary, unanswered: [{ label: "Why us?", required: true, fieldType: "textarea", triedAnswer: "Because of the mission." }] } }, root);
    saveApplySnapshot(snap(5, "SiteCo", "workday"), root);
    submit.mockClear();
    recordTaps.mockClear();
    record.mockClear();
    refill.mockClear();
    beat = null;
    clearAutoApplySessionsForTests();
    server = startJobsHealthServer(0, {
      now: () => NOW,
      env: { APPLY_LINK_SECRET: SECRET, APPLY_LINK_BASE_URL: "https://apply.example.test", JOBS_BOT_TOKEN: BOT, JOBHUNT_SENDER_PROFILES: "111=pushkar,222=wife" },
      root,
      senderFor: () => ({ text: async () => undefined }),
      submit: submit as never,
      recordTaps: recordTaps as never,
      record: record as never,
      refill: refill as never,
      jobs: {
        listQueue: async () => [],
        getRow: async () => null,
        prepare: vi.fn() as never,
        queue: { rows: async (profile: { id: string }) => ROWS.filter((r) => r.profile_id === profile.id), macBeat: async () => beat },
      },
    });
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("serves a shell with a per-request nonce, no user data and no unsafe-inline script", async () => {
    const res = await call("/apply/queue");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).not.toContain("unsafe-inline");
    const html = await res.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).not.toContain("ReadyCo");
    expect(APPLY_QUEUE_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(() => new Function(APPLY_QUEUE_SCRIPT)).not.toThrow();
  });

  it("never hands a non-http(s) job URL to the page's href", async () => {
    ROWS.push({ ...lane(8, "pushkar-nl-tech", "EvilCo", "hand_off", "Workday: needs an account"), url: "javascript:alert(1)" });
    try {
      const evil = (await queue()).items.find((i) => i.company === "EvilCo")!;
      expect(evil.jobUrl).toBe("");
    } finally {
      ROWS.pop();
    }
  });

  it("404s a missing, forged or unknown-user header with the same body", async () => {
    const bodies = new Set<string>();
    for (const data of [undefined, "garbage", initData(333)]) {
      const res = await call("/apply/api/queue", "GET", data);
      expect(res.status).toBe(404);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
  });

  it("groups the founder's rows into the four lists, drops the sent row, and never shows the wife's", async () => {
    const q = await queue();
    expect(q.counts).toEqual({ ready: 2, answer: 1, mac: 1, site: 1 });
    expect(q.items.map((i) => i.company).sort()).toEqual(["AskCo", "MacCo", "NoSnapCo", "ReadyCo", "SiteCo"]);
    expect(q.items.some((i) => i.company === "ING" || i.company === "SentCo")).toBe(false);
    const wife = await queue(initData(222));
    expect(wife.items.map((i) => i.company)).toEqual(["ING"]);
  });

  it("a Mac row with an open required question waits under 'answer' with the one-question field, and the counts match", async () => {
    const mac = (n: number, company: string, unanswered: unknown[]) => {
      ROWS.push(lane(n, "pushkar-nl-tech", company, "hand_off", "CAPTCHA or reCAPTCHA widget on the form; a person has to solve it"));
      saveApplySnapshot({ ...snap(n, company), summary: { ...snap(n, company).summary, unanswered } } as never, root);
    };
    mac(9, "MacAskCo", [{ label: "Notice period?", required: true, fieldType: "text" }]);
    mac(10, "MacOptCo", [{ label: "Anything else?", required: false, fieldType: "text" }]);
    try {
      const q = await queue();
      const byName = Object.fromEntries(q.items.map((i) => [i.company, i]));
      expect(byName["MacAskCo"]).toMatchObject({ group: "answer", question: { label: "Notice period?" } });
      expect(byName["MacAskCo"]?.macNote).toBeUndefined();
      expect(byName["MacOptCo"]).toMatchObject({ group: "mac" });
      expect(byName["MacCo"]).toMatchObject({ group: "mac" });
      expect(q.counts).toEqual({ ready: 2, answer: 2, mac: 2, site: 1 });
      for (const g of ["ready", "answer", "mac", "site"]) expect(q.items.filter((i) => i.group === g).length).toBe(q.counts[g]);
    } finally {
      ROWS.length -= 2;
    }
  });

  it("gives the signed link and Send only to a ready row that has a snapshot", async () => {
    const byName = Object.fromEntries((await queue()).items.map((i) => [i.company, i]));
    expect(byName["ReadyCo"]).toMatchObject({ group: "ready", canSend: true, createdAt: 4243 });
    expect(byName["ReadyCo"]?.answerUrl).toMatch(/^https:\/\/apply\.example\.test\/apply\//);
    expect(byName["NoSnapCo"]).toMatchObject({ group: "ready", canSend: false });
    expect(byName["NoSnapCo"]?.answerUrl).toBeUndefined();
    expect(byName["SiteCo"]?.canSend).toBe(false);
    expect(byName["SiteCo"]?.answerUrl).toBeDefined();
  });

  it("reports the Mac offline until it checks in, then online", async () => {
    expect((await queue()).macOnline).toBe(false);
    beat = new Date(NOW - 5 * 60 * 1000);
    expect((await queue()).macOnline).toBe(true);
    beat = new Date(NOW - 3 * 60 * 60 * 1000);
    expect((await queue()).macOnline).toBe(false);
  });

  it("Send is the existing Submit: POST <answerUrl>/submit runs the shared Submit once as miniapp", async () => {
    const ready = (await queue()).items.find((i) => i.company === "ReadyCo")!;
    const p = new URL(ready.answerUrl!).pathname;
    const res = await call(`${p}/submit`, "POST", initData(111), { createdAt: ready.createdAt });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[0]).toBe(id(1));
    expect(submit.mock.calls[0]?.[2]).toBe("miniapp");
    const stale = await call(`${p}/submit`, "POST", initData(111), { createdAt: 1 });
    expect(stale.status).toBe(409);
    const wife = await call(`${p}/submit`, "POST", initData(222), { createdAt: ready.createdAt });
    expect(wife.status).toBe(404);
  });

  it("orders ready first, sendable before not, oldest snapshot first, then by company", () => {
    const it = (company: string, group: string, canSend: boolean, createdAt?: number) =>
      ({ id: company, group, company, title: "t", jobUrl: "", reason: "", canSend, ...(createdAt ? { createdAt } : {}) }) as never;
    const out = orderQueue([it("Z-site", "site", false), it("B", "ready", true, 20), it("A-nosnap", "ready", false), it("C", "ready", true, 10), it("Ask", "answer", false), it("M", "mac", false)]);
    expect(out.map((i) => i.company)).toEqual(["C", "B", "A-nosnap", "Ask", "M", "Z-site"]);
  });

  it("offers an inline question only when exactly one required, editable question is open", () => {
    const base = snap(3, "AskCo");
    const withQs = (unanswered: ApplySnapshot["summary"]["unanswered"]): ApplySnapshot => ({ ...base, summary: { ...base.summary, unanswered } });
    const q = { label: "Why us?", required: true, fieldType: "textarea" };
    expect(oneQuestionOf(withQs([q]))).toEqual({ label: "Why us?", field: applyFieldName("Why us?"), fieldType: "textarea" });
    expect(oneQuestionOf(withQs([{ ...q, triedAnswer: "Mission" }]))?.draft).toBe("Mission");
    expect(oneQuestionOf(withQs([q, { ...q, label: "Second" }]))).toBeUndefined();
    expect(oneQuestionOf(withQs([{ ...q, required: false }]))).toBeUndefined();
    expect(oneQuestionOf(withQs([{ ...q, fieldType: "file" }]))).toBeUndefined();
    expect(oneQuestionOf(null)).toBeUndefined();
  });

  it("labels a Mac row with the click when the worker is on and Mac offline when its heartbeat is stale", async () => {
    expect(macNoteFor(true)).toBe("Click the check on your Mac.");
    expect(macNoteFor(false)).toMatch(/^Mac offline/);
    const mac = async () => (await queue()).items.find((i) => i.company === "MacCo")!.macNote;
    expect(await mac()).toMatch(/^Mac offline/);
    beat = new Date(NOW - 5 * 60 * 1000);
    expect(await mac()).toBe("Click the check on your Mac.");
    beat = new Date(NOW - 31 * 60 * 1000);
    expect(await mac()).toMatch(/^Mac offline/);
  });

  it("carries the one-answer row's question with its draft and the answer page's field name", async () => {
    const ask = (await queue()).items.find((i) => i.company === "AskCo")!;
    expect(ask).toMatchObject({ group: "answer", canSend: false, question: { label: "Why us?", field: applyFieldName("Why us?"), draft: "Because of the mission." } });
  });

  it("Save posts the answer page's own form, then the refilled row can be Sent with the new stamp", async () => {
    const ask = (await queue()).items.find((i) => i.company === "AskCo")!;
    const p = new URL(ask.answerUrl!).pathname;
    const form = new URLSearchParams({ [ask.question!.field]: "Edited answer" }).toString();
    const saved = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    expect(saved.status).toBe(200);
    expect(record).toHaveBeenCalledWith("pushkar-nl-tech", "Why us?", "Edited answer");
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    const after = (await queue()).items.find((i) => i.company === "AskCo")!;
    expect(after.createdAt).toBe(ask.createdAt! + 1000);
    expect(after).toMatchObject({ canSend: true });
    expect(after.question).toBeUndefined();
    const sent = await call(`${p}/submit`, "POST", initData(111), { createdAt: after.createdAt, taps: 3 });
    expect(sent.status).toBe(202);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[0]).toBe(id(3));
    expect(recordTaps).toHaveBeenCalledWith(id(3), after.createdAt, 3);
  });

  it("a double tap on Send runs the shared Submit once (row lock), and the tap count is recorded once", async () => {
    let finish: () => void = () => undefined;
    submit.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ kind: "confirmed" as const, row: {} as never, detail: "ok" }); }));
    const ready = (await queue()).items.find((i) => i.company === "ReadyCo")!;
    const p = new URL(ready.answerUrl!).pathname;
    const [a, b] = await Promise.all([
      call(`${p}/submit`, "POST", initData(111), { createdAt: ready.createdAt, taps: 1 }),
      call(`${p}/submit`, "POST", initData(111), { createdAt: ready.createdAt, taps: 1 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    finish();
    await new Promise((r) => setTimeout(r, 20));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(recordTaps).toHaveBeenCalledTimes(1);
    expect(recordTaps).toHaveBeenCalledWith(id(1), ready.createdAt, 1);
  });

  it("records no tap count when the body carries none or nonsense, and still sends", async () => {
    expect([parseTaps(1), parseTaps(0), parseTaps(51), parseTaps(-1), parseTaps(1.5), parseTaps("2"), parseTaps(undefined)]).toEqual([1, 0, null, null, null, null, null]);
    const ready = (await queue()).items.find((i) => i.company === "ReadyCo")!;
    const res = await call(`${new URL(ready.answerUrl!).pathname}/submit`, "POST", initData(111), { createdAt: ready.createdAt, taps: "many" });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(recordTaps).not.toHaveBeenCalled();
  });
});
