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

import { InlineKeyboard, InputFile, type Context } from "grammy";
import { getApplicationById } from "../db/apply-queries.js";
import type { JobApplication } from "../db/schema.js";
import { childLogger } from "../infra/logger.js";
import { DRAFT_SECTIONS } from "../tools/jobhunt/apply-packet.js";
import { recordLearnedAnswer } from "../tools/jobhunt/candidate-dossier.js";
import { namesCompany } from "../tools/jobhunt/company-answer.js";
import { JOB_CALLBACK_PREFIX } from "../tools/jobhunt/job-ref.js";
import { getProfile, type JobSearchProfile } from "../tools/jobhunt/profile-config.js";
import {
  advanceAfterQuestion,
  buildQuestionKeyboard,
  fileQuestionNotice,
  isFileQuestion,
  opensInTelegram,
} from "./apply-flow.js";
import { applyHomeUrl } from "./apply-home.js";
import { prepareRow } from "./apply-prepare.js";
import { runSubmit, type SubmitIo } from "./apply-submit.js";
import {
  cardTag,
  ctxSender,
  endSession,
  isStaleTap,
  markSkipped,
  type PendingApplySession,
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

/** Start the one-click auto-apply flow for a resolved row. The work is prepareRow (apply-prepare.ts); this adds the chat replies. */
export async function startAutoApplyForRow(ctx: Context, row: JobApplication, profile: JobSearchProfile): Promise<void> {
  const send = ctxSender(ctx);
  const result = await prepareRow(row, profile, String(ctx.chat?.id ?? "unknown"), send);
  if (result.kind === "started") return;
  if (result.reason === "lock-held") await send.text(result.html);
  else await ctx.reply(result.html, { parse_mode: "HTML" });
}

/** `/apply <rank|id>` and `/wife_apply <rank|id>` command handler. */
export async function handleAutoApply(ctx: Context): Promise<void> {
  const selected = resolveProfileArg(ctx.match?.toString() ?? "", [], (rest) => parseRowRef(rest) !== null);
  if (isProfileArgMiss(selected)) {
    await ctx.reply(profileMissMessage(selected));
    return;
  }
  const chatId = String(ctx.chat?.id ?? "");
  const home = selected.rest.trim() === "" ? applyHomeUrl() : null;
  if (home && opensInTelegram(chatId, home)) {
    await ctx.reply("Pick a job to apply to:", { reply_markup: new InlineKeyboard().webApp("📋 Open job list", home) });
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

/**
 * Keep an answer for this form, and save it for every later form unless it names this form's company
 * ("Mollie's Career Site" is not an answer for anyone else). Returns the chat line to send.
 */
async function keepAnswer(session: PendingApplySession, label: string, answer: string): Promise<string> {
  rememberAnswer(session, label, answer);
  const shown = `<b>${safeHtml(label)}</b> → <code>${safeHtml(answer)}</code>`;
  if (namesCompany(answer, session.company)) {
    log.info({ profileId: session.profileId, question: label }, "Learned answer names the company; used for this form only");
    return `📝 Used for this form only, not saved (it names ${safeHtml(session.company)}): ${shown}`;
  }
  await recordLearnedAnswer(session.profileId, label, answer);
  log.info({ profileId: session.profileId, question: label }, "Saved learned form answer from chat reply");
  return `💾 Saved to ${safeHtml(session.candidateName)}'s dossier: ${shown}`;
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

  await ctx.reply(await keepAnswer(session, q.label, trimmed), { parse_mode: "HTML" });
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
    const reply = await keepAnswer(session, q.label, chosen);
    await ctx.answerCallbackQuery({ text: `Saved: ${chosen.slice(0, 30)}` });
    await ctx.reply(reply, { parse_mode: "HTML" });
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
