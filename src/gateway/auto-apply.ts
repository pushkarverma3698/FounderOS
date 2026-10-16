/**
 * FounderOS — Telegram One-Click Auto-Apply & Interactive Q&A
 * ============================================================
 * Connects Telegram (`/apply`, `/wife_apply`, and the `🚀 Auto-Apply` button)
 * to the headless Playwright form runner and candidate dossier (ADR-018:
 * fills and previews automatically, submits only when the user taps Submit).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { InlineKeyboard, InputFile, type Context } from "grammy";
import { ARTIFACT_ROOT, TENANT } from "../core/config.js";
import { getApplicationById } from "../db/apply-queries.js";
import type { JobApplication } from "../db/schema.js";
import { childLogger } from "../infra/logger.js";
import { readFullCvText } from "../tools/career.js";
import { DRAFT_SECTIONS, getApplyUrl, tailoredCvPath } from "../tools/jobhunt/apply-packet.js";
import { applyProfilePathFor, readApplyProfile, type ApplyProfile } from "../tools/jobhunt/apply-profile.js";
import { readCandidateDossier, recordLearnedAnswer } from "../tools/jobhunt/candidate-dossier.js";
import { renderCvToPdf } from "../tools/jobhunt/cv-renderer.js";
import type { FormPlanSummary, UnansweredQuestion } from "../tools/jobhunt/form-brain.js";
import { prepareApplicationForm, submitApplicationForm } from "../tools/jobhunt/form-runner.js";
import { JOB_CALLBACK_PREFIX } from "../tools/jobhunt/job-ref.js";
import { getProfile, type JobSearchProfile } from "../tools/jobhunt/profile-config.js";
import { markRowApplied } from "./jobhunt-buttons.js";
import { isProfileArgMiss, profileMissMessage, resolveProfileArg } from "./jobhunt-profile-arg.js";
import { parseRowRef, resolveRowRef, unresolvedMessage } from "./jobhunt-row-ref.js";
import { safeHtml } from "./safe-html.js";

const log = childLogger({ module: "gateway:auto-apply" });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BUTTON_OPTIONS = 6;
const MAX_BUTTON_LABEL_CHARS = 36;

export interface PendingApplySession {
  readonly rowId: string;
  readonly chatId: string;
  readonly profileId: string;
  readonly candidateName: string;
  readonly company: string;
  readonly title: string;
  readonly targetUrl: string;
  readonly resumePdfPath: string;
  readonly unanswered: readonly UnansweredQuestion[];
  questionIndex: number;
}

const sessionsByChat = new Map<string, PendingApplySession>();
const sessionsByRow = new Map<string, PendingApplySession>();

export interface AutoApplyRunnerDeps {
  readonly prepare: typeof prepareApplicationForm;
  readonly submit: typeof submitApplicationForm;
}

let runnerDeps: AutoApplyRunnerDeps = { prepare: prepareApplicationForm, submit: submitApplicationForm };

export function setAutoApplyRunnerForTests(override?: Partial<AutoApplyRunnerDeps>): void {
  runnerDeps = { prepare: override?.prepare ?? prepareApplicationForm, submit: override?.submit ?? submitApplicationForm };
}

export function clearAutoApplySessionsForTests(): void {
  sessionsByChat.clear();
  sessionsByRow.clear();
}

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

function formatSummaryLine(summary: FormPlanSummary): string {
  const parts = [`Filled ${summary.filled}/${summary.total} fields`];
  if (summary.unanswered.length > 0) parts.push(`${summary.unanswered.length} unanswered (${summary.requiredUnanswered.length} required)`);
  if (summary.hasCaptcha) parts.push("CAPTCHA detected");
  return parts.join(" · ");
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

function buildQuestionKeyboard(rowId: string, q: UnansweredQuestion): InlineKeyboard {
  const kb = new InlineKeyboard();
  const opts = q.options ?? [];
  if (opts.length > 0 && opts.length <= MAX_BUTTON_OPTIONS) {
    opts.forEach((opt, idx) => {
      const label = opt.length > MAX_BUTTON_LABEL_CHARS ? `${opt.slice(0, MAX_BUTTON_LABEL_CHARS - 1)}…` : opt;
      kb.text(label, `${JOB_CALLBACK_PREFIX}q:${rowId}:${idx}`).row();
    });
  }
  return kb.text("⏭ Skip this question", `${JOB_CALLBACK_PREFIX}q:${rowId}:skip`).text("✖ Cancel", `${JOB_CALLBACK_PREFIX}k:${rowId}`);
}

function buildSubmitKeyboard(rowId: string, targetUrl: string): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("🚀 Submit Application", `${JOB_CALLBACK_PREFIX}s:${rowId}`)
    .text("⏭ Cancel", `${JOB_CALLBACK_PREFIX}k:${rowId}`)
    .row();
  if (/^https?:\/\//i.test(targetUrl)) kb.url("🔗 Open form manually", targetUrl);
  return kb;
}

async function promptCurrentQuestion(ctx: Context, session: PendingApplySession): Promise<void> {
  const q = session.unanswered[session.questionIndex];
  if (!q) return;
  const opts = q.options ?? [];
  const optionsHint =
    opts.length > MAX_BUTTON_OPTIONS
      ? `\nOptions: <i>${safeHtml(opts.slice(0, 12).join(" | "))}</i>`
      : opts.length > 0
        ? "\n<i>Tap an option below or reply with your exact answer:</i>"
        : "\n<i>Reply to this message with your answer (I'll save it to your dossier so I never ask again):</i>";

  await ctx.reply(
    `❓ <b>Question ${session.questionIndex + 1}/${session.unanswered.length} for ${safeHtml(session.company)}</b> (${safeHtml(session.candidateName)})\n\n<b>${safeHtml(q.label)}</b>${optionsHint}`,
    { parse_mode: "HTML", reply_markup: buildQuestionKeyboard(session.rowId, q) },
  );
}

async function runFormPrepAndPrompt(ctx: Context, session: PendingApplySession): Promise<void> {
  const loadedProfile = await readApplyProfile(applyProfilePathFor(session.profileId));
  if (!loadedProfile.ok) {
    await ctx.reply(`⚠ Cannot auto-fill: ${safeHtml(loadedProfile.reason)}`, { parse_mode: "HTML" });
    return;
  }
  const dossier = (await readCandidateDossier(session.profileId)) ?? undefined;
  const prep = await runnerDeps.prepare(session.targetUrl, session.company, loadedProfile.profile, { resumePath: session.resumePdfPath }, dossier);

  if (!prep.ok) {
    await ctx.reply(`⚠ Form preparation failed for ${safeHtml(session.company)}: ${safeHtml(prep.reason)}`, { parse_mode: "HTML" });
    return;
  }

  const summaryText = formatSummaryLine(prep.summary);
  if (prep.screenshotPng.length > 0) {
    await ctx.replyWithPhoto(new InputFile(prep.screenshotPng, `apply-preview-${session.rowId.slice(0, 8)}.png`), {
      caption: `${session.company} — ${session.title} (${prep.platform})\n${summaryText}`,
    });
  } else {
    await ctx.reply(
      `<b>${safeHtml(session.company)} — ${safeHtml(session.title)}</b> (${safeHtml(prep.platform)})\n${safeHtml(summaryText)}`,
      { parse_mode: "HTML" },
    );
  }

  const updated: PendingApplySession = { ...session, targetUrl: prep.targetUrl, unanswered: prep.summary.unanswered, questionIndex: 0 };
  sessionsByChat.set(session.chatId, updated);
  sessionsByRow.set(session.rowId, updated);

  if (prep.summary.requiredUnanswered.length > 0) {
    await promptCurrentQuestion(ctx, updated);
    return;
  }

  const optionalNote =
    prep.summary.unanswered.length > 0
      ? `\n<i>(${prep.summary.unanswered.length} optional questions remaining — you can submit now or answer them below.)</i>`
      : "";

  await ctx.reply(
    `✅ <b>Form ready for ${safeHtml(session.company)}</b> (${safeHtml(session.candidateName)})\nAll required fields and CV are filled. Tap <b>Submit Application</b> to send it now.${optionalNote}`,
    { parse_mode: "HTML", reply_markup: buildSubmitKeyboard(session.rowId, prep.targetUrl) },
  );

  if (prep.summary.unanswered.length > 0) {
    await promptCurrentQuestion(ctx, updated);
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

  await ctx.reply(`🤖 Opening ${safeHtml(row.company)}'s form for ${safeHtml(profile.candidateName)} and filling from your dossier…`, { parse_mode: "HTML" });
  await runFormPrepAndPrompt(ctx, {
    rowId: row.id, chatId, profileId: profile.id, candidateName: profile.candidateName,
    company: row.company, title: row.title, targetUrl, resumePdfPath: pdfResolved.pdfPath, unanswered: [], questionIndex: 0,
  });
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

async function advanceAfterAnswer(ctx: Context, session: PendingApplySession): Promise<void> {
  session.questionIndex += 1;
  if (session.questionIndex < session.unanswered.length) {
    await promptCurrentQuestion(ctx, session);
    return;
  }
  await ctx.reply(`🔄 Re-filling ${safeHtml(session.company)}'s form with your saved answers…`, { parse_mode: "HTML" });
  await runFormPrepAndPrompt(ctx, session);
}

/** Intercept plain-text replies when the chat has an active unanswered form question. */
export async function tryHandlePendingApplyReply(ctx: Context, text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) return false;
  const session = sessionsByChat.get(String(ctx.chat?.id ?? ""));
  const q = session?.unanswered[session.questionIndex];
  if (!session || !q) return false;

  await recordLearnedAnswer(session.profileId, q.label, trimmed);
  log.info({ profileId: session.profileId, question: q.label }, "Saved learned form answer from chat reply");
  await ctx.reply(`💾 Saved to ${safeHtml(session.candidateName)}'s dossier: <b>${safeHtml(q.label)}</b> → <code>${safeHtml(trimmed)}</code>`, { parse_mode: "HTML" });
  await advanceAfterAnswer(ctx, session);
  return true;
}

/** Handle `jh:f:`, `jh:q:`, `jh:s:`, and `jh:k:` inline button taps. */
export async function handleAutoApplyCallback(ctx: Context, data: string): Promise<boolean> {
  if (!data.startsWith(JOB_CALLBACK_PREFIX)) return false;
  const [kind, rowId, choiceToken = ""] = data.slice(JOB_CALLBACK_PREFIX.length).split(":");
  if (!kind || !rowId || !UUID_PATTERN.test(rowId)) return false;
  if (kind !== "f" && kind !== "q" && kind !== "s" && kind !== "k") return false;

  if (kind === "k") {
    const session = sessionsByRow.get(rowId);
    if (session) sessionsByChat.delete(session.chatId);
    sessionsByRow.delete(rowId);
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
    const session = sessionsByRow.get(rowId);
    const q = session?.unanswered[session.questionIndex];
    if (!session || !q) {
      await ctx.answerCallbackQuery({ text: "Question session expired — tap Auto-Apply again." });
      return true;
    }
    if (choiceToken === "skip") {
      await ctx.answerCallbackQuery({ text: "Skipped question" });
      session.questionIndex += 1;
      if (session.questionIndex < session.unanswered.length) {
        await promptCurrentQuestion(ctx, session);
      } else {
        await ctx.reply(`✅ Ready to submit for <b>${safeHtml(session.company)}</b> (with skipped optional/unknown field).`, {
          parse_mode: "HTML",
          reply_markup: buildSubmitKeyboard(session.rowId, session.targetUrl),
        });
      }
      return true;
    }
    const idx = Number(choiceToken);
    const chosen = Number.isInteger(idx) ? q.options?.[idx] : undefined;
    if (!chosen) {
      await ctx.answerCallbackQuery({ text: "Invalid option" });
      return true;
    }
    await recordLearnedAnswer(session.profileId, q.label, chosen);
    await ctx.answerCallbackQuery({ text: `Saved: ${chosen.slice(0, 30)}` });
    await ctx.reply(`💾 Saved to ${safeHtml(session.candidateName)}'s dossier: <b>${safeHtml(q.label)}</b> → <code>${safeHtml(chosen)}</code>`, { parse_mode: "HTML" });
    await advanceAfterAnswer(ctx, session);
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
  const session = sessionsByRow.get(rowId);
  const targetUrl = session?.targetUrl ?? getApplyUrl(row.url ?? "", row.company) ?? row.url ?? "";
  const result = await runnerDeps.submit(targetUrl, row.company, loaded.profile, { resumePath: pdfResolved.pdfPath }, dossier);

  if (!result.ok) {
    await ctx.reply(`⚠ <b>Could not submit for ${safeHtml(row.company)}</b>: ${safeHtml(result.reason)}`, {
      parse_mode: "HTML",
      reply_markup: buildSubmitKeyboard(row.id, targetUrl),
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
    sessionsByRow.delete(rowId);
    if (session) sessionsByChat.delete(session.chatId);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(
      // allow-failopen: cosmetic; the application is already submitted and recorded.
      () => undefined,
    );
    await ctx.reply(`✅ <b>Application submitted and marked applied</b> — ${safeHtml(row.company)} (${safeHtml(row.title)}). It's off today's queue.`, { parse_mode: "HTML" });
  } else {
    await ctx.reply(
      `⚠ <b>Could not confirm submission for ${safeHtml(row.company)}</b>: ${safeHtml(result.evidence)}\nCheck the screenshot above or open the form directly.`,
      { parse_mode: "HTML", reply_markup: buildSubmitKeyboard(row.id, targetUrl) },
    );
  }
  return true;
}
