/**
 * Apply answer page: HTTP routes on the jobs health server
 * =========================================================
 * Drives a real node:http server on port 0 (loopback), a fixture snapshot on disk and injected
 * record / refill / sender fakes. Proves:
 *  1. /health is unchanged and nothing else is served.
 *  2. GET /apply/<token> renders the page for a genuine, unexpired link and 404s every other
 *     failure with the same body (bad signature, wrong profile, no snapshot, malformed, no config);
 *     an expired but genuine link is 410.
 *  3. POST saves only offered answers (unknown field, non-option value, wrong content type and an
 *     oversized body are refused and record nothing), then re-fills exactly once under the shared
 *     per-row lock (409 while another run holds it), and never submits.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplySnapshot } from "../../../src/tools/jobhunt/apply-link.js";

const ROW_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ROW = "99999999-2222-4333-8444-555555555555";
const SECRET = "s3cret-for-tests-0123456789abcdef";
const OTHER_SECRET = "another-secret-0123456789abcdef";
const PROFILE = "pushkar-nl-tech";
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const WHERE = "Are you based in The Netherlands or Ireland?";
const WHY = "Why Workwize?";
const OPTIONS = ["The Netherlands", "Ireland"];

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/db/client.js", () => ({ getPgPool: () => ({ query: async () => ({ rows: [] }) }) }));

const { startJobsHealthServer } = await import("../../../src/jobs/health.js");
const { saveApplySnapshot, signApplyToken } = await import("../../../src/tools/jobhunt/apply-link.js");
const { applyFieldName } = await import("../../../src/gateway/apply-page.js");
const { tryLockApply, clearAutoApplySessionsForTests } = await import("../../../src/gateway/apply-session.js");

const snapshot: ApplySnapshot = {
  rowId: ROW_ID,
  chatId: "777",
  profileId: PROFILE,
  company: "Workwize",
  title: "Automation Engineer",
  candidateName: "Pushkar Verma",
  targetUrl: "https://boards.example.test/workwize/1",
  platform: "ashby",
  resumePath: "cv-fixture.pdf",
  summary: {
    filled: 7,
    total: 10,
    hasCaptcha: false,
    filledLabels: ["Full name", "Email", "Résumé"],
    filledAnswers: [
      { label: "Full name", value: "Pushkar Verma", fieldType: "text", editable: true },
      { label: "Email", value: "fixture@example.com", fieldType: "text", editable: true },
      { label: "Résumé", value: "cv-fixture.pdf", fieldType: "file", editable: false },
    ],
    unanswered: [
      { label: WHERE, required: true, fieldType: "select", options: OPTIONS },
      { label: WHY, required: true, fieldType: "textarea" },
      { label: "Résumé upload", required: false, fieldType: "file" },
    ],
  },
  createdAt: NOW - 60_000,
};

const exp = (offsetSec: number): number => Math.floor(NOW / 1000) + offsetSec;
const tokenFor = (rowId = ROW_ID, profile = PROFILE, expUnix = exp(3600), secret = SECRET): string =>
  signApplyToken(secret, rowId, profile, expUnix);
const form = (pairs: Record<string, string>): string => new URLSearchParams(pairs).toString();
const URLENC = { "content-type": "application/x-www-form-urlencoded" };
/** True when no run holds the row lock (probes with the fixed clock the routes use, then lets go). */
const lockIsFree = (): boolean => {
  const held = tryLockApply(ROW_ID, NOW);
  held?.();
  return held !== null;
};

describe("apply answer page routes", () => {
  let root: string;
  let server: ReturnType<typeof startJobsHealthServer>;
  let base: string;
  const record = vi.fn(async (_profile: string, _label: string, _answer: string) => {});
  const refill = vi.fn(async (_snap: unknown, _posted: unknown, held: () => void, _send?: unknown) => {
    held();
  });
  const sent: string[] = [];
  const pushSent = async (html: string): Promise<void> => void sent.push(html);
  const sender = { text: pushSent };

  async function start(env: Record<string, string | undefined>): Promise<void> {
    server = startJobsHealthServer(0, {
      now: () => NOW,
      env,
      root,
      record,
      refill: refill as never,
      senderFor: () => sender,
    });
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeEach(async () => {
    vi.stubGlobal("fetch", (globalThis as { __realFetch?: typeof fetch }).__realFetch);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "founderos-apply-routes-"));
    saveApplySnapshot(snapshot, root);
    record.mockClear();
    refill.mockClear();
    refill.mockImplementation(async (_s, _p, held) => void held());
    sent.length = 0;
    sender.text = pushSent;
    clearAutoApplySessionsForTests();
    await start({ APPLY_LINK_SECRET: SECRET, APPLY_LINK_BASE_URL: "https://apply.example.test" });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  describe("existing routes", () => {
    it("keeps /health and serves nothing else", async () => {
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok", service: "jobs", db: true });
      expect((await fetch(`${base}/health`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${base}/other`)).status).toBe(404);
      expect((await fetch(`${base}/applying/${tokenFor()}`)).status).toBe(404);
    });
  });

  describe("GET /apply/<token>", () => {
    it("renders the page for a genuine link, with no-store and a strict CSP", async () => {
      const token = tokenFor();
      const res = await fetch(`${base}/apply/${token}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      const html = await res.text();
      expect(html).toContain("Workwize");
      expect(html).toContain(WHERE);
      expect(html).toContain(`name="${applyFieldName(WHY)}"`);
      expect(html).not.toContain(token);
      const csp = res.headers.get("content-security-policy") ?? "";
      const nonce = /script-src 'nonce-([^']+)' https:\/\/telegram\.org/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();
      expect(csp).toContain("connect-src 'self'");
      expect(html).toContain(`<script nonce="${nonce}" src="https://telegram.org/js/telegram-web-app.js">`);
      expect(html.match(/<script/g)).toHaveLength(2);
      expect(html.match(/<script(?![^>]*nonce=)/g)).toBeNull();
    });

    it("uses a fresh nonce for every page load", async () => {
      const token = tokenFor();
      const a = (await fetch(`${base}/apply/${token}`)).headers.get("content-security-policy");
      const b = (await fetch(`${base}/apply/${token}`)).headers.get("content-security-policy");
      expect(a).not.toBe(b);
    });

    it("prefills what the bot filled, so the form is not blank", async () => {
      const html = await (await fetch(`${base}/apply/${tokenFor()}`)).text();
      expect(html).toContain(`name="${applyFieldName("Email")}"`);
      expect(html).toContain(`value="fixture@example.com"`);
      expect(html).toContain(`value="Pushkar Verma"`);
      expect(html).toContain("CV attached: cv-fixture.pdf");
    });

    it("ignores a query string", async () => {
      expect((await fetch(`${base}/apply/${tokenFor()}?utm=1`)).status).toBe(200);
    });

    it("answers every failure with the same 404 page", async () => {
      const good = tokenFor();
      const tampered = `${good.slice(0, -2)}${good.endsWith("AA") ? "BB" : "AA"}`;
      const bad = [
        tampered,
        tokenFor(ROW_ID, "wife-nl-finance"), // genuine secret, wrong profile
        tokenFor(ROW_ID, PROFILE, exp(3600), OTHER_SECRET),
        tokenFor(OTHER_ROW), // genuine, but no snapshot
        "not-a-token",
        "%2e%2e%2fsecret",
        "",
      ];
      const bodies = new Set<string>();
      for (const t of bad) {
        const res = await fetch(`${base}/apply/${t}`);
        expect(res.status, t).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store");
        bodies.add(await res.text());
      }
      expect(bodies.size).toBe(1);
      // A cancelled or submitted session lands here too (2026-10-17 live test): say what to do, inside Telegram.
      expect([...bodies][0]).toContain("Run /apply again in Telegram");
    });

    it("is 410 for an expired link with a genuine signature, 404 once the signature is wrong", async () => {
      expect((await fetch(`${base}/apply/${tokenFor(ROW_ID, PROFILE, exp(-10))}`)).status).toBe(410);
      const forged = signApplyToken(OTHER_SECRET, ROW_ID, PROFILE, exp(-10));
      expect((await fetch(`${base}/apply/${forged}`)).status).toBe(404);
    });

    it("is 404 for everything when the link secret is not configured", async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await start({});
      expect((await fetch(`${base}/apply/${tokenFor()}`)).status).toBe(404);
    });

    it("refuses other methods with 405", async () => {
      const res = await fetch(`${base}/apply/${tokenFor()}`, { method: "PUT", body: "x" });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, POST");
    });
  });

  describe("POST /apply/<token>", () => {
    const post = (body: string, headers: Record<string, string> = URLENC, token = tokenFor()) =>
      fetch(`${base}/apply/${token}`, { method: "POST", headers, body });

    it("saves offered answers, re-fills once, and says so", async () => {
      const res = await post(form({ [applyFieldName(WHERE)]: "Ireland", [applyFieldName(WHY)]: "  I like automation.  " }));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Saved 2 answers.");
      expect(html).toContain("the updated card arrives in Telegram in about a minute");
      expect(record.mock.calls).toEqual([
        [PROFILE, WHERE, "Ireland"],
        [PROFILE, WHY, "I like automation."],
      ]);
      expect(refill).toHaveBeenCalledTimes(1);
      const call = refill.mock.calls[0] as unknown as [ApplySnapshot, { label: string; answer: string }[], () => void, unknown];
      expect(call[0].rowId).toBe(ROW_ID);
      expect(call[1]).toEqual([
        { label: WHERE, answer: "Ireland" },
        { label: WHY, answer: "I like automation." },
      ]);
      expect(call[3]).toBe(sender);
      expect(lockIsFree()).toBe(true); // the lock was released after the re-fill
    });

    it("posts a 💾 line to Telegram naming what was saved, labels only, before the re-fill", async () => {
      const order: string[] = [];
      refill.mockImplementation(async (_s, _p, held) => {
        order.push("refill");
        held();
      });
      sender.text = async (html: string) => {
        order.push("sent");
        sent.push(html);
      };
      const res = await post(form({ [applyFieldName(WHY)]: "Remote-first culture", [applyFieldName("Email")]: "new@example.com" }));
      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
      const line = sent.find((m) => m.startsWith("💾"));
      expect(line).toBeDefined();
      expect(line).toContain("Workwize");
      expect(line).toContain(WHY);
      expect(line).toContain("Email");
      expect(line).not.toContain("Remote-first");
      expect(line).not.toContain("new@example.com");
      expect(order).toEqual(["sent", "refill"]);
    });

    it("still re-fills when the 💾 line cannot be sent", async () => {
      sender.text = async () => {
        throw new Error("telegram down");
      };
      const res = await post(form({ [applyFieldName(WHY)]: "x" }));
      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
      expect(lockIsFree()).toBe(true);
    });

    it("says answer for one and skips empty fields", async () => {
      const res = await post(form({ [applyFieldName(WHERE)]: "Ireland", [applyFieldName(WHY)]: "   " }));
      expect(await res.text()).toContain("Saved 1 answer.");
      expect(record).toHaveBeenCalledTimes(1);
    });

    it("saves a changed filled value under its label and re-fills with it", async () => {
      const res = await post(form({ [applyFieldName("Full name")]: "Pushkar Verma", [applyFieldName("Email")]: "new@example.com" }));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Saved 1 answer.");
      expect(record.mock.calls).toEqual([[PROFILE, "Email", "new@example.com"]]);
      const call = refill.mock.calls[0] as unknown as [ApplySnapshot, { label: string; answer: string }[]];
      expect(call[1]).toEqual([{ label: "Email", answer: "new@example.com" }]);
    });

    it("saves nothing when the page is posted back with every filled value unchanged", async () => {
      const res = await post(form({ [applyFieldName("Full name")]: "Pushkar Verma", [applyFieldName("Email")]: "fixture@example.com" }));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Nothing new to save");
      expect(record).not.toHaveBeenCalled();
      expect(refill).not.toHaveBeenCalled();
    });

    it("refuses a post for the attached file", async () => {
      const res = await post(form({ [applyFieldName("Résumé")]: "evil.pdf" }));
      expect(res.status).toBe(400);
      expect(record).not.toHaveBeenCalled();
    });

    it("saves nothing and does not re-fill when every field is empty", async () => {
      const res = await post(form({ [applyFieldName(WHY)]: "" }));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Nothing new to save");
      expect(record).not.toHaveBeenCalled();
      expect(refill).not.toHaveBeenCalled();
    });

    it("refuses an unknown field, a non-option value and a read-only field, and records nothing", async () => {
      for (const body of [
        form({ q_deadbeefdeadbeef: "x" }),
        form({ [applyFieldName(WHERE)]: "Atlantis" }),
        form({ [applyFieldName("Résumé upload")]: "evil.pdf" }),
        form({ [applyFieldName(WHY)]: "ok", q_deadbeefdeadbeef: "x" }),
      ]) {
        const res = await post(body);
        expect(res.status, body).toBe(400);
      }
      expect(record).not.toHaveBeenCalled();
      expect(refill).not.toHaveBeenCalled();
      expect(lockIsFree()).toBe(true);
    });

    it("refuses a wrong content type with 415", async () => {
      const res = await post(JSON.stringify({ a: 1 }), { "content-type": "application/json" });
      expect(res.status).toBe(415);
      expect(record).not.toHaveBeenCalled();
    });

    it("refuses a body over 64 KB with 413", async () => {
      const res = await post(form({ [applyFieldName(WHY)]: "a".repeat(70_000) }));
      expect(res.status).toBe(413);
      expect(record).not.toHaveBeenCalled();
      expect(refill).not.toHaveBeenCalled();
    });

    it("404s a bad token and 410s an expired one without recording anything", async () => {
      const body = form({ [applyFieldName(WHY)]: "x" });
      expect((await post(body, URLENC, tokenFor(ROW_ID, "wife-nl-finance"))).status).toBe(404);
      expect((await post(body, URLENC, tokenFor(ROW_ID, PROFILE, exp(-10)))).status).toBe(410);
      expect(record).not.toHaveBeenCalled();
      expect(refill).not.toHaveBeenCalled();
    });

    it("is 409 while another run holds the row lock, and records nothing", async () => {
      const held = tryLockApply(ROW_ID, NOW);
      expect(held).not.toBeNull();
      const res = await post(form({ [applyFieldName(WHY)]: "x" }));
      expect(res.status).toBe(409);
      expect(await res.text()).toContain("already updating");
      expect(record).not.toHaveBeenCalled();
      expect(refill).not.toHaveBeenCalled();
      held?.();
      expect((await post(form({ [applyFieldName(WHY)]: "x" }))).status).toBe(200);
    });

    it("runs one re-fill when two posts race", async () => {
      let finish: () => void = () => {};
      refill.mockImplementation(
        (_s, _p, held) =>
          new Promise<void>((resolve) => {
            finish = () => {
              held();
              resolve();
            };
          }),
      );
      const body = form({ [applyFieldName(WHY)]: "x" });
      const first = await post(body);
      const second = await post(body);
      expect([first.status, second.status]).toEqual([200, 409]);
      expect(refill).toHaveBeenCalledTimes(1);
      finish();
    });

    it("releases the lock and answers 500 when saving fails", async () => {
      record.mockRejectedValueOnce(new Error("disk full"));
      const res = await post(form({ [applyFieldName(WHY)]: "x" }));
      expect(res.status).toBe(500);
      expect(refill).not.toHaveBeenCalled();
      expect(lockIsFree()).toBe(true);
    });

    it("tells the chat, and frees the lock, when the re-fill itself rejects", async () => {
      refill.mockImplementation(async () => {
        throw new Error("browser died");
      });
      const res = await post(form({ [applyFieldName(WHY)]: "x" }));
      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(sent.some((m) => m.includes("browser died"))).toBe(true));
      expect(lockIsFree()).toBe(true);
    });
  });
});
