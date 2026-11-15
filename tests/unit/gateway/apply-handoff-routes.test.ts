/**
 * Hand-off panel routes: /apply/<token>/handoff, /panel, /file/<kind>, /applied.
 * A real node:http server on port 0, a fixture snapshot on disk, fake profile and database reads. Proves:
 *  1. The shell answers 200 for a valid link and 404 for a forged one, 410 for an expired one.
 *  2. The panel, the files and "applied" need the link AND initData for the owning profile: anything else is the same 404.
 *  3. The panel carries the answers; it is read-only (no write path but "applied").
 *  4. "I applied" goes through markRowApplied's path (injected here) for the profile's row.
 */

import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplySnapshot } from "../../../src/tools/jobhunt/apply-link.js";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";

const ROW_ID = "11111111-2222-4333-8444-555555555555";
const SECRET = "s3cret-for-tests-0123456789abcdef";
const BOT = "123456:TEST-bot-token";
const PROFILE = "pushkar-nl-tech";
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/db/client.js", () => ({ getPgPool: () => ({ query: async () => ({ rows: [] }) }) }));

const { startJobsHealthServer } = await import("../../../src/jobs/health.js");
const { saveApplySnapshot, signApplyToken } = await import("../../../src/tools/jobhunt/apply-link.js");

const person: ApplyProfile = {
  first_name: "Ada", last_name: "Fixture", email: "ada@example.test", phone: "+31 6 00000000",
  question_bank: { "Why us?": "Because <b>reasons</b>" },
};

function initData(userId: number, authDate = Math.floor(NOW / 1000) - 60, token = BOT): string {
  const fields: Record<string, string> = { auth_date: String(authDate), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const token = (exp = Math.floor(NOW / 1000) + 3600): string => signApplyToken(SECRET, ROW_ID, PROFILE, exp);

describe("hand-off panel routes", () => {
  let root: string;
  let server: ReturnType<typeof startJobsHealthServer>;
  let base: string;
  let snap: ApplySnapshot;
  const markApplied = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, already: false }));
  const loadRow = vi.fn(async (..._a: unknown[]) => ({ id: ROW_ID, company: "Acme" }) as never);
  const readProfile = vi.fn(async (..._a: unknown[]): Promise<ApplyProfile | null> => person);

  const get = (suffix: string, init?: string, tok = token()) =>
    fetch(`${base}/apply/${tok}/handoff${suffix}`, { headers: init === undefined ? {} : { "x-telegram-init-data": init } });
  const post = (suffix: string, init?: string) =>
    fetch(`${base}/apply/${token()}/handoff${suffix}`, { method: "POST", headers: init === undefined ? {} : { "x-telegram-init-data": init } });

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "founderos-handoff-"));
    const cv = path.join(root, "cv-test.pdf");
    fs.writeFileSync(cv, "%PDF-1.4 cv fixture");
    snap = {
      rowId: ROW_ID, chatId: "777", profileId: PROFILE, company: "Acme", title: "Support Engineer", candidateName: "Ada Fixture",
      targetUrl: "https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/1", platform: "unsupported", resumePath: cv,
      summary: { filled: 0, total: 0, hasCaptcha: true, filledLabels: [], filledAnswers: [], unanswered: [] },
      handoffReason: "Workday requires per-company account creation and multi-step login",
      createdAt: NOW - 1000,
    };
    saveApplySnapshot(snap, root);
    for (const m of [markApplied, loadRow, readProfile]) m.mockClear();
    vi.stubGlobal("fetch", (globalThis as { __realFetch?: typeof fetch }).__realFetch);
    server = startJobsHealthServer(0, {
      now: () => NOW,
      env: { APPLY_LINK_SECRET: SECRET, APPLY_LINK_BASE_URL: "https://apply.example.test", JOBS_BOT_TOKEN: BOT, JOBHUNT_SENDER_PROFILES: "111=pushkar,222=wife" },
      root,
      senderFor: () => ({ text: async () => undefined }),
      handoff: { readProfile: readProfile as never, readDossier: async () => null, loadRow: loadRow as never, markApplied: markApplied as never },
    });
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  describe("the shell", () => {
    it("is 200 for a valid link, with a nonce'd CSP and no personal data", async () => {
      const res = await get("");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="ho-body"');
      expect(html).not.toContain("ada@example.test");
      expect(res.headers.get("content-security-policy")).toMatch(/script-src 'nonce-/);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("is 404 for a forged link and 410 for an expired genuine one", async () => {
      expect((await get("", undefined, token().slice(0, -3) + "xyz")).status).toBe(404);
      expect((await get("", undefined, token(Math.floor(NOW / 1000) - 10))).status).toBe(410);
    });

    it("is 404 when no snapshot exists for the row", async () => {
      fs.rmSync(path.join(root, "apply-pages"), { recursive: true, force: true });
      expect((await get("")).status).toBe(404);
    });
  });

  describe("authentication of the panel, the files and applied", () => {
    it("404s a missing header, a forged hash, a stale auth_date, an unknown user and another profile, with one body", async () => {
      const cases: Array<string | undefined> = [undefined, initData(111, undefined, "999:other-bot"), initData(111, Math.floor(NOW / 1000) - 3601), initData(333), initData(222), "garbage"];
      const bodies = new Set<string>();
      for (const data of cases) {
        for (const res of [await get("/panel", data), await get("/file/cv", data), await post("/applied", data)]) {
          expect(res.status).toBe(404);
          bodies.add((await res.text()).replace(/"error":"not found"/, "X"));
        }
      }
      expect(markApplied).not.toHaveBeenCalled();
      expect(readProfile).not.toHaveBeenCalled();
      expect(bodies.size).toBeLessThanOrEqual(2);
    });

    it("405s the wrong method and 404s an unknown path", async () => {
      expect((await post("/panel", initData(111))).status).toBe(405);
      expect((await get("/applied", initData(111))).status).toBe(405);
      expect((await get("/nope", initData(111))).status).toBe(404);
      expect((await get("/panel/extra", initData(111))).status).toBe(404);
    });
  });

  describe("the panel", () => {
    it("is 200 for a signed-in owner and carries the answers, escaped, with the Workday line and the CV link", async () => {
      const res = await get("/panel", initData(111));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Open the company's form");
      expect(html).toContain("ada@example.test");
      expect(html).toContain("Because &lt;b&gt;reasons&lt;/b&gt;");
      expect(html).not.toContain("<b>reasons");
      expect(html).toContain("Workday needs an account per company: sign in or create one with ada@example.test, then paste below");
      expect(html).toContain("Workday requires per-company account creation");
      expect(html).toContain('data-file="cv"');
      expect(html).not.toContain('data-file="letter"');
    });

    it("orders rows by the scraped form's field order and uses its labels", async () => {
      saveApplySnapshot({ ...snap, targetUrl: "https://jobs.example.test/acme/1", summary: { ...snap.summary, formFields: [{ label: "Your email", fieldType: "text" }, { label: "Given name", fieldType: "text" }] } }, root);
      const html = await (await get("/panel", initData(111))).text();
      expect(html.indexOf("Your email")).toBeGreaterThan(-1);
      expect(html.indexOf("Your email")).toBeLessThan(html.indexOf("Given name"));
      expect(html).not.toContain("Workday needs an account");
    });

    it("says there is no profile instead of failing when none is on file, and keeps the link", async () => {
      readProfile.mockResolvedValueOnce(null);
      const html = await (await get("/panel", initData(111))).text();
      expect(html).toContain("Open the company's form");
      expect(html).toContain("No usable apply profile");
    });
  });

  describe("files", () => {
    it("sends the tailored CV as a PDF attachment and 404s a kind that has no file", async () => {
      const res = await get("/file/cv", initData(111));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toContain('attachment; filename="cv-test.pdf"');
      expect(await res.text()).toContain("%PDF");
      expect((await get("/file/letter", initData(111))).status).toBe(404);
      expect((await get("/file/passwd", initData(111))).status).toBe(404);
    });
  });

  describe("I applied", () => {
    it("marks the owner's row through markRowApplied and says so", async () => {
      const res = await post("/applied", initData(111));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ state: "applied", already: false });
      expect(loadRow).toHaveBeenCalledWith(ROW_ID, PROFILE);
      expect(markApplied).toHaveBeenCalledTimes(1);
    });

    it("reports a row that is already applied without error, and a failed write as 500", async () => {
      markApplied.mockResolvedValueOnce({ ok: true as const, already: true } as never);
      expect(await (await post("/applied", initData(111))).json()).toEqual({ state: "applied", already: true });
      markApplied.mockResolvedValueOnce({ ok: false } as never);
      expect((await post("/applied", initData(111))).status).toBe(500);
    });

    it("404s when the role is no longer on file", async () => {
      loadRow.mockResolvedValueOnce(null as never);
      expect((await post("/applied", initData(111))).status).toBe(404);
      expect(markApplied).not.toHaveBeenCalled();
    });
  });
});
