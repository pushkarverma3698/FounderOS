/**
 * Prepare one application row: validate, lock, open the form, fill it, send the card
 * ====================================================================================
 * The core of `/apply`, with no grammY Context so the Telegram command (auto-apply.ts) and the Mini App job
 * list (apply-prepare-api.ts) share it. The caller passes the chat to write to as an ApplySender: the card
 * and the progress lines go there in both cases, because that chat is the record (ADR-018).
 *
 * Returns "started" once the card has been sent, or a typed refusal with a chat line (`html`) and a plain
 * sentence for the page (`detail`). Throws when the form runner crashes; callers decide who to tell.
 */

import type { JobApplication } from "../db/schema.js";
import { getApplyUrl } from "../tools/jobhunt/apply-packet.js";
import { applyProfilePathFor, readApplyProfile } from "../tools/jobhunt/apply-profile.js";
import type { JobSearchProfile } from "../tools/jobhunt/profile-config.js";
import { coverLetterMessage } from "./apply-cover-letter.js";
import { runFormPrepAndPrompt } from "./apply-flow.js";
import { appliedOn, artifactDirForChat, resolveCoverLetter, resolveResumePdf } from "./apply-material.js";
import { forgetUnconfirmedClick, LOCK_HELD_MESSAGE, newSession, tryLockApply, type ApplySender } from "./apply-session.js";
import { alreadyAppliedMessage } from "./apply-submit.js";
import { safeHtml } from "./safe-html.js";

export type PrepareReason = "already-applied" | "no-profile" | "no-resume" | "no-url" | "lock-held";

export type PrepareResult =
  | { readonly kind: "started" }
  | { readonly kind: "refused"; readonly reason: PrepareReason; readonly html: string; readonly detail: string };

export interface PrepareOptions {
  /** A per-row lock the caller already holds (the Mini App takes it before answering 202). Released on every exit. */
  readonly held?: () => void;
}

const refuse = (reason: PrepareReason, html: string, detail: string): PrepareResult => ({ kind: "refused", reason, html, detail });

export async function prepareRow(
  row: JobApplication,
  profile: JobSearchProfile,
  chatId: string,
  send: ApplySender,
  opts: PrepareOptions = {},
): Promise<PrepareResult> {
  let held = opts.held ?? null;
  try {
    const on = appliedOn(row);
    if (on) return refuse("already-applied", alreadyAppliedMessage(row, on), `Already applied on ${on}.`);
    const loaded = await readApplyProfile(applyProfilePathFor(profile.id));
    if (!loaded.ok) {
      return refuse(
        "no-profile",
        `⚠ No usable apply profile for ${safeHtml(profile.candidateName)} (${safeHtml(loaded.reason)}). Send <code>/profile</code> first.`,
        `No usable apply profile for ${profile.candidateName} (${loaded.reason}).`,
      );
    }
    const artifactDir = artifactDirForChat(chatId);
    const pdfResolved = await resolveResumePdf(row, profile, loaded.profile, artifactDir);
    if (!pdfResolved.ok) {
      return refuse("no-resume", `⚠ Cannot start auto-apply: ${safeHtml(pdfResolved.reason)}`, `Cannot start: ${pdfResolved.reason}`);
    }
    const targetUrl = getApplyUrl(row.url ?? "", row.company) ?? row.url ?? "";
    if (!targetUrl) {
      return refuse("no-url", `⚠ ${safeHtml(row.company)} has no application URL on file.`, `${row.company} has no application URL on file.`);
    }
    if (!held) {
      held = tryLockApply(row.id);
      if (!held) return refuse("lock-held", LOCK_HELD_MESSAGE, "This form is already being filled.");
    }
    forgetUnconfirmedClick(row.id); // reopening the form is the deliberate retry the unconfirmed reply names
    await send.text(`🤖 Opening ${safeHtml(row.company)}'s form for ${safeHtml(profile.candidateName)} and filling from your dossier…`);
    const letter = await resolveCoverLetter(row, profile, artifactDir);
    if (letter.ok) await send.text(coverLetterMessage(row.company, letter));
    const base = {
      rowId: row.id, chatId, profileId: profile.id, candidateName: profile.candidateName,
      company: row.company, title: row.title, targetUrl, resumePdfPath: pdfResolved.pdfPath,
      ...(letter.ok ? { coverLetter: letter.letter } : { coverLetterNote: letter.reason }),
    };
    const release = held;
    held = null; // runFormPrepAndPrompt releases on every exit
    await runFormPrepAndPrompt(send, newSession(base), release);
    return { kind: "started" };
  } finally {
    held?.();
  }
}
