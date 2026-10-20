/**
 * Saved-answers editor (Mini App): GET /apply/profile, GET and POST /apply/api/profile.
 * A real node:http server on port 0 and temp data roots (APPLY_PROFILE_PATH points at a temp dir). Proves:
 *  1. The API needs initData signed by the jobs bot for a known user: missing, forged, stale and unknown all 404.
 *  2. The profile comes from the signature, never the request: the wife's initData edits only wife-nl-finance.
 *  3. Each op goes through the answer store; a salary edit reaches the dossier Core Facts the forms read.
 *  4. A bad value is a 400 with the reason; a stale baseVersion is a 409 with the latest state and writes nothing.
 *  5. Restore brings back a backup; a body over 64 KB is a 413.
 *  6. The shell page carries a per-request nonce CSP with no unsafe-inline script and no server data.
 */

import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BOT = "123456:TEST-bot-token";
const FOUNDER = "pushkar-nl-tech";
const WIFE = "wife-nl-finance";
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/db/client.js", () => ({ getPgPool: () => ({ query: async () => ({ rows: [] }) }) }));

const { startJobsHealthServer } = await import("../../../src/jobs/health.js");
const { applyProfilePathFor, parseApplyProfile } = await import("../../../src/tools/jobhunt/apply-profile.js");
const { buildDefaultDossierMarkdown, candidateDossierPathFor } = await import("../../../src/tools/jobhunt/candidate-dossier.js");

function initData(userId: number, authDate = Math.floor(NOW / 1000) - 60, token = BOT): string {
  const fields: Record<string, string> = { auth_date: String(authDate), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const seedRaw = (first: string) => ({
  first_name: first,
  last_name: "Person",
  email: `${first.toLowerCase()}@example.com`,
  phone: "+31 6 00000000",
  answers: { work_authorization: "unknown", salary_floor_eur_year: 60000, notice_period_days: 30, willing_to_relocate: true },
});

describe("saved-answers editor", () => {
  let dir: string;
  let server: ReturnType<typeof startJobsHealthServer>;
  let base: string;
  const prev: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vi.stubGlobal("fetch", (globalThis as { __realFetch?: typeof fetch }).__realFetch);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "founderos-profile-editor-"));
    for (const k of ["APPLY_PROFILE_PATH", "FOUNDEROS_DATA_ROOT"]) prev[k] = process.env[k];
    process.env["FOUNDEROS_DATA_ROOT"] = dir;
    process.env["APPLY_PROFILE_PATH"] = path.join(dir, "apply-profile.json");
    for (const [id, first] of [[FOUNDER, "Pushkar"], [WIFE, "Tashi"]] as const) {
      const raw = seedRaw(first);
      fs.writeFileSync(applyProfilePathFor(id), JSON.stringify(raw, null, 2));
      const parsed = parseApplyProfile(JSON.stringify(raw));
      if (!parsed.ok) throw new Error(parsed.reason);
      fs.writeFileSync(candidateDossierPathFor(id), buildDefaultDossierMarkdown(parsed.profile));
    }
    server = startJobsHealthServer(0, {
      now: () => NOW,
      env: { APPLY_LINK_SECRET: "s3cret-for-tests-0123456789abcdef", APPLY_LINK_BASE_URL: "https://apply.example.test", JOBS_BOT_TOKEN: BOT, JOBHUNT_SENDER_PROFILES: "111=pushkar,222=wife" },
      root: dir,
    });
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const get = (data?: string) => fetch(`${base}/apply/api/profile`, { headers: data ? { "x-telegram-init-data": data } : {} });
  const post = (body: unknown, data = initData(111)) =>
    fetch(`${base}/apply/api/profile`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-init-data": data }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const load = async (data = initData(111)) => (await (await get(data)).json()) as Record<string, any>;
  const salaryOf = (id: string): unknown => JSON.parse(fs.readFileSync(applyProfilePathFor(id), "utf8")).answers.salary_floor_eur_year;

  describe("authentication", () => {
    it("404s a missing header, forged hash, stale auth_date and unknown user, on GET and POST, with one body", async () => {
      const cases: Array<string | undefined> = [undefined, initData(111, undefined, "999:other-bot"), initData(111, Math.floor(NOW / 1000) - 3601), initData(999)];
      const bodies = new Set<string>();
      for (const c of cases) {
        const g = await get(c);
        expect(g.status).toBe(404);
        bodies.add(await g.text());
        const p = await fetch(`${base}/apply/api/profile`, { method: "POST", headers: c ? { "x-telegram-init-data": c } : {}, body: "{}" });
        expect(p.status).toBe(404);
        bodies.add(await p.text());
      }
      expect(bodies.size).toBe(1);
    });
  });

  describe("GET", () => {
    it("returns the signed-in profile's core answers with allowed values, learned Q&A, Core Facts and backups", async () => {
      const s = await load();
      expect(s.profileId).toBe(FOUNDER);
      const wa = s.core.find((c: any) => c.field === "work_authorization");
      expect(wa.options).toEqual(["authorized-no-sponsorship", "requires-sponsorship", "unknown"]);
      expect(wa.value).toBe("unknown");
      expect(s.core.find((c: any) => c.field === "salary_floor_eur_year").value).toBe("60000");
      expect(s.eeo.map((e: any) => e.field)).toContain("self_identification.gender");
      expect(Array.isArray(s.learned)).toBe(true);
      expect(Array.isArray(s.coreFacts)).toBe(true);
      expect(s.backups).toEqual([]);
      expect(typeof s.version).toBe("string");
    });
  });

  describe("POST ops", () => {
    it("setCore saves and keeps the dossier Core Facts in step for salary", async () => {
      const s = await load();
      const r = await post({ op: "setCore", field: "salary_floor_eur_year", value: "72000", baseVersion: s.version });
      expect(r.status).toBe(200);
      const out = (await r.json()) as Record<string, any>;
      expect(out.summary).toContain("72000");
      expect(salaryOf(FOUNDER)).toBe(72000);
      const md = fs.readFileSync(candidateDossierPathFor(FOUNDER), "utf8");
      expect(md).toMatch(/72000/);
      expect(out.state.coreFacts.some((c: any) => /72000/.test(c.value))).toBe(true);
      expect(out.state.version).not.toBe(s.version);
      expect(out.state.backups.length).toBe(1);
    });

    it("setCore on a select and on an EEO choice (depth three) both save", async () => {
      let s = await load();
      let r = await post({ op: "setCore", field: "work_authorization", value: "authorized-no-sponsorship", baseVersion: s.version });
      expect(r.status).toBe(200);
      s = ((await r.json()) as any).state;
      r = await post({ op: "setCore", field: "self_identification.gender", value: "Prefer not to say", baseVersion: s.version });
      expect(r.status).toBe(200);
      const saved = JSON.parse(fs.readFileSync(applyProfilePathFor(FOUNDER), "utf8"));
      expect(saved.answers.work_authorization).toBe("authorized-no-sponsorship");
      expect(saved.answers.self_identification.gender).toBe("Prefer not to say");
    });

    it("upsertLearned then deleteLearned go through the store and show in the list", async () => {
      let s = await load();
      let r = await post({ op: "upsertLearned", question: "Favourite colour", answer: "Green", baseVersion: s.version });
      expect(r.status).toBe(200);
      s = ((await r.json()) as any).state;
      expect(s.learned.some((l: any) => l.question.toLowerCase().includes("favourite colour") && l.answer === "Green")).toBe(true);
      r = await post({ op: "deleteLearned", question: s.learned.find((l: any) => /colour/i.test(l.question)).question, baseVersion: s.version });
      expect(r.status).toBe(200);
      expect(((await r.json()) as any).state.learned.some((l: any) => /colour/i.test(l.question))).toBe(false);
    });

    it("restore brings the previous answers back", async () => {
      const s = await load();
      const saved = (await (await post({ op: "setCore", field: "salary_floor_eur_year", value: "99000", baseVersion: s.version })).json()) as any;
      expect(salaryOf(FOUNDER)).toBe(99000);
      const backupId = saved.state.backups[0].id as string;
      const r = await post({ op: "restore", backupId, baseVersion: saved.state.version });
      expect(r.status).toBe(200);
      expect(salaryOf(FOUNDER)).toBe(60000);
    });
  });

  describe("refusals", () => {
    it("400s a bad value with the reason and writes nothing", async () => {
      const s = await load();
      const before = fs.readFileSync(applyProfilePathFor(FOUNDER), "utf8");
      for (const bad of [
        { op: "setCore", field: "work_authorization", value: "maybe" },
        { op: "setCore", field: "salary_floor_eur_year", value: "lots" },
        { op: "setCore", field: "first_name", value: "x" },
        { op: "upsertLearned", question: "", answer: "x" },
        { op: "nope" },
      ]) {
        const r = await post({ ...bad, baseVersion: s.version });
        expect(r.status).toBe(400);
        expect(typeof ((await r.json()) as any).error).toBe("string");
      }
      expect(fs.readFileSync(applyProfilePathFor(FOUNDER), "utf8")).toBe(before);
    });

    it("409s a stale baseVersion with the latest state, and does not overwrite", async () => {
      const s = await load();
      expect((await post({ op: "setCore", field: "salary_floor_eur_year", value: "70000", baseVersion: s.version })).status).toBe(200);
      const r = await post({ op: "setCore", field: "salary_floor_eur_year", value: "80000", baseVersion: s.version });
      expect(r.status).toBe(409);
      const out = (await r.json()) as any;
      expect(out.stale).toBe(true);
      expect(out.state.core.find((c: any) => c.field === "salary_floor_eur_year").value).toBe("70000");
      expect(salaryOf(FOUNDER)).toBe(70000);
    });

    it("409s a stale restore", async () => {
      const s = await load();
      const first = (await (await post({ op: "setCore", field: "salary_floor_eur_year", value: "70000", baseVersion: s.version })).json()) as any;
      const r = await post({ op: "restore", backupId: first.state.backups[0].id, baseVersion: s.version });
      expect(r.status).toBe(409);
      expect(salaryOf(FOUNDER)).toBe(70000);
    });

    it("400s a missing baseVersion and malformed JSON", async () => {
      expect((await post({ op: "setCore", field: "notice_period_days", value: "10" })).status).toBe(400);
      expect((await post("{not json")).status).toBe(400);
    });

    it("413s a body over 64 KB", async () => {
      const s = await load();
      const r = await post({ op: "upsertLearned", question: "q", answer: "a".repeat(70_000), baseVersion: s.version });
      expect(r.status).toBe(413);
    });
  });

  describe("whose answers", () => {
    it("the wife's initData reads and edits only wife-nl-finance", async () => {
      const wife = initData(222);
      const s = await load(wife);
      expect(s.profileId).toBe(WIFE);
      const r = await post({ op: "setCore", field: "salary_floor_eur_year", value: "55000", baseVersion: s.version }, wife);
      expect(r.status).toBe(200);
      expect(salaryOf(WIFE)).toBe(55000);
      expect(salaryOf(FOUNDER)).toBe(60000);
      // A profile named in the body is ignored: the signature decides.
      const r2 = await post({ op: "setCore", field: "salary_floor_eur_year", value: "1", profileId: FOUNDER, baseVersion: ((await r.json()) as any).state.version }, wife);
      expect(r2.status).toBe(200);
      expect(salaryOf(FOUNDER)).toBe(60000);
    });
  });

  describe("shell page", () => {
    it("serves a nonce CSP with no unsafe-inline script, matching nonces, and no answers data", async () => {
      const a = await fetch(`${base}/apply/profile`);
      expect(a.status).toBe(200);
      const csp = a.headers.get("content-security-policy") ?? "";
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();
      expect(csp).toMatch(/script-src[^;]*https:\/\/telegram\.org/);
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("default-src 'none'");
      const html = await a.text();
      expect(html).toContain(`<script nonce="${nonce}" src="https://telegram.org/js/telegram-web-app.js">`);
      expect(html.match(/<script nonce="/g)?.length).toBe(2);
      expect(html).not.toContain("@example.com");
      const b = await fetch(`${base}/apply/profile`);
      expect(/script-src 'nonce-([^']+)'/.exec(b.headers.get("content-security-policy") ?? "")?.[1]).not.toBe(nonce);
    });

    it("script text uses no innerHTML", async () => {
      const { PROFILE_PAGE_SCRIPT } = await import("../../../src/gateway/profile-page-script.js");
      expect(PROFILE_PAGE_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
      expect(PROFILE_PAGE_SCRIPT).toContain("X-Telegram-Init-Data");
    });

    it("hints that the notice detail wins, on the days field only", async () => {
      const { PROFILE_PAGE_SCRIPT } = await import("../../../src/gateway/profile-page-script.js");
      const hint = "While the detail below is filled in, forms use the detail, not this number.";
      expect(PROFILE_PAGE_SCRIPT.split(hint).length - 1).toBe(1);
      const line = PROFILE_PAGE_SCRIPT.split("\n").find((l) => l.includes(hint)) ?? "";
      expect(line).toContain("notice_period_days");
    });
  });
});
