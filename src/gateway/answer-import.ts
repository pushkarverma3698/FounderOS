/**
 * FounderOS — /wife_import_answers
 * ================================
 * A candidate's filled-in question document becomes her apply profile and dossier answers. The command reads the
 * document (a reply to a message, an attached .txt/.md, or text after the command), parses it with no model, and
 * shows a preview of every field it would write. Nothing is saved until the sender taps ✅ Save; the save goes
 * through the answer store (backup, then both files written atomically).
 *
 * A group chat sees labels only. Her answers include an address, a phone number and pay, so values appear
 * only in a private chat.
 *
 * Who may import: a sender mapped in JOBHUNT_SENDER_PROFILES for their own profile, or the founder for any.
 */

import { randomBytes } from "node:crypto";
import { InlineKeyboard, type Context } from "grammy";
import { childLogger } from "../infra/logger.js";
import { profileForUser } from "./miniapp-auth.js";
import { isProfileArgMiss, profileMissMessage, resolveProfileArg } from "./jobhunt-profile-arg.js";
import { splitForTelegram } from "../tools/jobhunt/telegram-format.js";
import { DEFAULT_PROFILE_ID } from "../tools/jobhunt/profile-config.js";
import { saveAnswers } from "../tools/jobhunt/answer-store.js";
import { applyPatch, importAnswerDoc, previewLines } from "../tools/jobhunt/answer-doc-apply.js";
import type { AnswerPatch } from "../tools/jobhunt/answer-doc-map.js";

const log = childLogger({ module: "gateway:answer-import" });

export const ANSWER_IMPORT_PREFIX = "jh:ai:";
const MAX_DOC_BYTES = 200_000;
const PENDING_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING = 20;
const USAGE =
  "Send Tashi's answered question document with this command: reply to the message that holds it, " +
  "attach a .txt or .md file with the command as its caption, or paste the text after the command.";

interface Pending { readonly profileId: string; readonly userId: number; readonly patch: AnswerPatch; readonly at: number }
const pending = new Map<string, Pending>();

export function clearAnswerImportsForTests(): void {
  pending.clear();
}

interface DocRef { readonly file_id: string; readonly file_name?: string; readonly file_size?: number }

export interface ImportDeps {
  /** Text of a Telegram document. The default downloads it with the bot token. */
  readonly download: (ctx: Context, fileId: string) => Promise<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
}

async function downloadFromTelegram(ctx: Context, fileId: string): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  const res = await fetch(`https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path ?? ""}`);
  if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
  return res.text();
}

const defaultDeps: ImportDeps = { download: downloadFromTelegram, env: process.env, now: Date.now };

function sweep(now: number): void {
  for (const [k, v] of pending) if (now - v.at > PENDING_TTL_MS) pending.delete(k);
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
}

/** Who may write to which profile: their own, or any when the sender is the founder (default profile). */
function mayImport(senderProfile: string | null, target: string): boolean {
  return senderProfile !== null && (senderProfile === target || senderProfile === DEFAULT_PROFILE_ID);
}

/**
 * The pasted document after the command, line breaks kept. `resolveProfileArg`'s `rest` joins words with single
 * spaces, which runs every numbered question into the previous answer (prod 2026-11-15: Q31 landed in Q14).
 */
export function pastedText(raw: string, explicitProfile: boolean): string {
  const body = raw.replace(/^[ \t]+/, "");
  return explicitProfile ? body.replace(/^\S+[ \t]*\n?/, "") : body;
}

async function sourceText(ctx: Context, rest: string, deps: ImportDeps): Promise<string | null> {
  const msg = ctx.message;
  const doc: DocRef | undefined = msg?.document ?? msg?.reply_to_message?.document;
  if (doc) {
    if ((doc.file_size ?? 0) > MAX_DOC_BYTES) throw new Error("That file is too large for an answer document.");
    if (doc.file_name && !/\.(txt|md|markdown)$/i.test(doc.file_name)) throw new Error("Send a .txt or .md file, or paste the text.");
    return deps.download(ctx, doc.file_id);
  }
  const replied = msg?.reply_to_message?.text ?? msg?.reply_to_message?.caption;
  if (replied) return replied;
  return rest.trim().length > 40 ? rest : null;
}

export async function handleImportAnswers(ctx: Context, deps: ImportDeps = defaultDeps): Promise<void> {
  const arg = resolveProfileArg(ctx.match?.toString() ?? "");
  if (isProfileArgMiss(arg)) {
    await ctx.reply(profileMissMessage(arg));
    return;
  }
  const userId = ctx.from?.id;
  const sender = userId === undefined ? null : profileForUser(userId, deps.env);
  const target = arg.explicit ? arg.profile.id : (sender ?? arg.profile.id);
  if (userId === undefined || !mayImport(sender, target)) {
    await ctx.reply("You can only import answers into your own profile.");
    return;
  }

  let text: string | null;
  try {
    text = await sourceText(ctx, pastedText(ctx.match?.toString() ?? "", arg.explicit), deps);
  } catch (err) {
    await ctx.reply(`Could not read the document: ${(err as Error).message}`);
    return;
  }
  if (text === null) {
    await ctx.reply(USAGE);
    return;
  }

  const { parsed, patch } = await importAnswerDoc(target, text, false);
  const answered = parsed.filter((p) => p.answer !== null && p.answer !== "skip").length;
  if (patch.writes.length === 0) {
    await ctx.reply(`Read ${parsed.length} questions, ${answered} answered, nothing to save. Check that the numbered questions are in the text.`);
    return;
  }

  sweep(deps.now());
  const token = randomBytes(4).toString("hex");
  pending.set(token, { profileId: target, userId, patch, at: deps.now() });
  const kb = new InlineKeyboard().text("✅ Save", `${ANSWER_IMPORT_PREFIX}s:${token}`).text("✖ Cancel", `${ANSWER_IMPORT_PREFIX}c:${token}`);
  const parts = splitForTelegram(`Answers for ${arg.profile.candidateName}: ${parsed.length} questions read, ${answered} answered.\n\n${previewLines(patch, ctx.chat?.type === "private").join("\n")}`);
  for (const [i, part] of parts.entries()) await ctx.reply(part, i === parts.length - 1 ? { reply_markup: kb } : {});
}

/** False when the payload is not ours. A tap by anyone but the sender who asked does nothing. */
export async function handleAnswerImportCallback(ctx: Context, deps: ImportDeps = defaultDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  const m = /^jh:ai:([sc]):([0-9a-f]{8})$/.exec(data);
  if (!m) return false;
  const entry = pending.get(m[2]!);
  if (!entry || deps.now() - entry.at > PENDING_TTL_MS) {
    pending.delete(m[2]!);
    await ctx.answerCallbackQuery({ text: "That preview expired. Send the document again." });
    return true;
  }
  if (ctx.from?.id !== entry.userId) {
    await ctx.answerCallbackQuery({ text: "Only the person who sent it can save this." });
    return true;
  }
  pending.delete(m[2]!);
  // allow-failopen: removing the buttons is cosmetic; the tap itself is handled below.
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
  if (m[1] === "c") {
    await ctx.answerCallbackQuery({ text: "Cancelled. Nothing was saved." });
    return true;
  }
  await ctx.answerCallbackQuery({ text: "Saving…" });
  try {
    const saved = await saveAnswers(entry.profileId, (s) => applyPatch(s, entry.patch));
    log.info({ profileId: entry.profileId, writes: entry.patch.writes.length, ok: saved.ok }, "Answer document imported");
    await ctx.reply(
      saved.ok
        ? `✅ Saved ${entry.patch.writes.length} answers (a backup of the old ones was kept). ${entry.patch.held.length} were skipped or blank and will be asked on each form.`
        : `Nothing was saved: ${saved.reason}`,
    );
  } catch (err) {
    log.error({ profileId: entry.profileId, err: (err as Error).message }, "Answer document save failed");
    await ctx.reply(`Could not save: ${(err as Error).message}. Nothing changed.`);
  }
  return true;
}
