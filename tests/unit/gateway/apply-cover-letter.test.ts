/**
 * Cover letter on /apply
 * =======================
 * Proves, offline (no model call, no Chromium, no S3):
 *  1. The resolver reuses the archived letter (`cover_letter_s3_key`), else writes and archives one, and
 *     renders its PDF beside the CV. A failed write or download is a typed reason, never a throw.
 *  2. `/apply` hands the letter (PDF path and text) to the form fill, and Submit attaches the same letter.
 *  3. The card says whether the form took the letter, has no letter field, or why there is no letter.
 * Seen live 2026-10-17: Telnyx asked "Cover Letter" as a question, because /apply never passed a letter.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobApplication } from "../../../src/db/schema.js";
import type { prepareApplicationForm, submitApplicationForm } from "../../../src/tools/jobhunt/form-runner.js";
import type { RowApplicationFacts, UnansweredQuestion } from "../../../src/tools/jobhunt/form-brain.js";

const ROW_ID = "11111111-2222-4333-8444-555555555555";
const PROFILE = "pushkar-nl-tech";
const LETTER = "Dear Hiring Team,\n\nI build support tooling.\n\nPushkar";

const mockDownload = vi.fn();
const mockWrite = vi.fn();
const mockRender = vi.fn(async (_md: string) => ({ pdfBuffer: Buffer.from("%PDF-1.4 letter"), htmlString: "" }));
const mockGetApplicationById = vi.fn();

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/infra/storage/s3-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/infra/storage/s3-client.js")>()),
  downloadFile: (...args: unknown[]) => mockDownload(...args),
}));
vi.mock("../../../src/gateway/cover-letter-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/gateway/cover-letter-delivery.js")>()),
  writeCoverLetter: (...args: unknown[]) => mockWrite(...args),
}));
vi.mock("../../../src/tools/jobhunt/cv-renderer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/tools/jobhunt/cv-renderer.js")>()),
  renderCvToPdf: (md: string) => mockRender(md),
}));
vi.mock("../../../src/gateway/jobhunt-buttons.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/gateway/jobhunt-buttons.js")>()),
  markRowApplied: async () => ({ ok: true as const, already: false }),
}));
vi.mock("../../../src/db/apply-queries.js", () => ({
  getApplicationById: (...args: unknown[]) => mockGetApplicationById(...args),
}));

const { resolveApplyCoverLetter, coverLetterPdfPath } = await import("../../../src/gateway/apply-cover-letter.js");
const { handleAutoApplyCallback, setAutoApplyRunnerForTests, clearAutoApplySessionsForTests } = await import("../../../src/gateway/auto-apply.js");

const ROW = {
  id: ROW_ID,
  company: "Telnyx",
  title: "Support Engineer",
  url: "https://job-boards.greenhouse.io/telnyx/jobs/1",
  profile_id: PROFILE,
  track: "fullstack",
  stage: "screened",
  cover_letter_s3_key: null,
} as unknown as JobApplication;

type Prep = Awaited<ReturnType<typeof prepareApplicationForm>>;
type Sent = Awaited<ReturnType<typeof submitApplicationForm>>;
type Reply = { text: string; extra?: Record<string, unknown> };

function prep(filledLabels: string[], unanswered: UnansweredQuestion[] = []): Prep {
  return {
    ok: true,
    platform: "greenhouse",
    targetUrl: ROW.url ?? "",
    screenshotPng: Buffer.from("png"),
    summary: {
      filled: filledLabels.length,
      total: filledLabels.length + unanswered.length,
      filledLabels,
      filledAnswers: filledLabels.map((label) => ({ label, value: "x", fieldType: "text", editable: false })),
      unanswered,
      requiredUnanswered: unanswered.filter((u) => u.required),
      hasCaptcha: false,
      readyToSubmit: unanswered.every((u) => !u.required),
    },
  } as Prep;
}

function fileAsk(label: string): UnansweredQuestion {
  return { selector: "#cl", label, kind: "ask", question: label, required: false, fieldType: "file", why: "fill attempted on page but did not verify in DOM" };
}

function makeCtx(chatId = 777) {
  const replies: Reply[] = [];
  const ctx = {
    chat: { id: chatId, type: "private" },
    from: { id: 12345 },
    match: "",
    reply: vi.fn(async (text: string, extra?: Record<string, unknown>) => {
      replies.push({ text, extra });
    }),
    replyWithPhoto: vi.fn(async () => undefined),
    answerCallbackQuery: vi.fn(async () => undefined),
    editMessageReplyMarkup: vi.fn(async () => undefined),
  };
  return { ctx, replies };
}

let tmpDir: string;
let resume: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["APPLY_PROFILE_PATH", "CANDIDATE_DOSSIER_PATH", "FOUNDEROS_DATA_ROOT", "APPLY_LINK_SECRET", "APPLY_LINK_BASE_URL"];

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-apply-letter-"));
  resume = path.join(tmpDir, "cv-test.pdf");
  await fs.writeFile(resume, Buffer.from("%PDF-1.4 test cv"));
  process.env["APPLY_PROFILE_PATH"] = path.join(tmpDir, "apply-profile.json");
  process.env["FOUNDEROS_DATA_ROOT"] = tmpDir;
  process.env["APPLY_LINK_SECRET"] = "s3cret-for-tests-0123456789abcdef";
  process.env["APPLY_LINK_BASE_URL"] = "https://apply.example.test";
  delete process.env["CANDIDATE_DOSSIER_PATH"];
  await fs.writeFile(
    process.env["APPLY_PROFILE_PATH"] ?? "",
    JSON.stringify({ first_name: "Pushkar", last_name: "Verma", email: "p@example.com", phone: "+31 6 11112222", default_resume: resume }),
  );
  mockDownload.mockReset();
  mockWrite.mockReset();
  mockRender.mockClear();
  mockGetApplicationById.mockReset();
  mockGetApplicationById.mockResolvedValue(ROW);
  clearAutoApplySessionsForTests();
});

afterEach(async () => {
  setAutoApplyRunnerForTests(undefined);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("resolveApplyCoverLetter", () => {
  it("reuses the archived letter and renders its PDF beside the CV, without writing a new one", async () => {
    mockDownload.mockResolvedValue(Buffer.from(`${LETTER}\n`));
    const row = { ...ROW, cover_letter_s3_key: "ready-applications/x/cover_letter.txt" } as JobApplication;
    const out = await resolveApplyCoverLetter(row, "CV TEXT", tmpDir);

    expect(out).toEqual({ ok: true, source: "archived", letter: { text: LETTER, pdfPath: coverLetterPdfPath(tmpDir, row) } });
    expect(mockDownload).toHaveBeenCalledWith("ready-applications/x/cover_letter.txt");
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockRender).toHaveBeenCalledWith(LETTER);
    expect((await fs.readFile(coverLetterPdfPath(tmpDir, row))).toString()).toBe("%PDF-1.4 letter");
    expect(path.basename(coverLetterPdfPath(tmpDir, row))).toBe("cover-letter-telnyx-11111111.pdf");
  });

  it("writes (and so archives) a letter from the CV when none is archived", async () => {
    mockWrite.mockResolvedValue({ ok: true, letter: LETTER });
    const out = await resolveApplyCoverLetter(ROW, "CV TEXT", tmpDir);

    expect(out).toMatchObject({ ok: true, source: "written", letter: { text: LETTER } });
    expect(mockWrite).toHaveBeenCalledWith(ROW, "CV TEXT");
  });

  it("returns the writer's reason when the letter cannot be written, and renders nothing", async () => {
    mockWrite.mockResolvedValue({ ok: false, reason: "provider 503" });
    expect(await resolveApplyCoverLetter(ROW, "CV TEXT", tmpDir)).toEqual({ ok: false, reason: "provider 503" });
    expect(mockRender).not.toHaveBeenCalled();
  });

  it("retries once after a backoff when the model is rate-limited, and uses the second letter", async () => {
    mockWrite
      .mockResolvedValueOnce({ ok: false, reason: '429 {"error":{"message":"Rate limit exceeded: free-models-per-min","code":429}}' })
      .mockResolvedValueOnce({ ok: true, letter: LETTER });
    const sleeps: number[] = [];
    const out = await resolveApplyCoverLetter(ROW, "CV TEXT", tmpDir, { sleep: async (ms) => void sleeps.push(ms) });
    expect(out).toMatchObject({ ok: true, source: "written", letter: { text: LETTER } });
    expect(mockWrite).toHaveBeenCalledTimes(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  it("gives a plain one-line reason, not the provider text, when the retry is rate-limited too", async () => {
    mockWrite.mockResolvedValue({ ok: false, reason: 'Error: 429 Too Many Requests\n{"error":{"metadata":{"raw":"google/gemini is temporarily rate-limited upstream"}}}' });
    const out = await resolveApplyCoverLetter(ROW, "CV TEXT", tmpDir, { sleep: async () => undefined });
    expect(out).toEqual({ ok: false, reason: "model rate-limited" });
    expect(mockWrite).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failure that is not a rate limit, and keeps its reason to one line", async () => {
    mockWrite.mockResolvedValue({ ok: false, reason: "model returned no letter\nstack line 1\nstack line 2" });
    const sleep = vi.fn(async () => undefined);
    const out = await resolveApplyCoverLetter(ROW, "CV TEXT", tmpDir, { sleep });
    expect(out).toEqual({ ok: false, reason: "model returned no letter" });
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not call the writer without a CV to ground the letter in", async () => {
    const out = await resolveApplyCoverLetter(ROW, null, tmpDir);
    expect(out.ok).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("turns a failed download or render into a reason, never a throw", async () => {
    mockDownload.mockRejectedValue(new Error("NoSuchKey"));
    const row = { ...ROW, cover_letter_s3_key: "gone.txt" } as JobApplication;
    expect(await resolveApplyCoverLetter(row, "CV TEXT", tmpDir)).toEqual({ ok: false, reason: "NoSuchKey" });
  });
});

describe("/apply with a cover letter", () => {
  let prepFacts: RowApplicationFacts[];
  let submitFacts: RowApplicationFacts[];
  let letterCalls: number;

  function script(prepResult: Prep, letter: Awaited<ReturnType<typeof resolveApplyCoverLetter>>): void {
    prepFacts = [];
    submitFacts = [];
    letterCalls = 0;
    const sent = { ok: true, platform: "greenhouse", clicked: true, confirmed: true, evidence: "Confirmed", afterScreenshotPng: Buffer.from("") };
    setAutoApplyRunnerForTests({
      prepare: async (_u, _c, _p, facts) => {
        prepFacts.push(facts);
        return prepResult;
      },
      submit: async (_u, _c, _p, facts) => {
        submitFacts.push(facts);
        return sent as Sent;
      },
      coverLetter: async () => {
        letterCalls += 1;
        return letter;
      },
    });
  }

  const attached = { ok: true as const, source: "written" as const, letter: { text: LETTER, pdfPath: "/data/cover-letter-telnyx-11111111.pdf" } };

  it("fills the form with the letter, shows it in the chat, and Submit attaches the same letter", async () => {
    script(prep(["First Name", "Resume/CV", "Cover Letter"]), attached);
    const { ctx, replies } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);

    expect(prepFacts).toEqual([{ resumePath: resume, coverLetterPath: attached.letter.pdfPath, coverLetterText: LETTER }]);
    expect(replies.find((r) => r.text.includes("Filled 3/3"))?.text).toContain("Cover letter: attached (Cover Letter)");
    expect(replies.some((r) => r.text.includes("<blockquote expandable>") && r.text.includes("I build support tooling."))).toBe(true);

    await handleAutoApplyCallback(ctx as never, `jh:s:${ROW_ID}`);
    expect(submitFacts).toEqual([{ resumePath: resume, coverLetterPath: attached.letter.pdfPath, coverLetterText: LETTER }]);
    expect(letterCalls).toBe(1);
  });

  it("still fills the form with the CV when no letter could be produced, and says why", async () => {
    script(prep(["First Name", "Resume/CV"]), { ok: false, reason: "provider 503" });
    const { ctx, replies } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);

    expect(prepFacts).toEqual([{ resumePath: resume }]);
    expect(replies.find((r) => r.text.includes("Filled 2/2"))?.text).toContain("⚠ Cover letter not written: provider 503.");
    expect(replies.some((r) => r.text.includes("Form ready"))).toBe(true);
  });

  it("says plainly when the form has no cover-letter field", async () => {
    script(prep(["First Name", "Resume/CV"]), attached);
    const { ctx, replies } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    expect(replies.find((r) => r.text.includes("Filled 2/2"))?.text).toContain("Cover letter: this form has no cover-letter field");
  });

  it("warns when the form would not take the letter", async () => {
    script(prep(["First Name", "Resume/CV"], [fileAsk("Cover Letter")]), attached);
    const { ctx, replies } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    expect(replies.find((r) => r.text.includes("Filled 2/3"))?.text).toContain("⚠ Cover letter: the form did not take it (Cover Letter)");
  });

  it("resolves the letter again at Submit when the session is gone (a restart), and attaches it", async () => {
    script(prep(["First Name", "Resume/CV", "Cover Letter"]), attached);
    const { ctx } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:s:${ROW_ID}`);
    expect(submitFacts).toEqual([{ resumePath: resume, coverLetterPath: attached.letter.pdfPath, coverLetterText: LETTER }]);
    expect(letterCalls).toBe(1);
  });
});
