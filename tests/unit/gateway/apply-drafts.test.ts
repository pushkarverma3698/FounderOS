/**
 * Suggested answers in the Telegram question flow: shown under the question, saved only on the tap,
 * and the tap goes through the same path as a typed answer.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnansweredQuestion } from "../../../src/tools/jobhunt/form-brain.js";
import type { prepareApplicationForm } from "../../../src/tools/jobhunt/form-runner.js";

const ROW_ID = "11111111-2222-4333-8444-555555555555";
const PROFILE = "pushkar-nl-tech";
const LABEL = "Years of AWS experience";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/db/queries.js", () => ({ hasBeenAudited: async () => false, writeAuditEntry: async () => ({ written: true }) }));
vi.mock("../../../src/db/apply-queries.js", () => ({ getApplicationById: async () => ROW }));

const ROW = { id: ROW_ID, company: "Acme", title: "Engineer", url: "https://jobs.lever.co/acme/1", profile_id: PROFILE, track: "fullstack", stage: "screened" };

const { handleAutoApplyCallback, setAutoApplyRunnerForTests, clearAutoApplySessionsForTests } = await import("../../../src/gateway/auto-apply.js");
const { buildQuestionKeyboard } = await import("../../../src/gateway/apply-flow.js");
const { draftLines, draftSourceText } = await import("../../../src/gateway/apply-drafts.js");
const { readCandidateDossier } = await import("../../../src/tools/jobhunt/candidate-dossier.js");

type Prep = Awaited<ReturnType<typeof prepareApplicationForm>>;
type Btn = { text: string; callback_data?: string };

const ask: UnansweredQuestion = { selector: "#q", label: LABEL, kind: "ask", question: LABEL, required: true, fieldType: "text", why: "not yet in dossier" };

function prep(): Prep {
  return {
    ok: true, platform: "lever", targetUrl: ROW.url, screenshotPng: Buffer.from("png"),
    summary: { filled: 2, total: 3, filledLabels: [], filledAnswers: [], unanswered: [ask], requiredUnanswered: [ask], hasCaptcha: false, readyToSubmit: false },
  };
}

const buttons = (extra?: Record<string, unknown>): Btn[] =>
  ((extra?.["reply_markup"] as { inline_keyboard?: Btn[][] } | undefined)?.inline_keyboard ?? []).flat();

function makeCtx() {
  const replies: { text: string; extra?: Record<string, unknown> }[] = [];
  const ctx = {
    chat: { id: 888, type: "private" }, from: { id: 1 }, match: "",
    reply: vi.fn(async (text: string, extra?: Record<string, unknown>) => void replies.push({ text, extra })),
    replyWithPhoto: vi.fn(), answerCallbackQuery: vi.fn(async () => undefined), editMessageReplyMarkup: vi.fn(async () => undefined),
  };
  return { ctx, replies };
}

const ENV = ["APPLY_PROFILE_PATH", "CANDIDATE_DOSSIER_PATH", "FOUNDEROS_DATA_ROOT"];
let tmp: string;
let saved: Record<string, string | undefined>;

describe("suggested answers", () => {
  beforeEach(async () => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-drafts-"));
    process.env["APPLY_PROFILE_PATH"] = path.join(tmp, "apply-profile.json");
    process.env["FOUNDEROS_DATA_ROOT"] = tmp;
    delete process.env["CANDIDATE_DOSSIER_PATH"];
    const resume = path.join(tmp, "cv.pdf");
    await fs.writeFile(resume, Buffer.from("%PDF-1.4"));
    await fs.writeFile(process.env["APPLY_PROFILE_PATH"], JSON.stringify({ first_name: "Test", last_name: "Person", email: "t@example.com", phone: "+10000000", default_resume: resume }));
    clearAutoApplySessionsForTests();
  });
  afterEach(async () => {
    setAutoApplyRunnerForTests(undefined);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("keyboard has the extra button only with a draft, and stays within 64 bytes", () => {
    const withBtn = buildQuestionKeyboard(ROW_ID, ask, ":zzzzzzzz.12", ":zzzzzzzz", true).inline_keyboard.flat();
    const without = buildQuestionKeyboard(ROW_ID, ask, ":zzzzzzzz.12", ":zzzzzzzz").inline_keyboard.flat();
    expect(withBtn.map((b) => b.text)).toContain("✅ Use suggestion");
    expect(without.map((b) => b.text)).not.toContain("✅ Use suggestion");
    for (const b of withBtn) expect(Buffer.byteLength((b as Btn).callback_data ?? "")).toBeLessThanOrEqual(64);
  });

  it("renders the suggestion and its source quote", () => {
    const t = draftLines({ answer: "6", sourceQuote: "6 years of AWS" });
    expect(t).toContain("Suggested: <code>6</code>");
    expect(t).toContain('From your profile: "6 years of AWS"');
  });

  it("source text leaves out contact details and salary", () => {
    const text = draftSourceText({ first_name: "Test", last_name: "Person", email: "t@example.com", phone: "1", answers: { years_experience: 6, salary_floor_basis: "x", work_authorization: "eu" } } as never);
    expect(text).toContain("years experience: 6");
    expect(text).not.toMatch(/example\.com|salary|work authorization/i);
  });

  it("strips salary, visa and contact lines from the dossier and question bank, keeps work history", () => {
    const dossier = { rawText: "Phone: +31 6 1234 5678\nEmail: t@example.com\nSalary Expectation: 52284\nVisa: needs sponsorship\nAcme 2019 - 2023: 6 years of AWS" } as never;
    const text = draftSourceText({ first_name: "Test", last_name: "Person", email: "t@example.com", phone: "1", question_bank: { "expected salary": "52284", "preferred name": "Test" } } as never, dossier);
    expect(text).toContain("Acme 2019 - 2023: 6 years of AWS");
    expect(text).toContain("preferred name: Test");
    expect(text).not.toMatch(/1234|example\.com|52284|sponsor/i);
  });

  it("shows the draft, saves nothing until the tap, then records it through the normal path", async () => {
    setAutoApplyRunnerForTests({
      prepare: async () => prep(),
      coverLetter: async () => ({ ok: false, reason: "n/a" }),
      drafts: async () => ({ "years of aws experience": { answer: "6", sourceQuote: "6 years of AWS experience" } }),
    });
    const { ctx, replies } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    const question = replies.find((r) => r.text.includes("Suggested:"));
    expect(question?.text).toContain("From your profile");
    const use = buttons(question?.extra).find((b) => b.text === "✅ Use suggestion");
    expect(use?.callback_data).toBeDefined();
    expect((await readCandidateDossier(PROFILE))?.rawText ?? "").not.toContain(LABEL);

    await handleAutoApplyCallback(ctx as never, use!.callback_data!);
    expect(replies.some((r) => r.text.includes("Saved to") && r.text.includes("<code>6</code>"))).toBe(true);
    expect((await readCandidateDossier(PROFILE))?.rawText ?? "").toContain(LABEL);
  });

  it("without a draft the question is plain and has no suggestion button", async () => {
    setAutoApplyRunnerForTests({ prepare: async () => prep(), coverLetter: async () => ({ ok: false, reason: "n/a" }) });
    const { ctx, replies } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    const question = replies.find((r) => r.text.includes(LABEL) && r.text.includes("Question 1/1"));
    expect(question?.text).not.toContain("Suggested");
    expect(buttons(question?.extra).map((b) => b.text)).not.toContain("✅ Use suggestion");
  });
});
