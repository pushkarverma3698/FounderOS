/**
 * Apply flow: card, questions, per-row lock, hosted answer link
 * ===============================================================
 * What happens after a prepare run of `/apply`. auto-apply.ts keeps the command, the resume lookup and
 * the button handlers; this module owns the card the founder sees:
 *
 *  - a text card (no screenshot: the filled copy only ever existed in headless Chromium on the VPS) with
 *    a button to the hosted answer page, backed by a snapshot the page renders. In a private chat the
 *    button is a web_app button, so the page opens inside Telegram; Telegram refuses web_app buttons in
 *    groups and for non-HTTPS URLs, so there it stays an ordinary url button;
 *  - the re-ask guard: a question answered in this session that comes back unfilled is never asked
 *    again; the card says what could not be filled and points at the answer page;
 *  - Submit only when no required field is missing (stuck, or skipped by the founder);
 *  - one lock per application row, shared by the Telegram path and the page, so two re-fills of the
 *    same form never run at once.
 *
 * Output goes through an `ApplySender`: the Telegram context for button and text replies, the bot API
 * for a re-fill started from the page (an HTTP request has no Telegram context).
 */

import { InlineKeyboard } from "grammy";
import { childLogger } from "../infra/logger.js";
import {
  buildApplyUrl,
  loadApplySnapshot,
  readApplyLinkConfig,
  saveApplySnapshot,
  type ApplySnapshot,
} from "../tools/jobhunt/apply-link.js";
import { applyProfilePathFor, readApplyProfile } from "../tools/jobhunt/apply-profile.js";
import { readCandidateDossier } from "../tools/jobhunt/candidate-dossier.js";
import { withFormOnlyAnswers } from "../tools/jobhunt/company-answer.js";
import type { FormPlanSummary, UnansweredQuestion } from "../tools/jobhunt/form-brain.js";
import type { prepareApplicationForm } from "../tools/jobhunt/form-runner.js";
import { JOB_CALLBACK_PREFIX } from "../tools/jobhunt/job-ref.js";
import {
  acquireApplyLock,
  botSender,
  cardTag,
  getRunnerDeps,
  keyOf,
  mintCardStamp,
  newSession,
  partitionStuck,
  questionTag,
  rememberAnswer,
  sessionForRow,
  setSession,
  type AnsweredEntry,
  type ApplySender,
  type PendingApplySession,
  type SessionBase,
  type StuckQuestion,
} from "./apply-session.js";
import { coverLetterLine, letterFacts } from "./apply-cover-letter.js";
import { safeHtml } from "./safe-html.js";

export { partitionStuck, tryLockApply } from "./apply-session.js";

const log = childLogger({ module: "gateway:apply-flow" });
const MAX_BUTTON_OPTIONS = 6;
const MAX_BUTTON_LABEL_CHARS = 36;
const COMPANY_PAGE_LABEL = "🔗 Company page (not prefilled)";

// ── link, keyboards, prompts ────────────────────────────────────────────────────────────────────

export interface AnswerLink {
  /** The signed hosted URL, or null when it cannot be built (then `reason` says why). */
  readonly url: string | null;
  /** Questions still unfilled on the page (drives the button label). */
  readonly left: number;
  readonly reason: string;
  /** Open the page inside Telegram (web_app button) rather than in the browser (url button). */
  readonly inTelegram: boolean;
}

/** Telegram takes an inline web_app button only in a private chat (positive chat id) and only for an HTTPS URL. */
export const opensInTelegram = (chatId: string, url: string): boolean => /^[1-9]\d*$/.test(chatId) && /^https:\/\//i.test(url);

const noLink = (reason: string): AnswerLink => ({ url: null, left: 0, reason, inTelegram: false });

function linkTo(url: string, snap: ApplySnapshot): AnswerLink {
  return { url, left: snap.summary.unanswered.length, reason: "", inTelegram: opensInTelegram(snap.chatId, url) };
}

const isHttp = (url: string): boolean => /^https?:\/\//i.test(url);
const answerLabel = (left: number): string => (left > 0 ? `📝 Open form to finish (${left} left)` : "📝 Review filled form");

/** The link to an already saved snapshot (Submit and failure replies). Reads the env at call time. */
export function answerLink(rowId: string): AnswerLink {
  const cfg = readApplyLinkConfig();
  if (!cfg.ok) return noLink(cfg.reason);
  const snap = loadApplySnapshot(rowId);
  if (!snap) return noLink("answer page expired, run /apply again");
  return linkTo(buildApplyUrl(cfg, rowId, snap.profileId), snap);
}

/** Saves the snapshot the page renders and returns its link. Missing env or a failed save is logged and returned. */
function persistAndLink(fresh: ApplySnapshot): AnswerLink {
  // A re-fill must not wipe the unconfirmed-submit guard; only reopening the form from Telegram does.
  const carried = loadApplySnapshot(fresh.rowId)?.unconfirmedAt;
  const snap = carried === undefined ? fresh : { ...fresh, unconfirmedAt: carried };
  const cfg = readApplyLinkConfig();
  if (!cfg.ok) {
    log.warn({ rowId: snap.rowId, reason: cfg.reason }, "apply answer link unavailable");
    return noLink(cfg.reason);
  }
  try {
    saveApplySnapshot(snap);
  } catch (err) {
    const reason = `snapshot not saved (${(err as Error).message})`;
    log.warn({ rowId: snap.rowId, reason }, "apply answer link unavailable");
    return noLink(reason);
  }
  return linkTo(buildApplyUrl(cfg, snap.rowId, snap.profileId), snap);
}

/** A file input: no typed reply or option can fill it, so it is never asked as a text question. */
export const isFileQuestion = (q: UnansweredQuestion): boolean => q.fieldType === "file";

export function fileQuestionNotice(q: UnansweredQuestion): string {
  return `<b>${safeHtml(q.label)}</b> is a file upload: attach it on the company page, or skip.`;
}

export function buildQuestionKeyboard(rowId: string, q: UnansweredQuestion, qTag = "", cTag = ""): InlineKeyboard {
  const kb = new InlineKeyboard();
  const opts = isFileQuestion(q) ? [] : (q.options ?? []);
  if (opts.length > 0 && opts.length <= MAX_BUTTON_OPTIONS) {
    opts.forEach((opt, idx) => {
      const label = opt.length > MAX_BUTTON_LABEL_CHARS ? `${opt.slice(0, MAX_BUTTON_LABEL_CHARS - 1)}…` : opt;
      kb.text(label, `${JOB_CALLBACK_PREFIX}q:${rowId}:${idx}${qTag}`).row();
    });
  }
  return kb.text("⏭ Skip this question", `${JOB_CALLBACK_PREFIX}q:${rowId}:skip${qTag}`).text("✖ Cancel", `${JOB_CALLBACK_PREFIX}k:${rowId}${cTag}`);
}

/** Adds the hosted answer-page button, when there is a link: inside Telegram where it can, else a url button. */
function withAnswerButton(kb: InlineKeyboard, link: AnswerLink): InlineKeyboard {
  if (!link.url) return kb;
  const label = answerLabel(link.left);
  return link.inTelegram ? kb.webApp(label, link.url) : kb.url(label, link.url);
}

/** Hosted link first, then Submit and Cancel, then the company page (labelled: it is not prefilled). */
export function buildSubmitKeyboard(rowId: string, targetUrl: string, link: AnswerLink, tag = ""): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (link.url) withAnswerButton(kb, link).row();
  kb.text("🚀 Submit Application", `${JOB_CALLBACK_PREFIX}s:${rowId}${tag}`).text("⏭ Cancel", `${JOB_CALLBACK_PREFIX}k:${rowId}${tag}`);
  if (isHttp(targetUrl)) kb.row().url(COMPANY_PAGE_LABEL, targetUrl);
  return kb;
}

/** No Submit: something required is still missing. */
export function buildBlockedKeyboard(rowId: string, targetUrl: string, link: AnswerLink, tag = ""): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (link.url) withAnswerButton(kb, link).row();
  kb.text("⏭ Cancel", `${JOB_CALLBACK_PREFIX}k:${rowId}${tag}`);
  if (isHttp(targetUrl)) kb.row().url(COMPANY_PAGE_LABEL, targetUrl);
  return kb;
}

export function formatSummaryLine(summary: FormPlanSummary): string {
  const parts = [`Filled ${summary.filled}/${summary.total} fields`];
  if (summary.unanswered.length > 0) parts.push(`${summary.unanswered.length} unanswered (${summary.requiredUnanswered.length} required)`);
  if (summary.hasCaptcha) parts.push("CAPTCHA detected");
  return parts.join(" · ");
}

export async function promptCurrentQuestion(send: ApplySender, session: PendingApplySession): Promise<void> {
  const q = session.unanswered[session.questionIndex];
  if (!q) return;
  const head = `❓ <b>Question ${session.questionIndex + 1}/${session.unanswered.length} for ${safeHtml(session.company)}</b> (${safeHtml(session.candidateName)})\n\n`;
  if (isFileQuestion(q)) {
    await send.text(head + fileQuestionNotice(q), buildQuestionKeyboard(session.rowId, q, questionTag(session), cardTag(session)));
    return;
  }
  const opts = q.options ?? [];
  const optionsHint =
    opts.length > MAX_BUTTON_OPTIONS
      ? `\nOptions: <i>${safeHtml(opts.slice(0, 12).join(" | "))}</i>`
      : opts.length > 0
        ? "\n<i>Tap an option below or reply with your exact answer:</i>"
        : "\n<i>Reply to this message with your answer (I'll save it to your dossier so I never ask again):</i>";
  await send.text(`${head}<b>${safeHtml(q.label)}</b>${optionsHint}`, buildQuestionKeyboard(session.rowId, q, questionTag(session), cardTag(session)));
}

// ── card, verdict, re-fill ──────────────────────────────────────────────────────────────────────

type PrepOk = Extract<Awaited<ReturnType<typeof prepareApplicationForm>>, { ok: true }>;

function snapshotOf(session: PendingApplySession, prep: PrepOk, stuck: readonly StuckQuestion[]): ApplySnapshot {
  const tried = new Map(stuck.map((s) => [keyOf(s.question.label), s.answer] as const));
  return {
    rowId: session.rowId,
    chatId: session.chatId,
    profileId: session.profileId,
    company: session.company,
    title: session.title,
    candidateName: session.candidateName,
    targetUrl: prep.targetUrl,
    platform: prep.platform,
    resumePath: session.resumePdfPath,
    ...(session.coverLetter ? { coverLetter: { ...session.coverLetter } } : {}),
    ...(session.coverLetterNote ? { coverLetterNote: session.coverLetterNote } : {}),
    summary: {
      filled: prep.summary.filled,
      total: prep.summary.total,
      hasCaptcha: prep.summary.hasCaptcha,
      filledLabels: [...prep.summary.filledLabels],
      filledAnswers: prep.summary.filledAnswers.map((f) => ({
        label: f.label,
        value: f.value,
        fieldType: f.fieldType,
        ...(f.options ? { options: [...f.options] } : {}),
        editable: f.editable,
      })),
      unanswered: prep.summary.unanswered.map((q) => {
        const triedAnswer = tried.get(keyOf(q.label));
        return {
          label: q.label,
          required: q.required,
          fieldType: q.fieldType,
          ...(q.options ? { options: [...q.options] } : {}),
          ...(triedAnswer !== undefined ? { triedAnswer } : {}),
        };
      }),
    },
    createdAt: Date.now(),
  };
}

function stuckLines(link: AnswerLink, stuck: readonly StuckQuestion[]): string[] {
  const hint = link.url ? "Finish it on the answer page." : `Answer link unavailable (${safeHtml(link.reason)}).`;
  return stuck.map((s) => `⚠ Couldn't fill <b>${safeHtml(s.question.label)}</b> with <code>${safeHtml(s.answer)}</code>. ${hint}`);
}

/** No Submit: something required is still missing. Lists it, with the hosted link. */
async function sendBlocked(
  send: ApplySender,
  session: PendingApplySession,
  link: AnswerLink,
  stuck: readonly StuckQuestion[],
  skipped: readonly UnansweredQuestion[],
): Promise<void> {
  const lines = [`🚫 <b>Not ready to submit — ${safeHtml(session.company)}</b> (${safeHtml(session.candidateName)})`];
  lines.push(...stuckLines(link, stuck.filter((s) => s.question.required)));
  const missing = skipped.filter((q) => q.required);
  if (missing.length > 0) lines.push("Still missing (required):", ...missing.map((q) => `• ${safeHtml(q.label)}`));
  lines.push(link.url ? "Submit appears once nothing required is missing." : `<i>answer link unavailable: ${safeHtml(link.reason)}</i>`);
  await send.text(lines.join("\n"), buildBlockedKeyboard(session.rowId, session.targetUrl, link, cardTag(session)));
}

async function sendReady(send: ApplySender, session: PendingApplySession, link: AnswerLink): Promise<void> {
  const optional =
    session.unanswered.length > 0
      ? `\n<i>(${session.unanswered.length} optional questions remaining — you can submit now or answer them below.)</i>`
      : "";
  const notes = session.stuck.length > 0 ? `\n${stuckLines(link, session.stuck).join("\n")}` : "";
  await send.text(
    `✅ <b>Form ready for ${safeHtml(session.company)}</b> (${safeHtml(session.candidateName)})\nAll required fields and CV are filled. Tap <b>Submit Application</b> to send it now.${optional}${notes}`,
    buildSubmitKeyboard(session.rowId, session.targetUrl, link, cardTag(session)),
  );
}

/** The last question was skipped, or nothing was answered: no new fill, so judge from the last prepare run. */
export async function finishWithoutRefill(send: ApplySender, session: PendingApplySession): Promise<void> {
  const link = answerLink(session.rowId);
  if (session.stuck.some((s) => s.question.required) || session.skipped.some((q) => q.required)) {
    await sendBlocked(send, session, link, session.stuck, session.skipped);
    return;
  }
  await send.text(
    `✅ Ready to submit for <b>${safeHtml(session.company)}</b> (with skipped optional/unknown field).`,
    buildSubmitKeyboard(session.rowId, session.targetUrl, link, cardTag(session)),
  );
}

/**
 * Prepare the form, send the card, then either ask the next question, say what blocks Submit, or offer
 * Submit. Releases `held` on every exit. Throws when the runner crashes (callers decide who to tell).
 */
export async function runFormPrepAndPrompt(send: ApplySender, session: PendingApplySession, held: () => void): Promise<void> {
  try {
    const loaded = await readApplyProfile(applyProfilePathFor(session.profileId));
    if (!loaded.ok) {
      await send.text(`⚠ Cannot auto-fill: ${safeHtml(loaded.reason)}`);
      return;
    }
    const dossier = (await readCandidateDossier(session.profileId)) ?? undefined;
    const profile = withFormOnlyAnswers(loaded.profile, session.answered, session.company);
    const prep = await getRunnerDeps().prepare(session.targetUrl, session.company, profile, { resumePath: session.resumePdfPath, ...letterFacts(session.coverLetter) }, dossier);
    if (!prep.ok) {
      await send.text(`⚠ Form preparation failed for ${safeHtml(session.company)}: ${safeHtml(prep.reason)}`);
      return;
    }

    const part = partitionStuck(prep.summary.unanswered, session.answered, session.skipped);
    const updated: PendingApplySession = {
      ...session, targetUrl: prep.targetUrl, unanswered: part.pending, stuck: part.stuck, skipped: part.skipped, questionIndex: 0,
      cardStamp: mintCardStamp(),
    };
    setSession(updated);
    const link = persistAndLink(snapshotOf(updated, prep, part.stuck));

    const lines = [
      `<b>${safeHtml(session.company)} — ${safeHtml(session.title)}</b> (${safeHtml(prep.platform)})`,
      safeHtml(formatSummaryLine(prep.summary)),
      coverLetterLine(session.coverLetter, session.coverLetterNote, prep.summary),
    ];
    if (!link.url) lines.push(`<i>answer link unavailable: ${safeHtml(link.reason)}</i>`);
    await send.text(lines.join("\n"), link.url ? withAnswerButton(new InlineKeyboard(), link) : undefined);

    if (part.pending.some((q) => q.required)) {
      await promptCurrentQuestion(send, updated);
      return;
    }
    const blocked = part.stuck.some((s) => s.question.required) || part.skipped.some((q) => q.required);
    if (blocked) await sendBlocked(send, updated, link, part.stuck, part.skipped);
    else await sendReady(send, updated, link);
    if (part.pending.length > 0) await promptCurrentQuestion(send, updated);
  } finally {
    held();
  }
}

/** After an answer or a skip: ask the next question, or at the end re-fill (if anything was answered) or conclude. */
export async function advanceAfterQuestion(send: ApplySender, session: PendingApplySession): Promise<void> {
  session.questionIndex += 1;
  if (session.questionIndex < session.unanswered.length) {
    await promptCurrentQuestion(send, session);
    return;
  }
  const answeredNow = session.unanswered.some((q) => session.answered.some((a) => keyOf(a.label) === keyOf(q.label)));
  if (!answeredNow) {
    await finishWithoutRefill(send, session);
    return;
  }
  const held = await acquireApplyLock(send, session.rowId);
  if (!held) return;
  try {
    await send.text(`🔄 Re-filling ${safeHtml(session.company)}'s form with your saved answers…`);
    await runFormPrepAndPrompt(send, session, held);
  } finally {
    held();
  }
}

/**
 * The answer page posted answers (already saved to the dossier by the route): re-fill the form and
 * send the updated card to the snapshot's chat. The caller holds the row lock; it is released here.
 * Never submits. Any failure is told to the chat, not swallowed.
 */
export async function refillFromPage(
  snap: ApplySnapshot,
  posted: readonly AnsweredEntry[],
  held: () => void,
  send: ApplySender = botSender(snap.chatId),
): Promise<void> {
  try {
    const base: SessionBase = {
      rowId: snap.rowId, chatId: snap.chatId, profileId: snap.profileId, candidateName: snap.candidateName,
      company: snap.company, title: snap.title, targetUrl: snap.targetUrl, resumePdfPath: snap.resumePath,
      ...(snap.coverLetter ? { coverLetter: snap.coverLetter } : {}),
      ...(snap.coverLetterNote ? { coverLetterNote: snap.coverLetterNote } : {}),
    };
    const tried = snap.summary.unanswered.flatMap((q) => (q.triedAnswer !== undefined ? [{ label: q.label, answer: q.triedAnswer }] : []));
    const session = sessionForRow(snap.rowId) ?? newSession(base, tried);
    for (const a of posted) rememberAnswer(session, a.label, a.answer);
    await runFormPrepAndPrompt(send, session, held);
  } catch (err) {
    const reason = (err as Error).message;
    log.error({ rowId: snap.rowId, err: reason }, "apply page re-fill failed");
    try {
      await send.text(`⚠ Re-fill crashed for ${safeHtml(snap.company)}: ${safeHtml(reason)}`);
    } catch (sendErr) {
      log.error({ rowId: snap.rowId, err: (sendErr as Error).message }, "apply page re-fill: could not tell the chat");
    }
  } finally {
    held();
  }
}
