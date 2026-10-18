/**
 * Mini App API on the apply answer page: /apply/<token>/status, /submit, /cancel.
 * A real node:http server on port 0, a fixture snapshot on disk, a fake Submit and fake senders. Proves:
 *  1. Every endpoint needs a valid link AND initData signed by the jobs bot, for the profile that owns the row:
 *     missing, forged, stale, unknown-user and other-profile all get the same 404.
 *  2. status maps the row to preparing|ready|blocked|submitting|confirmed|unconfirmed|cancelled|refilling.
 *  3. submit answers 202 and runs the shared Submit under the shared per-row lock; a stale page, a blocked
 *     form or a held lock is a 409 and sends nothing; the result reaches the chat.
 *  4. cancel ends the session like the Telegram button, and status still answers afterwards.
 */

import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplySnapshot } from "../../../src/tools/jobhunt/apply-link.js";

const ROW_ID = "11111111-2222-4333-8444-555555555555";
const SECRET = "s3cret-for-tests-0123456789abcdef";
const BOT = "123456:TEST-bot-token";
const PROFILE = "pushkar-nl-tech";
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const CREATED = NOW - 60_000;

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/db/client.js", () => ({ getPgPool: () => ({ query: async () => ({ rows: [] }) }) }));

const { startJobsHealthServer } = await import("../../../src/jobs/health.js");
const { saveApplySnapshot, loadApplySnapshot, deleteApplySnapshot, signApplyToken } = await import("../../../src/tools/jobhunt/apply-link.js");
const { tryLockApply, clearAutoApplySessionsForTests, recordOutcome } = await import("../../../src/gateway/apply-session.js");

const ready: ApplySnapshot = {
  rowId: ROW_ID,
  chatId: "777",
  profileId: PROFILE,
  company: "Workwize",
  title: "Automation Engineer",
  candidateName: "Pushkar Verma",
  targetUrl: "https://boards.example.test/workwize/1",
  platform: "ashby",
  resumePath: "cv-fixture.pdf",
  summary: { filled: 5, total: 5, hasCaptcha: false, filledLabels: [], filledAnswers: [], unanswered: [] },
  createdAt: CREATED,
};
const blocked: ApplySnapshot = {
  ...ready,
  summary: {
    ...ready.summary,
    unanswered: [
      { label: "Why Workwize?", required: true, fieldType: "textarea" },
      { label: "Pronouns", required: false, fieldType: "text" },
    ],
  },
};

function initData(userId: number, authDate = Math.floor(NOW / 1000) - 60, token = BOT): string {
  const fields: Record<string, string> = { auth_date: String(authDate), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const token = (): string => signApplyToken(SECRET, ROW_ID, PROFILE, Math.floor(NOW / 1000) + 3600);
const GOOD = (): string => initData(111);

describe("apply Mini App API", () => {
  let root: string;
  let server: ReturnType<typeof startJobsHealthServer>;
  let base: string;
  const sent: string[] = [];
  // Like the real runSubmit, a confirmed send ends the session and deletes the snapshot.
  const submit = vi.fn(async (..._args: unknown[]) => (deleteApplySnapshot(ROW_ID, root), { kind: "confirmed" as const, row: {} as never, detail: "Application submitted and marked applied." }));
  const photoTo = vi.fn(async (..._args: unknown[]) => undefined);

  const call = (suffix: string, method: string, headers: Record<string, string | undefined>, body?: unknown) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    return fetch(`${base}/apply/${token()}${suffix}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...h },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const status = async (data = GOOD()) =>
    (await call("/status", "GET", { "x-telegram-init-data": data })).json() as Promise<{ state: string; detail: string; missingRequired: string[] }>;
  const asUser = (extra: Record<string, string> = {}) => ({ "x-telegram-init-data": GOOD(), ...extra });

  beforeEach(async () => {
    vi.stubGlobal("fetch", (globalThis as { __realFetch?: typeof fetch }).__realFetch);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "founderos-apply-api-"));
    saveApplySnapshot(ready, root);
    sent.length = 0;
    submit.mockClear();
    photoTo.mockClear();
    clearAutoApplySessionsForTests();
    server = startJobsHealthServer(0, {
      now: () => NOW,
      env: { APPLY_LINK_SECRET: SECRET, APPLY_LINK_BASE_URL: "https://apply.example.test", JOBS_BOT_TOKEN: BOT, JOBHUNT_SENDER_PROFILES: "111=pushkar,222=wife" },
      root,
      senderFor: () => ({ text: async (html: string) => void sent.push(html) }),
      submit: submit as never,
      photoTo: photoTo as never,
    });
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  describe("authentication", () => {
    it("404s a missing header, forged hash, stale auth_date, unknown user and another profile, with one body", async () => {
      const cases: Array<string | undefined> = [
        undefined,
        initData(111, undefined, "999:other-bot"),
        initData(111, Math.floor(NOW / 1000) - 3601),
        initData(333),
        initData(222), // the wife: validly signed and mapped, but not the profile that owns this row
        "garbage",
      ];
      const bodies = new Set<string>();
      for (const data of cases) {
        for (const [suffix, method] of [["/status", "GET"], ["/submit", "POST"], ["/cancel", "POST"]] as const) {
          const res = await call(suffix, method, { "x-telegram-init-data": data }, method === "POST" ? { createdAt: CREATED } : undefined);
          expect(res.status, `${String(data).slice(0, 20)} ${suffix}`).toBe(404);
          bodies.add(await res.text());
        }
      }
      expect(bodies.size).toBe(1);
      expect(submit).not.toHaveBeenCalled();
      expect(loadApplySnapshot(ROW_ID, root)).not.toBeNull();
    });

    it("404s a bad link even with good initData, and 405s the wrong method", async () => {
      const res = await fetch(`${base}/apply/${token().slice(0, -3)}xyz/status`, { headers: { "x-telegram-init-data": GOOD() } });
      expect(res.status).toBe(404);
      expect((await call("/status", "POST", asUser())).status).toBe(405);
      expect((await call("/submit", "GET", asUser())).status).toBe(405);
      expect((await call("/nope", "GET", asUser())).status).toBe(404);
    });
  });

  describe("GET status", () => {
    it("is ready when nothing is missing, and sends no-store JSON", async () => {
      const res = await call("/status", "GET", asUser());
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({ state: "ready", missingRequired: [] });
    });

    it("is blocked with the required labels still open", async () => {
      saveApplySnapshot(blocked, root);
      expect(await status()).toMatchObject({ state: "blocked", missingRequired: ["Why Workwize?"] });
    });

    it("is blocked by a CAPTCHA", async () => {
      saveApplySnapshot({ ...ready, summary: { ...ready.summary, hasCaptcha: true } }, root);
      expect((await status()).state).toBe("blocked");
    });

    it("reports what holds the lock: preparing, refilling, submitting", async () => {
      for (const [phase, state] of [["prepare", "preparing"], ["refill", "refilling"], ["submit", "submitting"]] as const) {
        const release = tryLockApply(ROW_ID, NOW, phase);
        expect((await status()).state).toBe(state);
        release?.();
      }
    });

    it("is unconfirmed once an earlier Submit click had no confirmation, from the snapshot alone", async () => {
      saveApplySnapshot({ ...ready, unconfirmedAt: NOW - 1000 }, root);
      expect(await status()).toMatchObject({ state: "unconfirmed" });
    });

    it("keeps answering confirmed and cancelled after the snapshot is gone", async () => {
      deleteApplySnapshot(ROW_ID, root);
      expect((await call("/status", "GET", asUser())).status).toBe(404);
      recordOutcome(ROW_ID, PROFILE, "confirmed", "Application submitted and marked applied.");
      expect(await status()).toMatchObject({ state: "confirmed", detail: "Application submitted and marked applied." });
      recordOutcome(ROW_ID, PROFILE, "cancelled", "Cancelled.");
      expect((await status()).state).toBe("cancelled");
      expect((await status(initData(222))).state).toBeUndefined(); // another profile never reads it
    });
  });

  describe("POST submit", () => {
    const settle = () => new Promise((r) => setTimeout(r, 30));

    it("answers 202 and runs the shared Submit once for the row, chat and surface, then reports confirmed", async () => {
      const res = await call("/submit", "POST", asUser(), { createdAt: CREATED });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ state: "submitting" });
      await settle();
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0]?.slice(0, 3)).toEqual([ROW_ID, "777", "miniapp"]);
      expect((await status()).state).toBe("confirmed");
      expect(tryLockApply(ROW_ID, NOW)).not.toBeNull(); // lock released
    });

    it("refuses a page older than the snapshot, a blocked form and a missing stamp, sending nothing", async () => {
      expect((await call("/submit", "POST", asUser(), { createdAt: CREATED - 5 })).status).toBe(409);
      expect((await call("/submit", "POST", asUser(), {})).status).toBe(400);
      saveApplySnapshot(blocked, root);
      const res = await call("/submit", "POST", asUser(), { createdAt: CREATED });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ state: "blocked" });
      expect(submit).not.toHaveBeenCalled();
    });

    it("is 409 while another run holds the row lock, and does not send twice for two taps", async () => {
      const release = tryLockApply(ROW_ID, NOW, "refill");
      expect((await call("/submit", "POST", asUser(), { createdAt: CREATED })).status).toBe(409);
      release?.();
      submit.mockImplementationOnce(
        () => new Promise((r) => setTimeout(() => r({ kind: "confirmed", row: {} as never, detail: "ok" }), 60)) as never,
      );
      const [a, b] = await Promise.all([
        call("/submit", "POST", asUser(), { createdAt: CREATED }),
        call("/submit", "POST", asUser(), { createdAt: CREATED }),
      ]);
      expect([a.status, b.status].sort()).toEqual([202, 409]);
      await new Promise((r) => setTimeout(r, 100));
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("tells the chat and the page why a refused Submit did not go out", async () => {
      submit.mockResolvedValueOnce({ kind: "refused", toast: "Already submitted", html: "Already applied." } as never);
      expect((await call("/submit", "POST", asUser(), { createdAt: CREATED })).status).toBe(202);
      await settle();
      expect(sent).toContain("Already applied.");
      expect(await status()).toMatchObject({ state: "ready", detail: "Already submitted" });
    });

    it("keeps the failure reason on the page after a send that did not go out", async () => {
      submit.mockResolvedValueOnce({ kind: "failed", row: {} as never, detail: "form changed" } as never);
      await call("/submit", "POST", asUser(), { createdAt: CREATED });
      await settle();
      expect(await status()).toMatchObject({ state: "ready", detail: expect.stringContaining("form changed") });
    });

    it("does not report a failure when the chat message is lost after a sent application", async () => {
      submit.mockImplementationOnce((async (_r: string, _c: string, _v: string, io: { text: (h: string) => Promise<void> }) => {
        await io.text("hello");
        deleteApplySnapshot(ROW_ID, root);
        return { kind: "confirmed", row: {}, detail: "ok" };
      }) as never);
      const bad = startJobsHealthServer(0, {
        now: () => NOW,
        env: { APPLY_LINK_SECRET: SECRET, APPLY_LINK_BASE_URL: "https://apply.example.test", JOBS_BOT_TOKEN: BOT, JOBHUNT_SENDER_PROFILES: "111=pushkar" },
        root,
        senderFor: () => ({
          text: async () => {
            throw new Error("telegram down");
          },
        }),
        submit: submit as never,
        photoTo: photoTo as never,
      });
      if (!bad.listening) await new Promise<void>((resolve) => bad.once("listening", () => resolve()));
      const url = `http://127.0.0.1:${(bad.address() as AddressInfo).port}/apply/${token()}`;
      const res = await fetch(`${url}/submit`, {
        method: "POST",
        headers: { "x-telegram-init-data": GOOD(), "content-type": "application/json" },
        body: JSON.stringify({ createdAt: CREATED }),
      });
      expect(res.status).toBe(202);
      await settle();
      expect((await status()).state).toBe("confirmed");
      await new Promise<void>((resolve) => bad.close(() => resolve()));
    });
  });

  describe("POST cancel", () => {
    it("ends the session like the Telegram button: snapshot gone, chat told, status says cancelled", async () => {
      const res = await call("/cancel", "POST", asUser(), {});
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ state: "cancelled" });
      expect(loadApplySnapshot(ROW_ID, root)).toBeNull();
      expect(sent.some((t) => t.includes("Cancelled auto-apply"))).toBe(true);
      expect((await status()).state).toBe("cancelled");
      expect((await call("/cancel", "POST", asUser(), {})).status).toBe(200); // a second tap is harmless
    });

    it("is 409 while a Submit is running", async () => {
      const release = tryLockApply(ROW_ID, NOW, "submit");
      expect((await call("/cancel", "POST", asUser(), {})).status).toBe(409);
      expect(loadApplySnapshot(ROW_ID, root)).not.toBeNull();
      release?.();
    });
  });
});
