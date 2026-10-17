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

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { InputFile, type Context } from "grammy";
import { ARTIFACT_ROOT, TENANT } from "../core/config.js";
import { getApplicationById } from "../db/apply-queries.js";
import type { JobApplication } from "../db/schema.js";
import { childLogger } from "../infra/logger.js";
import { readFullCvText } from "../tools/career.js";
import { DRAFT_SECTIONS, getApplyUrl, tailoredCvPath } from "../tools/jobhunt/apply-packet.js";
import { applyProfilePathFor, readApplyProfile, type ApplyProfile } from "../tools/jobhunt/apply-profile.js";
import { readCandidateDossier, recordLearnedAnswer } from "../tools/jobhunt/candidate-dossier.js";
import { renderCvToPdf } from "../tools/jobhunt/cv-renderer.js";
import { JOB_CALLBACK_PREFIX } from "../tools/jobhunt/job-ref.js";
import { getProfile, type JobSearchProfile } from "../tools/jobhunt/profile-config.js";
import { advanceAfterQuestion, answerLink, buildSubmitKeyboard, runFormPrepAndPrompt } from "./apply-flow.js";
import {
  acquireApplyLock,
  ctxSender,
  endSession,
  getRunnerDeps,
  markSkipped,
  newSession,
  rememberAnswer,
  sessionForChat,
  sessionForRow,
} from "./apply-session.js";
import { markRowApplied } from "./jobhunt-buttons.js";
import { isProfileArgMiss, profileMissMessage, resolveProfileArg } from "./jobhunt-profile-arg.js";
import { parseRowRef, resolveRowRef, unresolvedMessage } from "./jobhunt-row-ref.js";
import { safeHtml } from "./safe-html.js";

export { clearAutoApplySessionsForTests, setAutoApplyRunnerForTests } from "./apply-session.js";

const log = childLogger({ module: "gateway:auto-apply" });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function artifactDirForChat(chatId: string): string {
  return path.join(ARTIFACT_ROOT, `${TENANT}:${chatId}`.replace(/[^a-zA-Z0-9_.-]/g, "_"));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function resolveResumePdf(
  row: JobApplication,
  profile: JobSearchProfile,
  applyProfile: ApplyProfile,
  artifactDir: string,
): Promise<{ readonly ok: true; readonly pdfPath: string } | { readonly ok: false; readonly reason: string }> {
  const tailored = tailoredCvPath(artifactDir, row);
  if (await fileExists(tailored)) return { ok: true, pdfPath: tailored };

  const configured = (row.track ? applyProfile.resumes?.[row.track] : undefined) ?? applyProfile.default_resume ?? "";
  if (configured && (await fileExists(configured))) return { ok: true, pdfPath: configured };

  const trackConfig = row.track ? profile.tracks[row.track] : undefined;
  const explicitPaths = [...(trackConfig?.cvPath ? [trackConfig.cvPath] : []), ...(profile.baseCvPath ? [profile.baseCvPath] : [])];
  const cv = readFullCvText(row.track, explicitPaths.length > 0 ? explicitPaths : undefined);
  if (!cv.ok) return { ok: false, reason: `Configured resume (${configured || "unset"}) is missing and base CV read failed: ${cv.error}` };

  try {
    await fs.mkdir(artifactDir, { recursive: true });
    const rendered = await renderCvToPdf(cv.text);
    const fallbackPath = path.join(artifactDir, `cv-base-${profile.id}.pdf`);
    await fs.writeFile(fallbackPath, rendered.pdfBuffer);
    return { ok: true, pdfPath: fallbackPath };
  } catch (err) {
    return { ok: false, reason: `Could not render fallback CV PDF: ${(err as Error).message}` };
  }
}


/** Start the one-click auto-apply flow for a resolved row. */
export async function startAutoApplyForRow(ctx: Context, row: JobApplication, profile: JobSearchProfile): Promise<void> {
  const chatId = String(ctx.chat?.id ?? "unknown");
  const loaded = await readApplyProfile(applyProfilePathFor(profile.id));
  if (!loaded.ok) {
    await ctx.reply(`⚠ No usable apply profile for ${safeHtml(profile.candidateName)} (${safeHtml(loaded.reason)}). Send <code>/profile</code> first.`, { parse_mode: "HTML" });
    return;
  }

  const pdfResolved = await resolveResumePdf(row, profile, loaded.profile, artifactDirForChat(chatId));
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
  try {
    await ctx.reply(`🤖 Opening ${safeHtml(row.company)}'s form for ${safeHtml(profile.candidateName)} and filling from your dossier…`, { parse_mode: "HTML" });
    const base = {
      rowId: row.id, chatId, profileId: profile.id, candidateName: profile.candidateName,
      company: row.company, title: row.title, targetUrl, resumePdfPath: pdfResolved.pdfPath,
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
  const [kind, rowId, choiceToken = ""] = data.slice(JOB_CALLBACK_PREFIX.length).split(":");
  if (!kind || !rowId || !UUID_PATTERN.test(rowId)) return false;
  if (kind !== "f" && kind !== "q" && kind !== "s" && kind !== "k") return false;

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

  const row = await getApplicationById(rowId, getProfile().tenantId);
  if (!row) {
    await ctx.answerCallbackQuery({ text: "That role is no longer on file." });
    return true;
  }
  const profile = getProfile(row.profile_id);
  const loaded = await readApplyProfile(applyProfilePathFor(profile.id));
  if (!loaded.ok) {
    await ctx.answerCallbackQuery({ text: "Apply profile unreadable" });
    return true;
  }
  const pdfResolved = await resolveResumePdf(row, profile, loaded.profile, artifactDirForChat(String(ctx.chat?.id ?? "unknown")));
  if (!pdfResolved.ok) {
    await ctx.answerCallbackQuery({ text: "Resume missing" });
    return true;
  }

  await ctx.answerCallbackQuery({ text: "Submitting application…" });
  await ctx.reply(`🚀 Submitting your application to <b>${safeHtml(row.company)}</b>…`, { parse_mode: "HTML" });

  const dossier = (await readCandidateDossier(profile.id)) ?? undefined;
  const session = sessionForRow(rowId);
  const targetUrl = session?.targetUrl ?? getApplyUrl(row.url ?? "", row.company) ?? row.url ?? "";
  const result = await getRunnerDeps().submit(targetUrl, row.company, loaded.profile, { resumePath: pdfResolved.pdfPath }, dossier);

  if (!result.ok) {
    await ctx.reply(`⚠ <b>Could not submit for ${safeHtml(row.company)}</b>: ${safeHtml(result.reason)}`, {
      parse_mode: "HTML",
      reply_markup: buildSubmitKeyboard(row.id, targetUrl, answerLink(row.id)),
    });
    return true;
  }

  if (result.afterScreenshotPng.length > 0) {
    await ctx.replyWithPhoto(new InputFile(result.afterScreenshotPng, `apply-submit-${row.id.slice(0, 8)}.png`), {
      caption: `${row.company} — post-submit (${result.confirmed ? "confirmed" : "needs attention"})`,
    });
  }

  if (result.confirmed) {
    await markRowApplied(row);
    endSession(rowId);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(
      // allow-failopen: cosmetic; the application is already submitted and recorded.
      () => undefined,
    );
    await ctx.reply(`✅ <b>Application submitted and marked applied</b> — ${safeHtml(row.company)} (${safeHtml(row.title)}). It's off today's queue.`, { parse_mode: "HTML" });
  } else {
    await ctx.reply(
      `⚠ <b>Could not confirm submission for ${safeHtml(row.company)}</b>: ${safeHtml(result.evidence)}\nCheck the screenshot above or open the form directly.`,
      { parse_mode: "HTML", reply_markup: buildSubmitKeyboard(row.id, targetUrl, answerLink(row.id)) },
    );
  }
  return true;
}
