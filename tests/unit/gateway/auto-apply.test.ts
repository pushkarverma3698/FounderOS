/**
 * Unit + integration tests — Telegram Auto-Apply & Interactive Q&A loop
 * =====================================================================
 * Proves:
 *  1. `/profile doc` and `/profile remember Q = A` manage per-candidate dossiers
 *     (`pushkar-nl-tech` and `wife-nl-finance` stay strictly isolated).
 *  2. `/apply 1` (or tapping `🚀 Auto-Apply` `jh:f:<rowId>`) prepares the form,
 *     sends the preview screenshot, and prompts any unknown question in Telegram.
 *  3. Replying with plain text (`tryHandlePendingApplyReply`) or tapping an
 *     inline option button (`jh:q:<rowId>:0`) saves the answer to the candidate's
 *     `candidate-dossier.md` + `apply-profile.json`, re-fills the form, and
 *     surfaces `🚀 Submit Application` (`jh:s:<rowId>`).
 *  4. Tapping `🚀 Submit Application` calls `submitApplicationForm`, sends the
 *     post-submit proof screenshot, and marks the row `applied`.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROW_ID = "11111111-2222-4333-8444-555555555555";
const TASHI_ROW_ID = "66666666-7777-4888-9999-aaaaaaaaaaaa";

const mockMarkRowApplied = vi.fn(async (_row?: unknown) => ({ ok: true as const, already: false }));
const mockGetApplicationById = vi.fn();
const mockResolveRowRef = vi.fn();

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../../src/gateway/jobhunt-buttons.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/gateway/jobhunt-buttons.js")>();
  return {
    ...actual,
    markRowApplied: (row: unknown) => mockMarkRowApplied(row),
  };
});

const mockHasBeenAudited = vi.fn(async (_key: string) => false);
const mockWriteAuditEntry = vi.fn(async (_data: unknown) => ({ written: true }));
vi.mock("../../../src/db/queries.js", () => ({
  hasBeenAudited: (key: string) => mockHasBeenAudited(key),
  writeAuditEntry: (data: unknown) => mockWriteAuditEntry(data),
}));

vi.mock("../../../src/db/apply-queries.js", () => ({
  getApplicationById: (...args: unknown[]) => mockGetApplicationById(...args),
}));

vi.mock("../../../src/gateway/jobhunt-row-ref.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/gateway/jobhunt-row-ref.js")>();
  return {
    ...actual,
    resolveRowRef: (...args: unknown[]) => mockResolveRowRef(...args),
  };
});

const {
  handleAutoApply,
  handleAutoApplyCallback,
  tryHandlePendingApplyReply,
  setAutoApplyRunnerForTests,
  clearAutoApplySessionsForTests,
} = await import("../../../src/gateway/auto-apply.js");
const { handleProfile, parseProfileCommand } = await import("../../../src/gateway/profile-commands.js");
const { readCandidateDossier } = await import("../../../src/tools/jobhunt/candidate-dossier.js");
const { readApplyProfile, applyProfilePathFor } = await import("../../../src/tools/jobhunt/apply-profile.js");

function makeFakeCtx(match = "", chatId = 999) {
  const replies: Array<{ text: string; extra?: Record<string, unknown> }> = [];
  const photos: Array<{ caption?: string }> = [];
  const callbackAnswers: Array<{ text?: string }> = [];
  return {
    ctx: {
      chat: { id: chatId, type: "private" },
      from: { id: 12345 },
      match,
      reply: vi.fn(async (text: string, extra?: Record<string, unknown>) => {
        replies.push({ text, extra });
      }),
      replyWithPhoto: vi.fn(async (_file: unknown, extra?: { caption?: string }) => {
        photos.push({ caption: extra?.caption });
      }),
      answerCallbackQuery: vi.fn(async (opts?: { text?: string }) => {
        callbackAnswers.push(opts ?? {});
      }),
      editMessageReplyMarkup: vi.fn(async () => undefined),
    },
    replies,
    photos,
    callbackAnswers,
  };
}

describe("Telegram Auto-Apply & Candidate Dossier Loop", () => {
  let tmpDir: string;
  let resumePdfPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-auto-apply-"));
    resumePdfPath = path.join(tmpDir, "cv-test.pdf");
    await fs.writeFile(resumePdfPath, Buffer.from("%PDF-1.4 test cv"));

    const defaultProfilePath = path.join(tmpDir, "apply-profile.json");
    process.env["APPLY_PROFILE_PATH"] = defaultProfilePath;
    delete process.env["CANDIDATE_DOSSIER_PATH"];
    process.env["FOUNDEROS_DATA_ROOT"] = tmpDir;
    process.env["APPLY_LINK_SECRET"] = "s3cret-for-tests-0123456789abcdef";
    process.env["APPLY_LINK_BASE_URL"] = "https://apply.example.test";

    await fs.writeFile(
      defaultProfilePath,
      JSON.stringify({
        first_name: "Pushkar",
        last_name: "Verma",
        email: "pushkar@example.com",
        phone: "+31 6 11112222",
        default_resume: resumePdfPath,
        answers: {
          work_authorization: "requires-sponsorship",
          auto_consent: true,
        },
      }),
    );

    const tashiProfilePath = applyProfilePathFor("wife-nl-finance");
    await fs.writeFile(
      tashiProfilePath,
      JSON.stringify({
        first_name: "Tashi",
        last_name: "Goyal",
        email: "tashi@example.com",
        phone: "+31 6 33334444",
        default_resume: resumePdfPath,
        answers: {
          work_authorization: "authorized-no-sponsorship",
          auto_consent: true,
        },
      }),
    );

    clearAutoApplySessionsForTests();
    mockMarkRowApplied.mockClear();
    mockGetApplicationById.mockReset();
    mockResolveRowRef.mockReset();
  });

  afterEach(async () => {
    setAutoApplyRunnerForTests(undefined);
    delete process.env["FOUNDEROS_DATA_ROOT"];
    delete process.env["APPLY_LINK_SECRET"];
    delete process.env["APPLY_LINK_BASE_URL"];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("parses and executes /profile doc and /profile remember for both Pushkar and Tashi", async () => {
    expect(parseProfileCommand("doc")).toEqual({ kind: "doc" });
    expect(parseProfileCommand("remember Notice period = Immediately")).toEqual({
      kind: "remember",
      question: "Notice period",
      answer: "Immediately",
    });

    const { ctx: rememberCtx, replies: remReplies } = makeFakeCtx("remember Notice period = Immediately");
    await handleProfile(rememberCtx as never);
    expect(remReplies[0]?.text).toContain("Saved to Pushkar");
    expect(remReplies[0]?.text).toContain("Notice period");

    const { ctx: tashiCtx, replies: tashiReplies } = makeFakeCtx("tashi remember Notice period = 1 month");
    await handleProfile(tashiCtx as never);
    expect(tashiReplies[0]?.text).toContain("Saved to Tashi");

    const pushkarDossier = await readCandidateDossier("pushkar-nl-tech");
    const tashiDossier = await readCandidateDossier("wife-nl-finance");
    expect(pushkarDossier?.qaPairs["notice period"]).toBe("Immediately");
    expect(tashiDossier?.qaPairs["notice period"]).toBe("1 month");

    const { ctx: docCtx, replies: docReplies } = makeFakeCtx("doc");
    await handleProfile(docCtx as never);
    expect(docReplies[0]?.text).toContain("Pushkar Verma — Reference Dossier");
    expect(docReplies[0]?.text).toContain("notice period");
  });

  it("runs /apply 1 -> asks unknown question -> saves user reply -> re-fills -> submits on button tap", async () => {
    const fakeRow = {
      id: ROW_ID,
      company: "Workwize",
      title: "Senior Full-Stack Engineer",
      url: "https://job-boards.eu.greenhouse.io/workwize/jobs/4788131101",
      profile_id: "pushkar-nl-tech",
      track: "fullstack",
      stage: "screened",
    };

    mockResolveRowRef.mockResolvedValue({ ok: true, row: fakeRow });
    mockGetApplicationById.mockResolvedValue(fakeRow);

    let prepCallCount = 0;
    setAutoApplyRunnerForTests({
      coverLetter: async () => ({ ok: false, reason: "not in this test" }),
      prepare: async (_url, _company, profile, _row, dossier) => {
        prepCallCount += 1;
        const hasLearnedWhy =
          profile.question_bank?.["Why Workwize?"] || dossier?.qaPairs["why workwize"];
        return {
          ok: true,
          platform: "greenhouse",
          targetUrl: fakeRow.url,
          screenshotPng: Buffer.from("fake-png-bytes"),
          summary: {
            filled: hasLearnedWhy ? 6 : 5,
            total: 6,
            filledLabels: ["First Name", "Last Name", "Email", "Phone", "Resume/CV"],
            filledAnswers: [],
            unanswered: hasLearnedWhy
              ? []
              : [
                  {
                    selector: "#question_why",
                    label: "Why Workwize?",
                    kind: "ask",
                    question: "Why Workwize?",
                    required: true,
                    fieldType: "textarea",
                    why: "not yet in dossier",
                  },
                ],
            requiredUnanswered: hasLearnedWhy
              ? []
              : [
                  {
                    selector: "#question_why",
                    label: "Why Workwize?",
                    kind: "ask",
                    question: "Why Workwize?",
                    required: true,
                    fieldType: "textarea",
                    why: "not yet in dossier",
                  },
                ],
            hasCaptcha: false,
            readyToSubmit: Boolean(hasLearnedWhy),
          },
        };
      },
      submit: async () => ({
        ok: true,
        platform: "greenhouse",
        clicked: true,
        confirmed: true,
        evidence: "Confirmed: page displayed Thank you for applying",
        afterScreenshotPng: Buffer.from("post-submit-png"),
      }),
    });

    // Step 1: User sends `/apply 1`
    const { ctx, replies, photos } = makeFakeCtx("1", 777);
    await handleAutoApply(ctx as never);

    expect(prepCallCount).toBe(1);
    // The screenshot is gone: the preview is a text card with the hosted-page link button.
    expect(photos).toHaveLength(0);
    expect(replies.some((r) => r.text.includes("Workwize") && r.text.includes("Filled"))).toBe(true);
    expect(replies.some((r) => r.text.includes("Question 1/1 for Workwize"))).toBe(true);
    expect(replies.some((r) => r.text.includes("Why Workwize?"))).toBe(true);

    // Step 2: User replies in Telegram with their answer
    const handled = await tryHandlePendingApplyReply(
      ctx as never,
      "Built distributed automation systems for 3.5 years and love Workwize's mission.",
    );
    expect(handled).toBe(true);
    expect(prepCallCount).toBe(2);

    // Verify answer was persisted to both apply-profile.json and candidate-dossier.md
    const updatedProfile = await readApplyProfile(applyProfilePathFor("pushkar-nl-tech"));
    expect(updatedProfile.ok && updatedProfile.profile.question_bank?.["Why Workwize?"]).toContain(
      "Built distributed automation systems",
    );
    const updatedDossier = await readCandidateDossier("pushkar-nl-tech");
    expect(updatedDossier?.qaPairs["why workwize"]).toContain("Built distributed automation systems");

    // Verify the form is now ready to submit
    expect(replies.some((r) => r.text.includes("Form ready for Workwize"))).toBe(true);

    // Step 3: User taps `🚀 Submit Application` (`jh:s:<ROW_ID>`)
    const { ctx: submitCtx, replies: submitReplies, photos: submitPhotos } = makeFakeCtx("", 777);
    const cbHandled = await handleAutoApplyCallback(submitCtx as never, `jh:s:${ROW_ID}`);
    expect(cbHandled).toBe(true);
    expect(submitPhotos).toHaveLength(1);
    expect(mockMarkRowApplied).toHaveBeenCalledTimes(1);
    expect(submitReplies.some((r) => r.text.includes("Application submitted and marked applied"))).toBe(true);
  });

  it("handles one-tap option button answers (jh:q:<rowId>:<optIdx>) for Tashi's profile", async () => {
    const tashiRow = {
      id: TASHI_ROW_ID,
      company: "Metyis",
      title: "Financial Analyst",
      url: "https://metyis.recruitee.com/o/financial-analyst",
      profile_id: "wife-nl-finance",
      track: "finance",
      stage: "screened",
    };

    mockGetApplicationById.mockResolvedValue(tashiRow);

    setAutoApplyRunnerForTests({
      coverLetter: async () => ({ ok: false, reason: "not in this test" }),
      prepare: async (_url, _company, profile) => {
        const answered = profile.question_bank?.["Preferred office location"];
        return {
          ok: true,
          platform: "recruitee",
          targetUrl: tashiRow.url,
          screenshotPng: Buffer.from("tashi-preview"),
          summary: {
            filled: answered ? 5 : 4,
            total: 5,
            filledLabels: ["Full Name", "Email", "Phone", "Resume/CV"],
            filledAnswers: [],
            unanswered: answered
              ? []
              : [
                  {
                    selector: "#office_select",
                    label: "Preferred office location",
                    kind: "ask",
                    question: "Preferred office location",
                    required: true,
                    fieldType: "select",
                    options: ["Amsterdam", "Rotterdam"],
                    why: "not yet in dossier",
                  },
                ],
            requiredUnanswered: answered
              ? []
              : [
                  {
                    selector: "#office_select",
                    label: "Preferred office location",
                    kind: "ask",
                    question: "Preferred office location",
                    required: true,
                    fieldType: "select",
                    options: ["Amsterdam", "Rotterdam"],
                    why: "not yet in dossier",
                  },
                ],
            hasCaptcha: false,
            readyToSubmit: Boolean(answered),
          },
        };
      },
      submit: async () => ({
        ok: true,
        platform: "recruitee",
        clicked: true,
        confirmed: true,
        evidence: "Confirmed",
        afterScreenshotPng: Buffer.from("tashi-submit"),
      }),
    });

    const { ctx, replies } = makeFakeCtx("", 888);
    // Tap `🚀 Auto-Apply` (`jh:f:<TASHI_ROW_ID>`)
    await handleAutoApplyCallback(ctx as never, `jh:f:${TASHI_ROW_ID}`);
    expect(replies.some((r) => r.text.includes("Preferred office location"))).toBe(true);

    // Tap option 0 ("Amsterdam") via `jh:q:<TASHI_ROW_ID>:0`
    await handleAutoApplyCallback(ctx as never, `jh:q:${TASHI_ROW_ID}:0`);
    const tashiDossier = await readCandidateDossier("wife-nl-finance");
    expect(tashiDossier?.qaPairs["preferred office location"]).toBe("Amsterdam");
    expect(replies.some((r) => r.text.includes("Form ready for Metyis"))).toBe(true);
  });
});
