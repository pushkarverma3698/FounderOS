/**
 * Stale /apply cards
 * ==================
 * Seen live 2026-10-17: after a newer card for the same row arrived, the older cards' Submit, Cancel and
 * answer buttons still worked. Proves, offline with scripted runners:
 *  1. Every Submit / Cancel / answer button on a card carries the card's stamp, within Telegram's 64 bytes.
 *  2. A tap on a superseded card answers "This card is out of date; use the latest one" and does nothing:
 *     no send, no cancel, no saved answer.
 *  3. An earlier question's buttons are stale once the next question is asked, even on the same card run.
 *  4. The latest card's buttons still work.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnansweredQuestion } from "../../../src/tools/jobhunt/form-brain.js";
import type { prepareApplicationForm } from "../../../src/tools/jobhunt/form-runner.js";

const ROW_ID = "11111111-2222-4333-8444-555555555555";
const PROFILE = "pushkar-nl-tech";
const STALE = "This card is out of date; use the latest one";

const mockGetApplicationById = vi.fn();

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/gateway/jobhunt-buttons.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/gateway/jobhunt-buttons.js")>()),
  markRowApplied: async () => ({ ok: true as const, already: false }),
}));
vi.mock("../../../src/db/queries.js", () => ({
  hasBeenAudited: async () => false,
  writeAuditEntry: async () => ({ written: true }),
}));

vi.mock("../../../src/db/apply-queries.js", () => ({
  getApplicationById: (...args: unknown[]) => mockGetApplicationById(...args),
}));

const { handleAutoApplyCallback, setAutoApplyRunnerForTests, clearAutoApplySessionsForTests } = await import("../../../src/gateway/auto-apply.js");
const { loadApplySnapshot } = await import("../../../src/tools/jobhunt/apply-link.js");

const ROW = {
  id: ROW_ID,
  company: "Telnyx",
  title: "Support Engineer",
  url: "https://job-boards.greenhouse.io/telnyx/jobs/1",
  profile_id: PROFILE,
  track: "fullstack",
  stage: "screened",
};

type Prep = Awaited<ReturnType<typeof prepareApplicationForm>>;
type Btn = { text: string; url?: string; callback_data?: string };
type Reply = { text: string; extra?: Record<string, unknown> };

function ask(label: string): UnansweredQuestion {
  return { selector: "#q", label, kind: "ask", question: label, required: true, fieldType: "select", options: ["Yes", "No"], why: "not yet in dossier" };
}

function prep(unanswered: UnansweredQuestion[]): Prep {
  return {
    ok: true,
    platform: "greenhouse",
    targetUrl: ROW.url,
    screenshotPng: Buffer.from("png"),
    summary: {
      filled: 2,
      total: 2 + unanswered.length,
      filledLabels: ["First Name", "Email"],
      filledAnswers: [],
      unanswered,
      requiredUnanswered: unanswered.filter((u) => u.required),
      hasCaptcha: false,
      readyToSubmit: unanswered.every((u) => !u.required),
    },
  };
}

function makeCtx() {
  const replies: Reply[] = [];
  const answers: string[] = [];
  const ctx = {
    chat: { id: 888, type: "private" },
    from: { id: 12345 },
    match: "",
    reply: vi.fn(async (text: string, extra?: Record<string, unknown>) => void replies.push({ text, extra })),
    replyWithPhoto: vi.fn(async () => undefined),
    answerCallbackQuery: vi.fn(async (o?: { text?: string }) => void answers.push(o?.text ?? "")),
    editMessageReplyMarkup: vi.fn(async () => undefined),
  };
  return { ctx, replies, answers };
}

const buttonsOf = (r: Reply | undefined): Btn[] =>
  ((r?.extra?.["reply_markup"] as { inline_keyboard?: Btn[][] } | undefined)?.inline_keyboard ?? []).flat();

/** The callback data of the first button on reply `r` whose data starts with `prefix`. */
function cb(r: Reply | undefined, prefix: string): string {
  const data = buttonsOf(r).find((b) => b.callback_data?.startsWith(prefix))?.callback_data;
  if (!data) throw new Error(`no ${prefix} button on: ${r?.text ?? "(no reply)"}`);
  return data;
}

const ready = (replies: Reply[]): Reply[] => replies.filter((r) => r.text.includes("Form ready"));
const questions = (replies: Reply[], label: string): Reply[] => replies.filter((r) => r.text.startsWith("❓") && r.text.includes(label));

const ENV_KEYS = ["APPLY_PROFILE_PATH", "CANDIDATE_DOSSIER_PATH", "FOUNDEROS_DATA_ROOT", "APPLY_LINK_SECRET", "APPLY_LINK_BASE_URL"];
let tmpDir: string;
let saved: Record<string, string | undefined>;
let submitCalls: number;

function script(results: Prep[]): void {
  let n = 0;
  submitCalls = 0;
  const sent = { ok: true, platform: "greenhouse", clicked: true, confirmed: true, evidence: "Confirmed", afterScreenshotPng: Buffer.from("") };
  setAutoApplyRunnerForTests({
    prepare: async () => results[Math.min(n++, results.length - 1)] as Prep,
    submit: async () => {
      submitCalls += 1;
      return sent as never;
    },
    coverLetter: async () => ({ ok: false, reason: "not in this test" }),
  });
}

describe("stale /apply cards", () => {
  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-apply-stale-"));
    const resume = path.join(tmpDir, "cv.pdf");
    await fs.writeFile(resume, Buffer.from("%PDF-1.4 cv"));
    process.env["APPLY_PROFILE_PATH"] = path.join(tmpDir, "apply-profile.json");
    process.env["FOUNDEROS_DATA_ROOT"] = tmpDir;
    process.env["APPLY_LINK_SECRET"] = "s3cret-for-tests-0123456789abcdef";
    process.env["APPLY_LINK_BASE_URL"] = "https://apply.example.test";
    delete process.env["CANDIDATE_DOSSIER_PATH"];
    await fs.writeFile(process.env["APPLY_PROFILE_PATH"] ?? "", JSON.stringify({ first_name: "P", last_name: "V", email: "p@example.com", phone: "+31 6 11112222", default_resume: resume }));
    clearAutoApplySessionsForTests();
    mockGetApplicationById.mockReset();
    mockGetApplicationById.mockResolvedValue(ROW);
  });

  afterEach(async () => {
    setAutoApplyRunnerForTests(undefined);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("stamps every Submit, Cancel and answer button, within Telegram's 64-byte limit", async () => {
    script([prep([ask("Are you authorised to work in the EU?")])]);
    const { ctx, replies } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    const data = replies.flatMap(buttonsOf).flatMap((b) => (b.callback_data ? [b.callback_data] : []));
    const ours = data.filter((d) => /^jh:[sqk]:/.test(d));
    expect(ours.length).toBeGreaterThan(0);
    for (const d of ours) {
      expect(d.split(":").length, d).toBe(d.startsWith("jh:q:") ? 5 : 4);
      expect(Buffer.byteLength(d), d).toBeLessThanOrEqual(64);
    }
  });

  it("refuses Submit on a superseded card and sends nothing; the latest card's Submit sends", async () => {
    script([prep([])]);
    const { ctx, replies, answers } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    const [oldCard, newCard] = ready(replies);
    expect(cb(oldCard, "jh:s:")).not.toBe(cb(newCard, "jh:s:"));

    const before = replies.length;
    await handleAutoApplyCallback(ctx as never, cb(oldCard, "jh:s:"));
    expect(answers.at(-1)).toBe(STALE);
    expect(submitCalls).toBe(0);
    expect(replies.length).toBe(before);

    await handleAutoApplyCallback(ctx as never, cb(newCard, "jh:s:"));
    expect(submitCalls).toBe(1);
  });

  it("refuses Cancel on a superseded card: the session and the answer link survive", async () => {
    script([prep([])]);
    const { ctx, replies, answers } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    const [oldCard, newCard] = ready(replies);

    await handleAutoApplyCallback(ctx as never, cb(oldCard, "jh:k:"));
    expect(answers.at(-1)).toBe(STALE);
    expect(replies.some((r) => r.text.includes("Cancelled"))).toBe(false);
    expect(loadApplySnapshot(ROW_ID)).not.toBeNull();

    await handleAutoApplyCallback(ctx as never, cb(newCard, "jh:k:"));
    expect(replies.some((r) => r.text.includes("Cancelled"))).toBe(true);
    expect(loadApplySnapshot(ROW_ID)).toBeNull();
  });

  it("refuses an answer button on a superseded card and saves nothing", async () => {
    const Q = "Are you authorised to work in the EU?";
    script([prep([ask(Q)])]);
    const { ctx, replies, answers } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    const [oldAsk, newAsk] = questions(replies, Q);

    await handleAutoApplyCallback(ctx as never, cb(oldAsk, "jh:q:"));
    expect(answers.at(-1)).toBe(STALE);
    expect(replies.some((r) => r.text.startsWith("💾"))).toBe(false);

    await handleAutoApplyCallback(ctx as never, cb(newAsk, "jh:q:"));
    expect(replies.some((r) => r.text.startsWith("💾"))).toBe(true);
  });

  it("refuses an earlier question's buttons once the next question is asked", async () => {
    const Q1 = "Are you authorised to work in the EU?";
    const Q2 = "Do you need sponsorship?";
    script([prep([ask(Q1), ask(Q2)])]);
    const { ctx, replies, answers } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    const q1 = questions(replies, Q1)[0];
    await handleAutoApplyCallback(ctx as never, cb(q1, "jh:q:"));
    const q2 = questions(replies, Q2)[0];
    expect(q2).toBeDefined();
    const saves = replies.filter((r) => r.text.startsWith("💾")).length;

    // Q1's "No" would otherwise be saved as the answer to Q2.
    const q1No = buttonsOf(q1).find((b) => b.text === "No")?.callback_data ?? "";
    await handleAutoApplyCallback(ctx as never, q1No);
    expect(answers.at(-1)).toBe(STALE);
    expect(replies.filter((r) => r.text.startsWith("💾")).length).toBe(saves);

    await handleAutoApplyCallback(ctx as never, cb(q2, "jh:q:"));
    expect(replies.filter((r) => r.text.startsWith("💾")).length).toBe(saves + 1);
  });
});
