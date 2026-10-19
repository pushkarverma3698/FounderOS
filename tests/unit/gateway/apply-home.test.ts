/**
 * Mini App job list: GET /apply/home, GET /apply/api/jobs, POST /apply/api/prepare/<id>, GET /apply/api/job-status/<id>.
 * A real node:http server on port 0 with fake queue/prepare deps. Proves:
 *  1. The shell has a per-request script nonce and no unsafe-inline script; it carries no user data.
 *  2. Every /api call needs initData: missing, forged, unknown user and the wrong profile's row all get the same 404.
 *  3. The wife's profile never sees the founder's rows, in the list or by id.
 *  4. Prepare answers 202, takes the per-row lock before answering, and a second tap is a 409 with the state.
 *  5. job-status carries the signed answer-page URL once a form is ready, and a failed prepare says why.
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
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const FOUNDER_ROW = "11111111-2222-4333-8444-555555555555";
const FOUNDER_ROW_2 = "11111111-2222-4333-8444-666666666666";
const WIFE_ROW = "99999999-2222-4333-8444-555555555555";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/db/client.js", () => ({ getPgPool: () => ({ query: async () => ({ rows: [] }) }) }));

const { startJobsHealthServer } = await import("../../../src/jobs/health.js");
const { saveApplySnapshot } = await import("../../../src/tools/jobhunt/apply-link.js");
const { clearAutoApplySessionsForTests, lockPhase } = await import("../../../src/gateway/apply-session.js");
const { clearPrepareFailuresForTests } = await import("../../../src/gateway/apply-prepare-api.js");

const row = (id: string, profile: string, company: string, rank: number, section = "do_today"): JobApplication =>
  ({ id, profile_id: profile, tenant_id: "turicks", company, title: `${company} Engineer`, brief_rank: rank, brief_section: section }) as unknown as JobApplication;
const ASK_ROW = "11111111-2222-4333-8444-777777777777";
const ROWS = [
  row(FOUNDER_ROW, "pushkar-nl-tech", "Workwize", 1),
  row(FOUNDER_ROW_2, "pushkar-nl-tech", "Mollie", 2),
  row(WIFE_ROW, "wife-nl-finance", "ING", 1),
  row(ASK_ROW, "pushkar-nl-tech", "Adyen", 37, "ask"),
];

function initData(userId: number, token = BOT): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(NOW / 1000) - 60), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const hash = createHmac("sha256", createHmac("sha256", "WebAppData").update(token).digest()).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
const FOUNDER = (): string => initData(111);
const WIFE = (): string => initData(222);

describe("Mini App job list", () => {
  let root: string;
  let server: ReturnType<typeof startJobsHealthServer>;
  let base: string;
  const sent: string[] = [];
  let release: () => void;
  const prepare = vi.fn(async (..._args: unknown[]): Promise<{ kind: string; reason?: string; html?: string; detail?: string }> => {
    await new Promise<void>((resolve) => (release = resolve));
    return { kind: "started" };
  });

  const call = (p: string, method = "GET", data?: string) =>
    fetch(`${base}${p}`, { method, headers: data === undefined ? {} : { "x-telegram-init-data": data } });

  beforeEach(async () => {
    vi.stubGlobal("fetch", (globalThis as { __realFetch?: typeof fetch }).__realFetch);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "founderos-apply-home-"));
    sent.length = 0;
    prepare.mockClear();
    clearAutoApplySessionsForTests();
    clearPrepareFailuresForTests();
    server = startJobsHealthServer(0, {
      now: () => NOW,
      env: { APPLY_LINK_SECRET: SECRET, APPLY_LINK_BASE_URL: "https://apply.example.test", JOBS_BOT_TOKEN: BOT, JOBHUNT_SENDER_PROFILES: "111=pushkar,222=wife" },
      root,
      senderFor: () => ({ text: async (html: string) => void sent.push(html) }),
      jobs: {
        listQueue: async (profile: { id: string }) => ROWS.filter((r) => r.profile_id === profile.id),
        getRow: async (id: string) => ROWS.find((r) => r.id === id) ?? null,
        prepare: prepare as never,
      },
    });
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    release?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  describe("GET /apply/home", () => {
    it("serves a shell with a per-request nonce, no unsafe-inline script, and no user data", async () => {
      const a = await call("/apply/home");
      const b = await call("/apply/home");
      expect(a.status).toBe(200);
      const csp = a.headers.get("content-security-policy") ?? "";
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("unsafe-eval");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("default-src 'none'");
      const html = await a.text();
      expect(html).toContain(`<script nonce="${nonce}" src="https://telegram.org/js/telegram-web-app.js">`);
      expect(html).toContain(`<script nonce="${nonce}">`);
      expect(html).not.toMatch(/onclick=|innerHTML/);
      expect(html).not.toContain("Workwize");
      const other = /script-src 'nonce-([^']+)'/.exec(b.headers.get("content-security-policy") ?? "")?.[1];
      expect(other).not.toBe(nonce);
    });

    it("refuses other methods", async () => {
      expect((await call("/apply/home", "POST")).status).toBe(405);
    });
  });

  describe("authentication", () => {
    it("404s a missing header, forged hash, unknown user and garbage on every endpoint, with one body", async () => {
      const cases: Array<string | undefined> = [undefined, initData(111, "999:other-bot"), initData(333), "garbage"];
      const bodies = new Set<string>();
      for (const data of cases) {
        for (const [p, method] of [
          ["/apply/api/jobs", "GET"],
          [`/apply/api/prepare/${FOUNDER_ROW}`, "POST"],
          [`/apply/api/job-status/${FOUNDER_ROW}`, "GET"],
        ] as const) {
          const res = await call(p, method, data);
          expect(res.status, `${String(data).slice(0, 12)} ${p}`).toBe(404);
          bodies.add(await res.text());
        }
      }
      expect(bodies.size).toBe(1);
      expect(prepare).not.toHaveBeenCalled();
    });

    it("404s the wife on the founder's row, and an unknown or malformed id for the founder", async () => {
      for (const [p, method] of [
        [`/apply/api/prepare/${FOUNDER_ROW}`, "POST"],
        [`/apply/api/job-status/${FOUNDER_ROW}`, "GET"],
      ] as const) {
        expect((await call(p, method, WIFE())).status).toBe(404);
      }
      expect((await call("/apply/api/prepare/not-a-uuid", "POST", FOUNDER())).status).toBe(404);
      expect((await call("/apply/api/job-status/00000000-0000-4000-8000-000000000000", "GET", FOUNDER())).status).toBe(404);
      expect(prepare).not.toHaveBeenCalled();
      expect(lockPhase(FOUNDER_ROW, NOW)).toBeNull();
    });

    it("rejects the wrong method with 405 and an unknown api path with 404", async () => {
      expect((await call("/apply/api/jobs", "POST", FOUNDER())).status).toBe(405);
      expect((await call(`/apply/api/prepare/${FOUNDER_ROW}`, "GET", FOUNDER())).status).toBe(405);
      expect((await call("/apply/api/nope", "GET", FOUNDER())).status).toBe(404);
    });
  });

  describe("GET /apply/api/jobs", () => {
    it("lists only the signed-in profile's rows, in rank order, with the running state", async () => {
      saveApplySnapshot(
        {
          rowId: FOUNDER_ROW, chatId: "111", profileId: "pushkar-nl-tech", company: "Workwize", title: "Workwize Engineer",
          candidateName: "P", targetUrl: "https://x.test", platform: "ashby", resumePath: "cv.pdf",
          summary: { filled: 1, total: 1, hasCaptcha: false, filledLabels: [], filledAnswers: [], unanswered: [] }, createdAt: NOW - 1000,
        } satisfies ApplySnapshot,
        root,
      );
      const founder = (await (await call("/apply/api/jobs", "GET", FOUNDER())).json()) as { jobs: Array<{ id: string; rank: number; company: string; title: string; state: string }> };
      expect(founder.jobs.map((j) => j.company)).toEqual(["Workwize", "Mollie", "Adyen"]);
      expect(founder.jobs.map((j) => (j as { section?: string }).section)).toEqual(["do_today", "do_today", "ask"]);
      expect(founder.jobs[0]).toMatchObject({ id: FOUNDER_ROW, rank: 1, title: "Workwize Engineer", state: "ready" });
      expect(founder.jobs[1]?.state).toBe("idle");
      const wife = (await (await call("/apply/api/jobs", "GET", WIFE())).json()) as { jobs: Array<{ company: string }> };
      expect(wife.jobs.map((j) => j.company)).toEqual(["ING"]);
    });
  });

  describe("ask rows", () => {
    it("the default queue dependency asks for the ask section as well as the applyable ones", async () => {
      const queries = await import("../../../src/db/apply-queries.js");
      expect(queries.HOME_SECTIONS).toEqual([...queries.APPLYABLE_SECTIONS, "ask"]);
      expect(queries.APPLYABLE_SECTIONS).not.toContain("ask");
    });

    it("prepare and job-status accept an ask row for its owner and 404 it for the other profile", async () => {
      expect((await call(`/apply/api/job-status/${ASK_ROW}`, "GET", WIFE())).status).toBe(404);
      expect((await call(`/apply/api/job-status/${ASK_ROW}`, "GET", FOUNDER())).status).toBe(200);
      expect((await call(`/apply/api/prepare/${ASK_ROW}`, "POST", FOUNDER())).status).toBe(202);
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    });
  });

  describe("home shell script", () => {
    it("has a filter input, a count, a 'Needs your call' group, and writes only through textContent", async () => {
      const html = await (await call("/apply/home")).text();
      expect(html).toContain('id="filter"');
      expect(html).toContain('id="count"');
      expect(html).toContain("Needs your call");
      expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    });

    it("the script parses and filters on company or title, case-insensitively", async () => {
      const { APPLY_HOME_SCRIPT } = await import("../../../src/gateway/apply-home-script.js");
      expect(() => new Function(APPLY_HOME_SCRIPT)).not.toThrow();
      expect(APPLY_HOME_SCRIPT).toContain("toLowerCase");
      expect(APPLY_HOME_SCRIPT).toMatch(/jobs"/);
    });
  });

  describe("POST /apply/api/prepare/<id>", () => {
    it("answers 202, holds the lock while preparing, and answers a second tap with 409 and the state", async () => {
      const first = await call(`/apply/api/prepare/${FOUNDER_ROW}`, "POST", FOUNDER());
      expect(first.status).toBe(202);
      expect(lockPhase(FOUNDER_ROW, NOW)).toBe("prepare");
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
      const args = prepare.mock.calls[0] as unknown[];
      expect((args[0] as JobApplication).id).toBe(FOUNDER_ROW);
      expect(args[2]).toBe("111");
      expect(typeof (args[4] as { held: unknown }).held).toBe("function");

      const second = await call(`/apply/api/prepare/${FOUNDER_ROW}`, "POST", FOUNDER());
      expect(second.status).toBe(409);
      expect(((await second.json()) as { state: string }).state).toBe("preparing");
      expect(prepare).toHaveBeenCalledTimes(1);

      const polled = (await (await call(`/apply/api/job-status/${FOUNDER_ROW}`, "GET", FOUNDER())).json()) as { state: string; url?: string };
      expect(polled.state).toBe("preparing");
      expect(polled.url).toBeUndefined();
    });

    it("hands the form's signed answer-page URL to job-status once the snapshot is saved", async () => {
      expect((await call(`/apply/api/prepare/${FOUNDER_ROW}`, "POST", FOUNDER())).status).toBe(202);
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
      saveApplySnapshot(
        {
          rowId: FOUNDER_ROW, chatId: "111", profileId: "pushkar-nl-tech", company: "Workwize", title: "Workwize Engineer",
          candidateName: "P", targetUrl: "https://x.test", platform: "ashby", resumePath: "cv.pdf",
          summary: { filled: 1, total: 1, hasCaptcha: false, filledLabels: [], filledAnswers: [], unanswered: [] }, createdAt: NOW,
        } satisfies ApplySnapshot,
        root,
      );
      // Still running: no URL yet, even though a snapshot exists.
      expect(((await (await call(`/apply/api/job-status/${FOUNDER_ROW}`, "GET", FOUNDER())).json()) as { url?: string }).url).toBeUndefined();
      // prepareRow releases the lock it was handed; the fake does not, so release it as the real one does.
      (prepare.mock.calls[0]?.[4] as { held: () => void }).held();
      release();
      const done = (await (await call(`/apply/api/job-status/${FOUNDER_ROW}`, "GET", FOUNDER())).json()) as { state: string; url?: string };
      expect(done.state).toBe("ready");
      expect(done.url).toMatch(new RegExp(`^https://apply\\.example\\.test/apply/${FOUNDER_ROW}\\.\\d+\\.[A-Za-z0-9_-]+$`));
    });

    it("reports a refused prepare as failed, with the reason, and a crash to the chat", async () => {
      prepare.mockImplementationOnce(async (...args: unknown[]) => {
        (args[4] as { held: () => void }).held();
        return { kind: "refused" as const, reason: "no-resume" as const, html: "x", detail: "Cannot start: no resume on file." };
      });
      expect((await call(`/apply/api/prepare/${FOUNDER_ROW}`, "POST", FOUNDER())).status).toBe(202);
      await vi.waitFor(async () => {
        const s = (await (await call(`/apply/api/job-status/${FOUNDER_ROW}`, "GET", FOUNDER())).json()) as { state: string; detail: string };
        expect(s).toEqual({ state: "failed", detail: "Cannot start: no resume on file." });
      });

      prepare.mockImplementationOnce(async (...args: unknown[]) => {
        (args[4] as { held: () => void }).held();
        throw new Error("browser died");
      });
      expect((await call(`/apply/api/prepare/${FOUNDER_ROW_2}`, "POST", FOUNDER())).status).toBe(202);
      await vi.waitFor(() => expect(sent.some((m) => m.includes("browser died"))).toBe(true));
      const s2 = (await (await call(`/apply/api/job-status/${FOUNDER_ROW_2}`, "GET", FOUNDER())).json()) as { state: string; detail: string };
      expect(s2.state).toBe("failed");
      expect(s2.detail).toContain("browser died");
    });
  });
});
