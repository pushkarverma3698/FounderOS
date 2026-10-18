/**
 * FounderOS — Telegram One-Click Auto-Apply & Interactive Q&A
 * ============================================================
 * Connects Telegram (`/apply`, `/wife_apply`, and the `🚀 Auto-Apply` button)
 * to the headless Playwright form runner and candidate dossier (ADR-018:
 * fills and previews automatically, submits only when the user taps Submit).
 *
 * This file is the command and the button handlers. The card, the answer-page link, the re-ask guard
 * and the per-row lock live in apply-flow.ts / apply-session.ts.
 */

import { InputFile, type Context } from "grammy";
import { getApplicationById } from "../db/apply-queries.js";
import type { JobApplication } from "../db/schema.js";
import { childLogger } from "../infra/logger.js";
import { DRAFT_SECTIONS, getApplyUrl } from "../tools/jobhunt/apply-packet.js";
import { applyProfilePathFor, readApplyProfile } from "../tools/jobhunt/apply-profile.js";
import { recordLearnedAnswer } from "../tools/jobhunt/candidate-dossier.js";
import { JOB_CALLBACK_PREFIX } from "../tools/jobhunt/job-ref.js";
import { getProfile, type JobSearchProfile } from "../tools/jobhunt/profile-config.js";
import { coverLetterMessage } from "./apply-cover-letter.js";
import {
  advanceAfterQuestion,
  buildQuestionKeyboard,
  fileQuestionNotice,
  isFileQuestion,
  runFormPrepAndPrompt,
} from "./apply-flow.js";
import { alreadyAppliedMessage, runSubmit, type SubmitIo } from "./apply-submit.js";
import { appliedOn, artifactDirForChat, resolveCoverLetter, resolveResumePdf } from "./apply-material.js";
import {
  acquireApplyLock,
  cardTag,
  ctxSender,
  endSession,
  forgetUnconfirmedClick,
  isStaleTap,
  markSkipped,
  newSession,
  questionTag,
  rememberAnswer,
  sessionForChat,
  sessionForRow,
  tryLockApply,
} from "./apply-session.js";
import { isProfileArgMiss, profileMissMessage, resolveProfileArg } from "./jobhunt-profile-arg.js";
import { parseRowRef, resolveRowRef, unresolvedMessage } from "./jobhunt-row-ref.js";
import { safeHtml } from "./safe-html.js";

export { clearAutoApplySessionsForTests, setAutoApplyRunnerForTests } from "./apply-session.js";

const log = childLogger({ module: "gateway:auto-apply" });
const STALE_CARD = "This card is out of date; use the latest one";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Answer a refused tap. A tap that waited behind an earlier Submit has expired; the reply after it still goes out. */
function answerLateTap(ctx: Context, text: string): Promise<unknown> {
  return ctx.answerCallbackQuery({ text }).catch(
    // allow-failopen: Telegram refuses answers to expired taps; the chat reply that follows says what happened.
    () => undefined,
  );
}

/** Start the one-click auto-apply flow for a resolved row. */
export async function startAutoApplyForRow(ctx: Context, row: JobApplication, profile: JobSearchProfile): Promise<void> {
  const on = appliedOn(row);
  if (on) {
    await ctx.reply(alreadyAppliedMessage(row, on), { parse_mode: "HTML" });
    return;
  }
  const chatId = String(ctx.chat?.id ?? "unknown");
  const loaded = await readApplyProfile(applyProfilePathFor(profile.id));
  if (!loaded.ok) {
    await ctx.reply(`⚠ No usable apply profile for ${safeHtml(profile.candidateName)} (${safeHtml(loaded.reason)}). Send <code>/profile</code> first.`, { parse_mode: "HTML" });
    return;
  }

  const artifactDir = artifactDirForChat(chatId);
  const pdfResolved = await resolveResumePdf(row, profile, loaded.profile, artifactDir);
  if (!pdfResolved.ok) {
    await ctx.reply(`⚠ Cannot start auto-apply: ${safeHtml(pdfResolved.reason)}`, { parse_mode: "HTML" });
    return;
  }

  const targetUrl = getApplyUrl(row.url ?? "", row.company) ?? row.url ?? "";
  if (!targetUrl) {
    await ctx.reply(`⚠ ${safeHtml(row.company)} has no application URL on file.`, { parse_mode: "HTML" });
    return;
  }

  const send = ctxSender(ctx);
  const held = await acquireApplyLock(send, row.id);
  if (!held) return;
  forgetUnconfirmedClick(row.id); // reopening the form is the deliberate retry the unconfirmed reply names
  try {
    await ctx.reply(`🤖 Opening ${safeHtml(row.company)}'s form for ${safeHtml(profile.candidateName)} and filling from your dossier…`, { parse_mode: "HTML" });
    const letter = await resolveCoverLetter(row, profile, artifactDir);
    if (letter.ok) await ctx.reply(coverLetterMessage(row.company, letter), { parse_mode: "HTML" });
    const base = {
      rowId: row.id, chatId, profileId: profile.id, candidateName: profile.candidateName,
      company: row.company, title: row.title, targetUrl, resumePdfPath: pdfResolved.pdfPath,
      ...(letter.ok ? { coverLetter: letter.letter } : { coverLetterNote: letter.reason }),
    };
    await runFormPrepAndPrompt(send, newSession(base), held);
  } finally {
    held();
  }
}

/** `/apply <rank|id>` and `/wife_apply <rank|id>` command handler. */
export async function handleAutoApply(ctx: Context): Promise<void> {
  const selected = resolveProfileArg(ctx.match?.toString() ?? "", [], (rest) => parseRowRef(rest) !== null);
  if (isProfileArgMiss(selected)) {
    await ctx.reply(profileMissMessage(selected));
    return;
  }
  const ref = parseRowRef(selected.rest);
  if (ref === null) {
    await ctx.reply(unresolvedMessage("apply", null));
    return;
  }
  const resolved = await resolveRowRef(ref, "apply", DRAFT_SECTIONS, selected.profile);
  if (!resolved.ok) {
    await ctx.reply(resolved.message);
    return;
  }
  await startAutoApplyForRow(ctx, resolved.row, selected.profile);
}

/** Intercept plain-text replies when the chat has an active unanswered form question. */
export async function tryHandlePendingApplyReply(ctx: Context, text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) return false;
  const session = sessionForChat(String(ctx.chat?.id ?? ""));
  const q = session?.unanswered[session.questionIndex];
  if (!session || !q) return false;
  if (isFileQuestion(q)) {
    await ctx.reply(`📎 ${fileQuestionNotice(q)} A typed reply cannot fill it. Nothing was saved.`, {
      parse_mode: "HTML",
      reply_markup: buildQuestionKeyboard(session.rowId, q, questionTag(session), cardTag(session)),
    });
    return true;
  }

  await recordLearnedAnswer(session.profileId, q.label, trimmed);
  rememberAnswer(session, q.label, trimmed);
  log.info({ profileId: session.profileId, question: q.label }, "Saved learned form answer from chat reply");
  await ctx.reply(`💾 Saved to ${safeHtml(session.candidateName)}'s dossier: <b>${safeHtml(q.label)}</b> → <code>${safeHtml(trimmed)}</code>`, { parse_mode: "HTML" });
  await advanceAfterQuestion(ctxSender(ctx), session);
  return true;
}

/** Handle `jh:f:`, `jh:q:`, `jh:s:`, and `jh:k:` inline button taps. */
export async function handleAutoApplyCallback(ctx: Context, data: string): Promise<boolean> {
  if (!data.startsWith(JOB_CALLBACK_PREFIX)) return false;
  const [kind, rowId, choiceToken = "", qStamp] = data.slice(JOB_CALLBACK_PREFIX.length).split(":");
  if (!kind || !rowId || !UUID_PATTERN.test(rowId)) return false;
  if (kind !== "f" && kind !== "q" && kind !== "s" && kind !== "k") return false;
  // `jh:f:` comes from the job list and starts a fresh fill on purpose, so it carries no stamp.
  if (kind !== "f" && isStaleTap(rowId, kind, kind === "q" ? qStamp : choiceToken || undefined)) {
    await ctx.answerCallbackQuery({ text: STALE_CARD });
    return true;
  }

  if (kind === "k") {
    endSession(rowId);
    await ctx.answerCallbackQuery({ text: "Cancelled auto-apply" });
    await ctx.reply("⏭ Cancelled auto-apply session.");
    return true;
  }

  if (kind === "f") {
    const row = await getApplicationById(rowId, getProfile().tenantId);
    if (!row) {
      await ctx.answerCallbackQuery({ text: "That role is no longer on file." });
      return true;
    }
    await ctx.answerCallbackQuery({ text: "Filling form…" });
    await startAutoApplyForRow(ctx, row, getProfile(row.profile_id));
    return true;
  }

  if (kind === "q") {
    const session = sessionForRow(rowId);
    const q = session?.unanswered[session.questionIndex];
    if (!session || !q) {
      await ctx.answerCallbackQuery({ text: "Question session expired — tap Auto-Apply again." });
      return true;
    }
    if (choiceToken === "skip") {
      await ctx.answerCallbackQuery({ text: "Skipped question" });
      markSkipped(session, q);
      await advanceAfterQuestion(ctxSender(ctx), session);
      return true;
    }
    const idx = Number(choiceToken);
    const chosen = Number.isInteger(idx) ? q.options?.[idx] : undefined;
    if (!chosen) {
      await ctx.answerCallbackQuery({ text: "Invalid option" });
      return true;
    }
    await recordLearnedAnswer(session.profileId, q.label, chosen);
    rememberAnswer(session, q.label, chosen);
    await ctx.answerCallbackQuery({ text: `Saved: ${chosen.slice(0, 30)}` });
    await ctx.reply(`💾 Saved to ${safeHtml(session.candidateName)}'s dossier: <b>${safeHtml(q.label)}</b> → <code>${safeHtml(chosen)}</code>`, { parse_mode: "HTML" });
    await advanceAfterQuestion(ctxSender(ctx), session);
    return true;
  }

  // Lock before reading the row: a second tap is refused, and never reads a row the first is about to mark applied.
  const release = tryLockApply(rowId, Date.now(), "submit");
  if (!release) {
    await answerLateTap(ctx, "Already in progress");
    await ctx.reply("⏳ This application is already being filled or submitted. Nothing was sent twice.");
    return true;
  }
  try {
    await submitRow(ctx, rowId);
  } finally {
    release();
  }
  return true;
}

/** Re-fill and send one application via the shared path (apply-submit.ts). The caller holds the row's lock. */
async function submitRow(ctx: Context, rowId: string): Promise<void> {
  const io: SubmitIo = {
    text: (html, keyboard) => ctxSender(ctx).text(html, keyboard),
    photo: async (png, caption, filename) => {
      await ctx.replyWithPhoto(new InputFile(png, filename), { caption });
    },
    started: async () => {
      await ctx.answerCallbackQuery({ text: "Submitting application…" });
    },
    settled: async () => {
      await dropTappedKeyboard(ctx);
    },
  };
  const result = await runSubmit(rowId, String(ctx.chat?.id ?? "unknown"), "telegram", io);
  if (result.kind !== "refused") return;
  // A refusal that carries a chat line was a late tap (answer it softly); the others answer the callback itself.
  if (result.html) {
    await answerLateTap(ctx, result.toast);
    await ctx.reply(result.html, { parse_mode: "HTML" });
  } else {
    await ctx.answerCallbackQuery({ text: result.toast });
  }
}

function dropTappedKeyboard(ctx: Context): Promise<unknown> {
  return ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(
    // allow-failopen: best effort; if Telegram refuses the edit, the reply still says what happened and what to do.
    () => undefined,
  );
}
