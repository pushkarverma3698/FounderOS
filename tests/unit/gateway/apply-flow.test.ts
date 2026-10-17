/**
 * Apply flow: hosted answer link, text card, re-ask guard
 * ========================================================
 * Proves, offline and with scripted runners:
 *  1. The preview is a text card with a URL button to the hosted answer page (no screenshot), and a
 *     snapshot the page can render is written.
 *  2. A missing APPLY_LINK_SECRET / APPLY_LINK_BASE_URL is said plainly on the card; Telegram Q&A runs.
 *  3. Re-ask guard: a question answered in this session that comes back unfilled is not asked again;
 *     the card says it could not be filled and points at the answer page. Seen live on Telnyx, where
 *     "Are you based in The Netherlands or Ireland?" was asked forever.
 *  4. The Submit keyboard leads with the hosted link; the company page is labelled not prefilled.
 *  5. A page-triggered re-fill shares one per-row lock with the Telegram path.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnansweredQuestion } from "../../../src/tools/jobhunt/form-brain.js";
import type { prepareApplicationForm } from "../../../src/tools/jobhunt/form-runner.js";

const ROW_ID = "11111111-2222-4333-8444-555555555555";
const SECRET = "s3cret-for-tests-0123456789abcdef";
const BASE_URL = "https://apply.example.test";
const WHERE = "Are you based in The Netherlands or Ireland?";
const PROFILE = "pushkar-nl-tech";

const mockMarkRowApplied = vi.fn(async (_row?: unknown) => ({ ok: true as const, already: false }));
const mockGetApplicationById = vi.fn();

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../../src/gateway/jobhunt-buttons.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/gateway/jobhunt-buttons.js")>();
  return { ...actual, markRowApplied: (row: unknown) => mockMarkRowApplied(row) };
});

vi.mock("../../../src/db/apply-queries.js", () => ({
  getApplicationById: (...args: unknown[]) => mockGetApplicationById(...args),
}));

const { handleAutoApplyCallback, tryHandlePendingApplyReply, setAutoApplyRunnerForTests, clearAutoApplySessionsForTests } =
  await import("../../../src/gateway/auto-apply.js");
const { refillFromPage, tryLockApply, partitionStuck } = await import("../../../src/gateway/apply-flow.js");
const { loadApplySnapshot, verifyApplyToken } = await import("../../../src/tools/jobhunt/apply-link.js");
const { applyProfilePathFor } = await import("../../../src/tools/jobhunt/apply-profile.js");

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

function ask(label: string, over: Partial<UnansweredQuestion> = {}): UnansweredQuestion {
  return {
    selector: "#q",
    label,
    kind: "ask",
    question: label,
    required: true,
    fieldType: "select",
    options: ["The Netherlands", "Ireland"],
    why: "not yet in dossier",
    ...over,
  };
}

function prep(unanswered: UnansweredQuestion[]): Prep {
  return {
    ok: true,
    platform: "greenhouse",
    targetUrl: ROW.url,
    screenshotPng: Buffer.from("png"),
    summary: {
      filled: 4,
      total: 4 + unanswered.length,
      filledLabels: ["First Name", "Email"],
      filledAnswers: [
        { label: "First Name", value: "Fixture", fieldType: "text", editable: true },
        { label: "Email", value: "fixture@example.com", fieldType: "text", editable: true },
      ],
      unanswered,
      requiredUnanswered: unanswered.filter((u) => u.required),
      hasCaptcha: false,
      readyToSubmit: unanswered.every((u) => !u.required),
    },
  };
}

type Reply = { text: string; extra?: Record<string, unknown> };

function makeCtx(chatId = 888) {
  const replies: Reply[] = [];
  const photos: unknown[] = [];
  const ctx = {
    chat: { id: chatId, type: "private" },
    from: { id: 12345 },
    match: "",
    reply: vi.fn(async (text: string, extra?: Record<string, unknown>) => {
      replies.push({ text, extra });
    }),
    replyWithPhoto: vi.fn(async (file: unknown) => {
      photos.push(file);
    }),
    answerCallbackQuery: vi.fn(async () => undefined),
    editMessageReplyMarkup: vi.fn(async () => undefined),
  };
  return { ctx, replies, photos };
}

function buttons(extra?: Record<string, unknown>): Btn[] {
  const kb = extra?.["reply_markup"] as { inline_keyboard?: Btn[][] } | undefined;
  return (kb?.inline_keyboard ?? []).flat();
}

function urlButtons(replies: Reply[]): Btn[] {
  return replies.flatMap((r) => buttons(r.extra)).filter((b) => b.url !== undefined);
}

function hasSubmit(replies: Reply[]): boolean {
  return replies.some((r) => buttons(r.extra).some((b) => b.callback_data?.startsWith("jh:s:")));
}

const ENV_KEYS = ["APPLY_PROFILE_PATH", "CANDIDATE_DOSSIER_PATH", "FOUNDEROS_DATA_ROOT", "APPLY_LINK_SECRET", "APPLY_LINK_BASE_URL"];
let tmpDir: string;
let saved: Record<string, string | undefined>;
let prepareCalls: number;

async function writeProfile(): Promise<void> {
  const resume = path.join(tmpDir, "cv-test.pdf");
  await fs.writeFile(resume, Buffer.from("%PDF-1.4 test cv"));
  const profile = { first_name: "Pushkar", last_name: "Verma", email: "p@example.com", phone: "+31 6 11112222", default_resume: resume };
  await fs.writeFile(process.env["APPLY_PROFILE_PATH"] ?? "", JSON.stringify(profile));
}

function script(results: Prep[], submitOk = true): void {
  prepareCalls = 0;
  const failed = { ok: false, reason: "boom" };
  const sent = { ok: true, platform: "greenhouse", clicked: true, confirmed: true, evidence: "Confirmed", afterScreenshotPng: Buffer.from("after") };
  setAutoApplyRunnerForTests({
    prepare: async () => results[Math.min(prepareCalls++, results.length - 1)] as Prep,
    submit: async () => (submitOk ? sent : failed) as never,
  });
}

describe("apply flow", () => {
  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-apply-flow-"));
    process.env["APPLY_PROFILE_PATH"] = path.join(tmpDir, "apply-profile.json");
    process.env["FOUNDEROS_DATA_ROOT"] = tmpDir;
    process.env["APPLY_LINK_SECRET"] = SECRET;
    process.env["APPLY_LINK_BASE_URL"] = BASE_URL;
    delete process.env["CANDIDATE_DOSSIER_PATH"];
    await writeProfile();
    clearAutoApplySessionsForTests();
    mockMarkRowApplied.mockClear();
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

  it("sends a text card with the hosted link, writes the snapshot, and still asks in Telegram", async () => {
    script([prep([ask(WHERE)])]);
    const { ctx, replies, photos } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);

    expect(photos).toHaveLength(0);
    const card = replies.find((r) => r.text.includes("Filled 4/5"));
    expect(card?.text).toContain("Telnyx");
    expect(card?.extra?.["link_preview_options"]).toEqual({ is_disabled: true });
    const link = buttons(card?.extra).find((b) => b.url !== undefined);
    expect(link?.text).toMatch(/Open form to finish \(1 left\)/);
    expect(link?.url?.startsWith(`${BASE_URL}/apply/`)).toBe(true);

    const token = (link?.url ?? "").slice(`${BASE_URL}/apply/`.length);
    expect(verifyApplyToken(SECRET, token, PROFILE, Date.now())).toMatchObject({ ok: true, rowId: ROW_ID });
    const snap = loadApplySnapshot(ROW_ID, tmpDir);
    expect(snap).toMatchObject({ chatId: "888", profileId: PROFILE, company: "Telnyx", platform: "greenhouse" });
    expect(snap?.summary.unanswered.map((q) => q.label)).toEqual([WHERE]);
    expect(snap?.summary.filledLabels).toEqual(["First Name", "Email"]);
    expect(snap?.summary.filledAnswers).toEqual([
      { label: "First Name", value: "Fixture", fieldType: "text", editable: true },
      { label: "Email", value: "fixture@example.com", fieldType: "text", editable: true },
    ]);
    expect(replies.some((r) => r.text.includes("Question 1/1"))).toBe(true);
  });

  it("says why the link is unavailable and keeps the Telegram questions working", async () => {
    delete process.env["APPLY_LINK_SECRET"];
    script([prep([ask(WHERE)])]);
    const { ctx, replies } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);

    const card = replies.find((r) => r.text.includes("Filled 4/5"));
    expect(card?.text).toContain("answer link unavailable: APPLY_LINK_SECRET not set");
    expect(urlButtons(replies)).toHaveLength(0);
    expect(replies.some((r) => r.text.includes("Question 1/1"))).toBe(true);
  });

  it("does not ask again a question answered in this session that comes back unfilled (button answer)", async () => {
    script([prep([ask(WHERE)])]);
    const { ctx, replies } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    expect(replies.filter((r) => r.text.includes("Question 1/1"))).toHaveLength(1);

    await handleAutoApplyCallback(ctx as never, `jh:q:${ROW_ID}:0`);

    expect(prepareCalls).toBe(2);
    expect(replies.filter((r) => r.text.includes("Question 1/1"))).toHaveLength(1);
    const stuck = replies.find((r) => r.text.includes("Couldn't fill"));
    expect(stuck?.text).toContain(WHERE);
    expect(stuck?.text).toContain("The Netherlands");
    expect(stuck?.text).toContain("answer page");
    expect(buttons(stuck?.extra).some((b) => b.url?.startsWith(`${BASE_URL}/apply/`))).toBe(true);
    expect(hasSubmit(replies)).toBe(false);
    expect(replies.some((r) => r.text.includes("Form ready"))).toBe(false);
    expect(await tryHandlePendingApplyReply(ctx as never, "hello there")).toBe(false);
    expect(loadApplySnapshot(ROW_ID, tmpDir)?.summary.unanswered[0]).toMatchObject({ label: WHERE, triedAnswer: "The Netherlands" });
  });

  it("applies the same guard to a typed answer", async () => {
    const free = ask(WHERE, { fieldType: "text", options: undefined });
    script([prep([free])]);
    const { ctx, replies } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    expect(await tryHandlePendingApplyReply(ctx as never, "Ireland")).toBe(true);

    expect(replies.filter((r) => r.text.includes("Question 1/1"))).toHaveLength(1);
    expect(replies.some((r) => r.text.includes("Couldn't fill") && r.text.includes("Ireland"))).toBe(true);
    expect(await tryHandlePendingApplyReply(ctx as never, "hello there")).toBe(false);
  });

  it("still offers Submit when only an optional question is stuck", async () => {
    script([prep([ask(WHERE, { required: false })])]);
    const { ctx, replies } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    await handleAutoApplyCallback(ctx as never, `jh:q:${ROW_ID}:0`);

    expect(replies.some((r) => r.text.includes("Couldn't fill"))).toBe(true);
    expect(replies.some((r) => r.text.includes("Form ready"))).toBe(true);
    expect(hasSubmit(replies)).toBe(true);
    expect(replies.filter((r) => r.text.includes("Question 1/1"))).toHaveLength(1);
  });

  it("leads the Submit keyboard with the hosted link and labels the company page as not prefilled", async () => {
    script([prep([ask(WHERE)]), prep([])]);
    const { ctx, replies } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    await handleAutoApplyCallback(ctx as never, `jh:q:${ROW_ID}:1`);

    const ready = replies.find((r) => r.text.includes("Form ready"));
    const all = buttons(ready?.extra);
    expect(all[0]?.url?.startsWith(`${BASE_URL}/apply/`)).toBe(true);
    expect(all.some((b) => b.callback_data === `jh:s:${ROW_ID}`)).toBe(true);
    expect(all.find((b) => b.url === ROW.url)?.text).toContain("Company page (not prefilled)");
    expect(all.some((b) => b.text.includes("Open form manually"))).toBe(false);
  });

  it("shows no hosted button when the link cannot be built, and still labels the company page", async () => {
    delete process.env["APPLY_LINK_BASE_URL"];
    script([prep([])]);
    const { ctx, replies } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);

    const ready = replies.find((r) => r.text.includes("Form ready"));
    const all = buttons(ready?.extra);
    expect(all.filter((b) => b.url !== undefined).map((b) => b.text)).toEqual(["🔗 Company page (not prefilled)"]);
    expect(replies.find((r) => r.text.includes("Filled 4/4"))?.text).toContain("answer link unavailable: APPLY_LINK_BASE_URL not set");
  });

  it("puts the hosted link on a failed-submit reply too", async () => {
    script([prep([])], false);
    const { ctx, replies } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    await handleAutoApplyCallback(ctx as never, `jh:s:${ROW_ID}`);

    const failed = replies.find((r) => r.text.includes("Could not submit"));
    expect(failed).toBeDefined();
    expect(buttons(failed?.extra)[0]?.url?.startsWith(`${BASE_URL}/apply/`)).toBe(true);
  });

  it("deletes the snapshot on cancel and after a confirmed submit, so the link dies with the session", async () => {
    script([prep([])]);
    const { ctx } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    expect(loadApplySnapshot(ROW_ID, tmpDir)).not.toBeNull();
    await handleAutoApplyCallback(ctx as never, `jh:k:${ROW_ID}`);
    expect(loadApplySnapshot(ROW_ID, tmpDir)).toBeNull();

    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    expect(loadApplySnapshot(ROW_ID, tmpDir)).not.toBeNull();
    await handleAutoApplyCallback(ctx as never, `jh:s:${ROW_ID}`);
    expect(mockMarkRowApplied).toHaveBeenCalledTimes(1);
    expect(loadApplySnapshot(ROW_ID, tmpDir)).toBeNull();
  });

  it("refuses a second re-fill of the same row while one is running", async () => {
    script([prep([ask(WHERE)])]);
    const release = tryLockApply(ROW_ID);
    expect(release).not.toBeNull();
    const { ctx, replies } = makeCtx();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);

    expect(prepareCalls).toBe(0);
    expect(replies.some((r) => r.text.includes("already re-filling"))).toBe(true);
    release?.();
    await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
    expect(prepareCalls).toBe(1);
  });

  describe("page-triggered re-fill", () => {
    function recorder() {
      const sent: Reply[] = [];
      const sender = {
        text: async (html: string, kb?: unknown) => {
          sent.push({ text: html, extra: kb ? { reply_markup: kb } : undefined });
        },
      };
      return { sent, sender };
    }

    async function firstCard(): Promise<NonNullable<ReturnType<typeof loadApplySnapshot>>> {
      const { ctx } = makeCtx();
      await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
      const snap = loadApplySnapshot(ROW_ID, tmpDir);
      if (!snap) throw new Error("fixture snapshot missing");
      return snap;
    }

    it("re-fills once, sends the ready card to the snapshot chat sender, and frees the lock", async () => {
      script([prep([ask(WHERE)]), prep([])]);
      const snap = await firstCard();
      const { sent, sender } = recorder();
      const release = tryLockApply(ROW_ID);
      await refillFromPage(snap, [{ label: WHERE, answer: "Ireland" }], release as () => void, sender);

      expect(prepareCalls).toBe(2);
      expect(sent.some((m) => m.text.includes("Form ready") && hasSubmit([m]))).toBe(true);
      expect(tryLockApply(ROW_ID)).not.toBeNull();
    });

    it("does not offer Submit and names the stuck answer when the form still will not take it", async () => {
      script([prep([ask(WHERE)])]);
      const snap = await firstCard();
      const { sent, sender } = recorder();
      await refillFromPage(snap, [{ label: WHERE, answer: "Ireland" }], tryLockApply(ROW_ID) as () => void, sender);

      expect(sent.some((m) => m.text.includes("Couldn't fill") && m.text.includes("Ireland"))).toBe(true);
      expect(hasSubmit(sent)).toBe(false);
      expect(sent.some((m) => m.text.includes("Question 1"))).toBe(false);
    });

    it("tells the chat when preparation fails or crashes, and still frees the lock", async () => {
      script([prep([ask(WHERE)])]);
      const snap = await firstCard();
      const { sent, sender } = recorder();
      setAutoApplyRunnerForTests({ prepare: async () => ({ ok: false, reason: "nope" }) as never });
      await refillFromPage(snap, [], tryLockApply(ROW_ID) as () => void, sender);
      expect(sent.some((m) => m.text.includes("Form preparation failed") && m.text.includes("nope"))).toBe(true);

      setAutoApplyRunnerForTests({ prepare: async () => Promise.reject(new Error("kaboom")) });
      await refillFromPage(snap, [], tryLockApply(ROW_ID) as () => void, sender);
      expect(sent.some((m) => m.text.includes("kaboom"))).toBe(true);
      expect(tryLockApply(ROW_ID)).not.toBeNull();
    });
  });

  describe("skipping a question", () => {
    const WHY = "Why do you want this role?";

    it("does not unlock Submit when the last required question is skipped, and lists what is missing", async () => {
      script([prep([ask(WHERE)])]);
      const { ctx, replies } = makeCtx();
      await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
      await handleAutoApplyCallback(ctx as never, `jh:q:${ROW_ID}:skip`);

      expect(hasSubmit(replies)).toBe(false);
      expect(replies.some((r) => r.text.includes("Ready to submit"))).toBe(false);
      const missing = replies.find((r) => r.text.includes("Still missing"));
      expect(missing?.text).toContain(WHERE);
      expect(buttons(missing?.extra).some((b) => b.url?.startsWith(`${BASE_URL}/apply/`))).toBe(true);
      expect(prepareCalls).toBe(1);
    });

    it("still unlocks Submit when only an optional question is skipped", async () => {
      script([prep([ask(WHERE, { required: false })])]);
      const { ctx, replies } = makeCtx();
      await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
      await handleAutoApplyCallback(ctx as never, `jh:q:${ROW_ID}:skip`);

      expect(replies.some((r) => r.text.includes("Ready to submit"))).toBe(true);
      expect(hasSubmit(replies)).toBe(true);
    });

    it("keeps a skipped required question blocking after a later answer re-fills the form, and never re-asks it", async () => {
      const free = ask(WHY, { fieldType: "text", options: undefined });
      script([prep([free, ask(WHERE)]), prep([free])]);
      const { ctx, replies } = makeCtx();
      await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
      await handleAutoApplyCallback(ctx as never, `jh:q:${ROW_ID}:skip`);
      await handleAutoApplyCallback(ctx as never, `jh:q:${ROW_ID}:0`);

      expect(prepareCalls).toBe(2);
      expect(replies.filter((r) => r.text.includes("Question 1/2"))).toHaveLength(1);
      expect(replies.filter((r) => r.text.includes("Question 2/2"))).toHaveLength(1);
      expect(replies.some((r) => r.text.includes("Question 1/1"))).toBe(false);
      expect(hasSubmit(replies)).toBe(false);
      expect(replies.some((r) => r.text.includes("Still missing") && r.text.includes(WHY))).toBe(true);
      expect(await tryHandlePendingApplyReply(ctx as never, "hello there")).toBe(false);
    });

    it("drops a skipped question once the form fills it by itself", async () => {
      const free = ask(WHY, { fieldType: "text", options: undefined });
      script([prep([free, ask(WHERE)]), prep([])]);
      const { ctx, replies } = makeCtx();
      await handleAutoApplyCallback(ctx as never, `jh:f:${ROW_ID}`);
      await handleAutoApplyCallback(ctx as never, `jh:q:${ROW_ID}:skip`);
      await handleAutoApplyCallback(ctx as never, `jh:q:${ROW_ID}:0`);

      expect(replies.some((r) => r.text.includes("Form ready"))).toBe(true);
      expect(hasSubmit(replies)).toBe(true);
    });
  });

  describe("partitionStuck", () => {
    it("splits into pending, stuck and skipped, matching on the normalised label", () => {
      const a = ask("Work permit (required)");
      const b = ask("Why us?");
      const c = ask("Notice period?");
      const out = partitionStuck([a, b, c], [{ label: "work permit", answer: "Yes" }], [c]);
      expect(out.stuck).toEqual([{ question: a, answer: "Yes" }]);
      expect(out.skipped).toEqual([c]);
      expect(out.pending).toEqual([b]);
    });

    it("lets an answer win over a skip, and keeps everything pending with no history", () => {
      const a = ask("Why us?");
      expect(partitionStuck([a], [{ label: "Why us?", answer: "Because" }], [a]).stuck).toHaveLength(1);
      expect(partitionStuck([a], [], [])).toEqual({ pending: [a], stuck: [], skipped: [] });
    });
  });

  describe("tryLockApply", () => {
    const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);
    const MIN = 60_000;

    it("allows one holder per row and frees on release, idempotently", () => {
      const first = tryLockApply(ROW_ID, T0);
      expect(first).not.toBeNull();
      expect(tryLockApply(ROW_ID, T0 + MIN)).toBeNull();
      expect(tryLockApply("99999999-2222-4333-8444-555555555555", T0)).not.toBeNull();
      first?.();
      first?.();
      expect(tryLockApply(ROW_ID, T0 + MIN)).not.toBeNull();
    });

    it("steals a lock left by a crashed run, and the old holder cannot free the new one", () => {
      const first = tryLockApply(ROW_ID, T0);
      const stolen = tryLockApply(ROW_ID, T0 + 11 * MIN);
      expect(stolen).not.toBeNull();
      first?.();
      expect(tryLockApply(ROW_ID, T0 + 11 * MIN + 1)).toBeNull();
      stolen?.();
      expect(tryLockApply(ROW_ID, T0 + 11 * MIN + 2)).not.toBeNull();
    });
  });
});
