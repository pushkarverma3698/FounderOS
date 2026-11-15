/**
 * Hand-off card: "📋 Copy answers" on every stop that leaves the candidate to apply by hand.
 * Scripted runner, temp data root, no network. Proves, for each stop reason (unsupported platform, no
 * fillable form fields, a bot check found after scraping):
 *  1. the card keeps the reason and offers a web_app button to <link>/handoff in a private chat (a url button in a group);
 *  2. a stop before a fillable form saves a snapshot the panel can open, marked blocked, never ready to submit;
 *  3. without link config the reason is still said, with no dead button;
 *  4. a normal ready form does not get the button.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { prepareApplicationForm } from "../../../src/tools/jobhunt/form-runner.js";

const ROW_ID = "11111111-2222-4333-8444-555555555555";
const SECRET = "s3cret-for-tests-0123456789abcdef";
const BASE_URL = "https://apply.example.test";
const PROFILE = "pushkar-nl-tech";
const JOB_URL = "https://jobs.example.test/acme/1";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { setAutoApplyRunnerForTests } = await import("../../../src/gateway/apply-session.js");
const { runFormPrepAndPrompt } = await import("../../../src/gateway/apply-flow.js");
const { newSession, clearAutoApplySessionsForTests } = await import("../../../src/gateway/apply-session.js");
const { loadApplySnapshot } = await import("../../../src/tools/jobhunt/apply-link.js");

type Prep = Awaited<ReturnType<typeof prepareApplicationForm>>;
type Btn = { text: string; url?: string; callback_data?: string; web_app?: { url: string } };
interface Sent { readonly text: string; readonly buttons: Btn[] }

const ENV_KEYS = ["APPLY_PROFILE_PATH", "CANDIDATE_DOSSIER_PATH", "FOUNDEROS_DATA_ROOT", "APPLY_LINK_SECRET", "APPLY_LINK_BASE_URL"];
let tmpDir: string;
let saved: Record<string, string | undefined>;

const sessionFor = (chatId: string) =>
  newSession({
    rowId: ROW_ID, chatId, profileId: PROFILE, candidateName: "Ada Fixture", company: "Acme", title: "Support Engineer",
    targetUrl: JOB_URL, resumePdfPath: path.join(tmpDir, "cv-test.pdf"),
  });

function recorder(): { sent: Sent[]; sender: { text: (html: string, kb?: { inline_keyboard: Btn[][] }) => Promise<void> } } {
  const sent: Sent[] = [];
  return { sent, sender: { text: async (text, kb) => void sent.push({ text, buttons: (kb?.inline_keyboard ?? []).flat() }) } };
}

const failed = (reason: string, platform: string | null): Prep => ({ ok: false, reason, platform }) as Prep;

const botChecked: Prep = {
  ok: true, platform: "lever", targetUrl: JOB_URL, screenshotPng: Buffer.from("png"),
  summary: {
    filled: 2, total: 3, filledLabels: ["Email"], requiredUnanswered: [], unanswered: [], hasCaptcha: true, readyToSubmit: false,
    filledAnswers: [{ label: "Email", value: "ada@example.test", fieldType: "text", editable: true }],
    formFields: [{ label: "Email", fieldType: "text", value: "ada@example.test" }, { label: "Phone", fieldType: "text" }],
  },
};

const readyForm: Prep = { ...botChecked, summary: { ...botChecked.summary, hasCaptcha: false, readyToSubmit: true } } as Prep;

async function run(prep: Prep, chatId = "888"): Promise<Sent[]> {
  setAutoApplyRunnerForTests({ prepare: async () => prep, coverLetter: async () => ({ ok: false, reason: "not in this test" }) });
  const { sent, sender } = recorder();
  await runFormPrepAndPrompt(sender as never, sessionFor(chatId), () => undefined);
  return sent;
}

const copyButton = (sent: Sent[]): Btn | undefined => sent.flatMap((s) => s.buttons).find((b) => b.text.includes("Copy answers"));

describe("hand-off card", () => {
  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-handoff-card-"));
    process.env["APPLY_PROFILE_PATH"] = path.join(tmpDir, "apply-profile.json");
    process.env["FOUNDEROS_DATA_ROOT"] = tmpDir;
    process.env["APPLY_LINK_SECRET"] = SECRET;
    process.env["APPLY_LINK_BASE_URL"] = BASE_URL;
    delete process.env["CANDIDATE_DOSSIER_PATH"];
    await fs.writeFile(path.join(tmpDir, "cv-test.pdf"), Buffer.from("%PDF-1.4 test cv"));
    await fs.writeFile(process.env["APPLY_PROFILE_PATH"], JSON.stringify({ first_name: "Ada", last_name: "Fixture", email: "ada@example.test", phone: "1" }));
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

  const stops: ReadonlyArray<readonly [string, Prep, string]> = [
    ["an unsupported platform", failed("Workday requires per-company account creation and multi-step login", null), "Workday requires"],
    ["no fillable form fields", failed("SmartRecruiters: the apply page showed no form fields (it may need a login or a custom widget)", "smartrecruiters"), "no form fields"],
    ["a DataDome bot check", failed("SmartRecruiters: the apply page sits behind a DataDome bot check that automated browsers cannot pass; apply by hand from the job link", "smartrecruiters"), "DataDome"],
  ];

  for (const [name, prep, said] of stops) {
    it(`offers Copy answers inside Telegram on ${name}, and keeps the reason`, async () => {
      const sent = await run(prep);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain("Form preparation failed for Acme");
      expect(sent[0]!.text).toContain(said);
      const btn = copyButton(sent);
      expect(btn?.web_app?.url).toMatch(new RegExp(`^${BASE_URL}/apply/${ROW_ID}\\.\\d+\\.[A-Za-z0-9_-]+/handoff$`));
      expect(btn?.url).toBeUndefined();
      expect(sent[0]!.buttons.some((b) => b.text.includes("Company page") && b.url === JOB_URL)).toBe(true);
    });
  }

  it("offers Copy answers when the bot check is found after the form was scraped, with the form's fields saved in order", async () => {
    const sent = await run(botChecked);
    const btn = copyButton(sent);
    expect(btn?.web_app?.url.endsWith("/handoff")).toBe(true);
    expect(loadApplySnapshot(ROW_ID, tmpDir)?.summary.formFields?.map((f) => f.label)).toEqual(["Email", "Phone"]);
  });

  it("uses a plain url button in a group chat, where Telegram refuses web_app", async () => {
    const btn = copyButton(await run(failed("nope", null), "-100123"));
    expect(btn?.web_app).toBeUndefined();
    expect(btn?.url?.endsWith("/handoff")).toBe(true);
  });

  it("saves a hand-off snapshot a panel can open, read as blocked and carrying the reason", async () => {
    await run(failed("Workday requires per-company account creation and multi-step login", null));
    const snap = loadApplySnapshot(ROW_ID, tmpDir);
    expect(snap).toMatchObject({ company: "Acme", targetUrl: JOB_URL, handoffReason: expect.stringContaining("Workday") });
    expect(snap?.summary.hasCaptcha).toBe(true);
    expect(snap?.summary.unanswered).toEqual([]);
  });

  it("keeps a snapshot that already exists instead of replacing it", async () => {
    await run(readyForm);
    const before = loadApplySnapshot(ROW_ID, tmpDir);
    await run(failed("boom", null));
    expect(loadApplySnapshot(ROW_ID, tmpDir)).toEqual(before);
  });

  it("still says the reason, with no dead button, when the link config is missing", async () => {
    delete process.env["APPLY_LINK_SECRET"];
    const sent = await run(failed("Workday requires per-company account creation", null));
    expect(sent[0]!.text).toContain("Workday requires");
    expect(sent[0]!.text).toContain("copy panel unavailable: APPLY_LINK_SECRET not set");
    expect(copyButton(sent)).toBeUndefined();
  });

  it("does not offer Copy answers on a form that is ready to submit", async () => {
    expect(copyButton(await run(readyForm))).toBeUndefined();
  });
});
