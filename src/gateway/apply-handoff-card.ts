/**
 * Hand-off card: "📋 Copy answers" when the bot must not, or cannot, fill the form
 * ================================================================================
 * Three stops used to dead-end the card: a platform the bot does not support, a page with no fillable fields,
 * and a form with a bot check. Each now offers a web_app button that opens the hand-off panel
 * (apply-handoff-routes.ts) on the answer-page server: the job link, then every answer to copy.
 *
 * A stop before any fillable form saves a hand-off-only snapshot (the panel's token needs one). It is marked as
 * having a CAPTCHA, so the answer page and the status endpoint read it as "blocked", never "ready to submit".
 * A snapshot that already exists is kept as it is.
 */

import { InlineKeyboard } from "grammy";
import { childLogger } from "../infra/logger.js";
import { buildApplyUrl, loadApplySnapshot, readApplyLinkConfig, saveApplySnapshot, type ApplySnapshot } from "../tools/jobhunt/apply-link.js";
import { classifyFormUrl } from "../tools/jobhunt/form-platform.js";
import type { ApplySender, SessionBase } from "./apply-session.js";
import { safeHtml } from "./safe-html.js";

const log = childLogger({ module: "gateway:apply-handoff-card" });

export const HANDOFF_LABEL = "📋 Copy answers";
const COMPANY_PAGE_LABEL = "🔗 Company page (not prefilled)";

/** Telegram takes an inline web_app button only in a private chat (positive chat id) and only for an HTTPS URL. */
export const opensInTelegram = (chatId: string, url: string): boolean => /^[1-9]\d*$/.test(chatId) && /^https:\/\//i.test(url);

/** The panel lives under the signed answer link. */
export const handoffUrl = (answerUrl: string): string => `${answerUrl.replace(/\/+$/, "")}/handoff`;

/** Adds the panel button on its own row, inside Telegram where it can open, else as a plain link. */
export function withHandoffButton(kb: InlineKeyboard, link: { readonly url: string | null; readonly inTelegram: boolean }): InlineKeyboard {
  if (!link.url) return kb;
  kb.row();
  return link.inTelegram ? kb.webApp(HANDOFF_LABEL, handoffUrl(link.url)) : kb.url(HANDOFF_LABEL, handoffUrl(link.url));
}

function stoppedSnapshot(session: SessionBase, reason: string, platform: string): ApplySnapshot {
  return {
    rowId: session.rowId, chatId: session.chatId, profileId: session.profileId, company: session.company, title: session.title,
    candidateName: session.candidateName, targetUrl: session.targetUrl, platform, resumePath: session.resumePdfPath,
    ...(session.coverLetter ? { coverLetter: { ...session.coverLetter } } : {}),
    ...(session.coverLetterNote ? { coverLetterNote: session.coverLetterNote } : {}),
    summary: { filled: 0, total: 0, hasCaptcha: true, filledLabels: [], filledAnswers: [], unanswered: [] },
    handoffReason: reason,
    createdAt: Date.now(),
  };
}

/** The signed answer link for the hand-off snapshot; null (with the reason) when it cannot be built. */
function persistStopped(session: SessionBase, reason: string, platform: string): { url: string | null; why: string } {
  const cfg = readApplyLinkConfig();
  if (!cfg.ok) return { url: null, why: cfg.reason };
  const snap = loadApplySnapshot(session.rowId) ?? stoppedSnapshot(session, reason, platform);
  try {
    saveApplySnapshot(snap);
  } catch (err) {
    log.warn({ rowId: session.rowId, err: (err as Error).message }, "hand-off snapshot not saved");
    return { url: null, why: `snapshot not saved (${(err as Error).message})` };
  }
  return { url: buildApplyUrl(cfg, snap.rowId, snap.profileId), why: "" };
}

/**
 * The card for a prepare run that found no fillable form. The text keeps the reason; the button opens the
 * copy panel when the link can be built, and the company page stays as a plain link.
 */
export async function sendPrepFailure(send: ApplySender, session: SessionBase, reason: string, platform?: string | null): Promise<void> {
  const check = classifyFormUrl(session.targetUrl);
  const stopped = persistStopped(session, reason, platform ?? (check.supported ? check.platform : "unsupported"));
  const kb = new InlineKeyboard();
  if (stopped.url) withHandoffButton(kb, { url: stopped.url, inTelegram: opensInTelegram(session.chatId, stopped.url) });
  if (/^https?:\/\//i.test(session.targetUrl)) kb.row().url(COMPANY_PAGE_LABEL, session.targetUrl);
  const note = stopped.url ? "\nApply by hand: tap <b>Copy answers</b> for every answer, one tap each." : `\n<i>copy panel unavailable: ${safeHtml(stopped.why)}</i>`;
  await send.text(`⚠ Form preparation failed for ${safeHtml(session.company)}: ${safeHtml(reason)}${note}`, kb);
}
