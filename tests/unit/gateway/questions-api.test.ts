/**
 * Answer bank (Mini App): GET /apply/questions, GET and POST /apply/api/questions, and the /questions command.
 * Real node:http server on port 0, temp data root, the needs_you rows mocked. Invented people only.
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
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/db/client.js", () => ({ getPgPool: () => ({ query: async () => ({ rows: [] }) }) }));
const rowsFor = vi.hoisted(() => vi.fn());
vi.mock("../../../src/db/job-apply-lane-queries.js", () => ({ listNeedsYouReasons: rowsFor }));

const { startJobsHealthServer } = await import("../../../src/jobs/health.js");
const { applyProfilePathFor, parseApplyProfile } = await import("../../../src/tools/jobhunt/apply-profile.js");
const { buildDefaultDossierMarkdown, candidateDossierPathFor } = await import("../../../src/tools/jobhunt/candidate-dossier.js");
const { handleQuestions } = await import("../../../src/gateway/questions-command.js");
const { renderQuestionsPage } = await import("../../../src/gateway/questions-page.js");

function initData(userId: number): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(NOW / 1000) - 60), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const hash = createHmac("sha256", createHmac("sha256", "WebAppData").update(BOT).digest()).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const reason = (...labels: string[]) => `${labels.length} required question(s) unanswered: ${labels.join("; ")}`;
const ROWS = [
  { id: "r1", company: "Acme", reason: reason("Years of Python experience", "Why do you want to work at Acme?", "Gender") },
  { id: "r2", company: "Birch", reason: reason("years of python experience?", "Why do you want to work at Birch?") },
  { id: "r3", company: "Cedar", reason: reason("Favourite editor", "Pronouns used") },
];

describe("answer bank", () => {
  let dir: string;
  let server: ReturnType<typeof startJobsHealthServer>;
  let base: string;
  const prev: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vi.stubGlobal("fetch", (globalThis as { __realFetch?: typeof fetch }).__realFetch);
    rowsFor.mockReset();
    rowsFor.mockResolvedValue(ROWS);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "founderos-questions-"));
    for (const k of ["APPLY_PROFILE_PATH", "FOUNDEROS_DATA_ROOT", "APPLY_LINK_SECRET", "APPLY_LINK_BASE_URL", "JOBHUNT_SENDER_PROFILES"]) prev[k] = process.env[k];
    process.env["FOUNDEROS_DATA_ROOT"] = dir;
    process.env["APPLY_PROFILE_PATH"] = path.join(dir, "apply-profile.json");
    process.env["APPLY_LINK_SECRET"] = "s3cret-for-tests-0123456789abcdef";
    process.env["APPLY_LINK_BASE_URL"] = "https://apply.example.test";
    process.env["JOBHUNT_SENDER_PROFILES"] = "111=pushkar,222=wife";
    for (const [id, first] of [[FOUNDER, "Ada"], [WIFE, "Bea"]] as const) {
      const raw = { first_name: first, last_name: "Person", email: `${first.toLowerCase()}@example.com`, phone: "+31 6 00000000", answers: { work_authorization: "unknown", salary_floor_eur_year: 60000 } };
      fs.writeFileSync(applyProfilePathFor(id), JSON.stringify(raw));
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

  const get = (data?: string) => fetch(`${base}/apply/api/questions`, { headers: data ? { "x-telegram-init-data": data } : {} });
  const post = (body: unknown, data = initData(111)) =>
    fetch(`${base}/apply/api/questions`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-init-data": data }, body: JSON.stringify(body) });
  const load = async (data = initData(111)) => (await (await get(data)).json()) as Record<string, any>;

  it("404s without valid initData on GET and POST, with one body", async () => {
    const a = await get(undefined);
    const b = await fetch(`${base}/apply/api/questions`, { method: "POST", body: "{}" });
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(await a.text()).toBe(await b.text());
  });

  it("lists clustered questions by roles blocked, a company template once, profile fields apart", async () => {
    const s = await load();
    expect(s.summary).toBe("4 questions block 3 roles");
    expect(s.questions[0]).toEqual({ label: expect.stringMatching(/python/i), roles: 2, template: false });
    expect(s.questions.filter((q: any) => q.template)).toEqual([{ label: "Why do you want to work at [company]?", roles: 2, template: true }]);
    expect(s.profileFields).toEqual([{ label: "Gender", roles: 1 }]);
    expect(JSON.stringify(s)).not.toContain("ada@example.com");
    expect(rowsFor.mock.calls[0]![0]).toBe(FOUNDER);
  });

  it("asks for the profile the signature names, not another", async () => {
    await load(initData(222));
    expect(rowsFor.mock.calls[0]![0]).toBe(WIFE);
  });

  it("Save writes through the answer store, then the question drops off and the next pass can fill it", async () => {
    const s = await load();
    const r = await post({ question: "Favourite editor", answer: "Neovim", baseVersion: s.version });
    expect(r.status).toBe(200);
    const out = (await r.json()) as Record<string, any>;
    expect(out.state.questions.map((q: any) => q.label)).not.toContain("Favourite editor");
    expect(out.state.summary).toBe("3 questions block 3 roles");
    const bank = JSON.parse(fs.readFileSync(applyProfilePathFor(FOUNDER), "utf8")).question_bank;
    expect(Object.values(bank)).toContain("Neovim");
    expect(fs.readFileSync(candidateDossierPathFor(FOUNDER), "utf8")).toContain("Neovim");
    expect(fs.readFileSync(applyProfilePathFor(WIFE), "utf8")).not.toContain("Neovim");
  });

  it("refuses a stale version with 409, an empty answer and a company template with 400", async () => {
    const s = await load();
    expect((await post({ question: "Favourite editor", answer: "Neovim", baseVersion: "old" })).status).toBe(409);
    expect((await post({ question: "Favourite editor", answer: " ", baseVersion: s.version })).status).toBe(400);
    expect((await post({ question: "Why do you want to work at [company]?", answer: "Because", baseVersion: s.version })).status).toBe(400);
    expect((await post({ question: "Favourite editor", answer: "x" })).status).toBe(400);
    expect((await post({ question: "Will you now or in the future require visa sponsorship?", answer: "No", baseVersion: s.version })).status).toBe(400);
    expect((await post({ question: "What is your gender?", answer: "Prefer not to say", baseVersion: s.version })).status).toBe(400);
  });

  it("serves a shell page with a nonce CSP, no unsafe-inline script and no data", async () => {
    const r = await fetch(`${base}/apply/questions`);
    const csp = r.headers.get("content-security-policy") ?? "";
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(csp).toMatch(/script-src 'nonce-[^']+' https:\/\/telegram\.org/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(html).not.toContain("Python");
    expect(html).not.toMatch(/innerHTML/);
  });

  it("escapes the nonce in the page", () => {
    expect(renderQuestionsPage('a"><b>')).not.toContain('"><b>');
  });

  describe("/questions command", () => {
    async function run(match: string, chatId: number, userId: number) {
      const sent: Array<{ text: string; opts: any }> = [];
      const ctx = { match, chat: { id: chatId }, from: { id: userId }, reply: async (text: string, opts?: unknown) => void sent.push({ text, opts }) };
      await handleQuestions(ctx as never, { rows: rowsFor, snapshot: () => null });
      return sent[0]!;
    }

    it("replies with the count and a web_app button in a private chat", async () => {
      const m = await run("", 111, 111);
      expect(m.text).toContain("4 questions block 3 roles");
      expect(m.text).toContain("1 more are eligibility or self-identification");
      expect(m.opts.reply_markup.inline_keyboard[0][0]).toEqual({ text: "Answer questions", web_app: { url: "https://apply.example.test/apply/questions" } });
    });

    it("the wife alias runs against her profile", async () => {
      const m = await run("wife", 222, 222);
      expect(m.opts.reply_markup.inline_keyboard[0][0].web_app.url).toContain("/apply/questions");
      expect(rowsFor.mock.calls.at(-1)![0]).toBe(WIFE);
    });

    it("a group chat gets the top questions as text instead of a button, escaped", async () => {
      rowsFor.mockResolvedValue([{ id: "r9", company: "Acme", reason: reason("Is <b>this</b> ok") }]);
      const m = await run("", -5319642142, 111);
      expect(m.opts.reply_markup).toBeUndefined();
      expect(m.text).toContain("Is &lt;b&gt;this&lt;/b&gt; ok");
    });

    it("says so when nothing is open", async () => {
      rowsFor.mockResolvedValue([]);
      expect((await run("", 111, 111)).text).toContain("0 questions block 0 roles");
    });
  });
});
