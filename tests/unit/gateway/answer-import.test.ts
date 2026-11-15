/**
 * /wife_import_answers: preview first, save only on the ✅ tap, through the answer store (backup + atomic).
 * Invented candidate and ids; Telegram is a fake ctx.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { handleImportAnswers, handleAnswerImportCallback, clearAnswerImportsForTests } = await import("../../../src/gateway/answer-import.js");
const { applyProfilePathFor } = await import("../../../src/tools/jobhunt/apply-profile.js");
const { candidateDossierPathFor } = await import("../../../src/tools/jobhunt/candidate-dossier.js");
const { listAnswerBackups } = await import("../../../src/tools/jobhunt/answer-store.js");
const { withForcedProfileToken } = await import("../../../src/gateway/jobhunt-profile-arg.js");

const WIFE = "wife-nl-finance";
const FOUNDER = 111;
const TASHI = 222;
const env = { TELEGRAM_CHAT_ID: String(FOUNDER), JOBHUNT_SENDER_PROFILES: `${TASHI}=wife` };
const DOC = [
  "1. Full name exactly as it should appear on applications.",
  "Mira Haldane",
  "3. Phone number with country code. +31 6 5550 0142",
  "12. Nationality or citizenship (many Workday forms ask).",
  "Fictionlander",
  "5. Full postal address (some forms require it).",
  "skip",
].join("\n");

let dir: string;
let prevPath: string | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "answer-import-"));
  prevPath = process.env["APPLY_PROFILE_PATH"];
  process.env["APPLY_PROFILE_PATH"] = path.join(dir, "apply-profile.json");
  await fs.writeFile(applyProfilePathFor(WIFE), JSON.stringify({ first_name: "Old", last_name: "Name", email: "old@example.test", phone: "+31 6 0000 0000" }));
  clearAnswerImportsForTests();
});
afterEach(async () => {
  if (prevPath === undefined) delete process.env["APPLY_PROFILE_PATH"];
  else process.env["APPLY_PROFILE_PATH"] = prevPath;
  await fs.rm(dir, { recursive: true, force: true });
});

interface Sent { text: string; markup?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> } }

function fakeCtx(opts: { from: number; type?: "private" | "group"; replyText?: string; document?: { file_id: string; file_name: string }; match?: string }) {
  const sent: Sent[] = [];
  const ctx = {
    match: opts.match ?? "",
    from: { id: opts.from },
    chat: { id: opts.type === "group" ? -5 : opts.from, type: opts.type ?? "private" },
    message: { reply_to_message: opts.replyText ? { text: opts.replyText } : undefined, document: opts.document },
    reply: vi.fn(async (text: string, other?: { reply_markup?: Sent["markup"] }) => void sent.push({ text, markup: other?.reply_markup })),
    answerCallbackQuery: vi.fn(async () => true),
    editMessageReplyMarkup: vi.fn(async () => true),
    callbackQuery: { data: "" },
  };
  return { ctx, sent };
}
const deps = (download?: (fileId: string) => Promise<string>) => ({ env, now: () => Date.now(), download: async (_c: unknown, id: string) => (download ? download(id) : "") });
const wife = (c: ReturnType<typeof fakeCtx>["ctx"]) => withForcedProfileToken(c as never, "wife");
const tap = (data: string, from: number) => {
  const t = fakeCtx({ from });
  t.ctx.callbackQuery.data = data;
  return t;
};
const profileOnDisk = async () => JSON.parse(await fs.readFile(applyProfilePathFor(WIFE), "utf8")) as Record<string, unknown>;

describe("/wife_import_answers", () => {
  it("shows a preview with values in a private chat and writes nothing before the tap", async () => {
    const { ctx, sent } = fakeCtx({ from: TASHI, replyText: DOC });
    await handleImportAnswers(wife(ctx), deps());
    const text = sent.map((s) => s.text).join("\n");
    expect(text).toContain("Mira");
    expect(text).toContain("Fictionlander");
    expect(text).toContain("Not written");
    expect(sent.at(-1)?.markup?.inline_keyboard[0]?.map((b) => b.text)).toEqual(["✅ Save", "✖ Cancel"]);
    expect((await profileOnDisk())["first_name"]).toBe("Old");
    expect(await listAnswerBackups(WIFE)).toEqual([]);
  });

  it("shows labels only in a group chat", async () => {
    const { ctx, sent } = fakeCtx({ from: TASHI, type: "group", replyText: DOC });
    await handleImportAnswers(wife(ctx), deps());
    const text = sent.map((s) => s.text).join("\n");
    expect(text).toContain("Nationality");
    expect(text).toContain("value hidden");
    expect(text).not.toContain("Fictionlander");
    expect(text).not.toContain("5550");
  });

  it("saves on ✅, through the store: both files, with a backup of the old state", async () => {
    const { ctx, sent } = fakeCtx({ from: TASHI, replyText: DOC });
    await handleImportAnswers(wife(ctx), deps());
    const save = sent.at(-1)!.markup!.inline_keyboard[0]![0]!.callback_data!;
    const t = tap(save, TASHI);
    expect(await handleAnswerImportCallback(t.ctx as never, deps())).toBe(true);

    const profile = await profileOnDisk();
    expect(profile).toMatchObject({ first_name: "Mira", last_name: "Haldane", phone: "+31 6 5550 0142" });
    expect((profile["question_bank"] as Record<string, string>)["Nationality"]).toBe("Fictionlander");
    expect(await fs.readFile(candidateDossierPathFor(WIFE), "utf8")).toContain("**Nationality**: Fictionlander");
    expect((await listAnswerBackups(WIFE)).length).toBe(1);
    expect(t.sent[0]?.text).toMatch(/Saved/);

    // a second tap on the same preview does nothing
    const again = tap(save, TASHI);
    await handleAnswerImportCallback(again.ctx as never, deps());
    expect(again.ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: expect.stringMatching(/expired/) });
    expect((await listAnswerBackups(WIFE)).length).toBe(1);
  });

  it("writes nothing on ✖ Cancel, and refuses a tap from someone else", async () => {
    const { ctx, sent } = fakeCtx({ from: TASHI, replyText: DOC });
    await handleImportAnswers(wife(ctx), deps());
    const [save, cancel] = sent.at(-1)!.markup!.inline_keyboard[0]!.map((b) => b.callback_data!);
    const other = tap(save!, 999);
    await handleAnswerImportCallback(other.ctx as never, deps());
    expect((await profileOnDisk())["first_name"]).toBe("Old");
    await handleAnswerImportCallback(tap(cancel!, TASHI).ctx as never, deps());
    expect((await profileOnDisk())["first_name"]).toBe("Old");
    expect(await listAnswerBackups(WIFE)).toEqual([]);
  });

  it("reads an attached .txt through the download, and refuses other file types", async () => {
    const ok = fakeCtx({ from: TASHI, document: { file_id: "f1", file_name: "answers.txt" } });
    await handleImportAnswers(wife(ok.ctx), deps(async () => DOC));
    expect(ok.sent.at(-1)?.markup).toBeDefined();
    const bad = fakeCtx({ from: TASHI, document: { file_id: "f2", file_name: "answers.pdf" } });
    await handleImportAnswers(wife(bad.ctx), deps());
    expect(bad.sent[0]?.text).toMatch(/\.txt or \.md/);
  });

  it("lets the founder import for her, and refuses everyone else", async () => {
    const founder = fakeCtx({ from: FOUNDER, replyText: DOC });
    await handleImportAnswers(wife(founder.ctx), deps());
    expect(founder.sent.at(-1)?.markup).toBeDefined();
    const stranger = fakeCtx({ from: 333, replyText: DOC });
    await handleImportAnswers(wife(stranger.ctx), deps());
    expect(stranger.sent[0]?.text).toMatch(/only import answers into your own/);
  });

  it("refuses Tashi importing into the founder's profile", async () => {
    const { ctx, sent } = fakeCtx({ from: TASHI, replyText: DOC, match: "pushkar" });
    await handleImportAnswers(ctx as never, deps());
    expect(sent[0]?.text).toMatch(/only import answers into your own/);
  });

  it("explains itself when there is no document", async () => {
    const { ctx, sent } = fakeCtx({ from: TASHI });
    await handleImportAnswers(wife(ctx), deps());
    expect(sent[0]?.text).toMatch(/reply to the message/);
  });
});
