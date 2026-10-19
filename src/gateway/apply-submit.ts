/**
 * Apply Submit: the one send path (ADR-018)
 * =========================================
 * Both Submit surfaces call `runSubmit`: the Telegram button (`jh:s:`, auto-apply.ts) and the Mini App
 * (`POST /apply/<token>/submit`, apply-api.ts). The caller holds the row's lock and has authenticated
 * the founder (a Telegram tap, or verified initData); everything after that is here, so the two cannot drift:
 *
 *   row on file? -> not already applied? -> no unconfirmed earlier click? -> not already audited?
 *   -> apply profile + resume -> send -> proof screenshot -> confirmed: mark applied, audit row, end session
 *                                                          -> unconfirmed: remember the click, no second send.
 *
 * `io` is how the outcome reaches the chat; a refusal comes back as a toast (the Telegram callback answer,
 * the page's status detail) plus an optional chat line. Nothing here throws for an expected refusal.
 */

import type { InlineKeyboard } from "grammy";
import { TENANT } from "../core/config.js";
import { getApplicationById } from "../db/apply-queries.js";
import type { JobApplication } from "../db/schema.js";
import { hasBeenAudited, writeAuditEntry } from "../db/queries.js";
import { childLogger } from "../infra/logger.js";
import { getApplyUrl } from "../tools/jobhunt/apply-packet.js";
import { loadApplySnapshot } from "../tools/jobhunt/apply-link.js";
import { applyProfilePathFor, readApplyProfile } from "../tools/jobhunt/apply-profile.js";
import { withFormOnlyAnswers } from "../tools/jobhunt/company-answer.js";
import { readCandidateDossier } from "../tools/jobhunt/candidate-dossier.js";
import { enterEmailCode, heldCodeInfo, onHeldExpired, type CodeEntryResult } from "../tools/jobhunt/held-submit.js";
import { shortJobId } from "../tools/jobhunt/job-ref.js";
import { getProfile } from "../tools/jobhunt/profile-config.js";
import { letterFacts, letterOf } from "./apply-cover-letter.js";
import { answerLink, buildBlockedKeyboard, buildSubmitKeyboard } from "./apply-flow.js";
import { appliedOn, artifactDirForChat, resolveCoverLetter, resolveResumePdf } from "./apply-material.js";
import { cardTag, endSession, getRunnerDeps, noteUnconfirmedClick, sessionForRow, unconfirmedClickAt } from "./apply-session.js";
import { markRowApplied } from "./jobhunt-buttons.js";
import { safeHtml } from "./safe-html.js";

const log = childLogger({ module: "gateway:apply-submit" });

export type SubmitVia = "telegram" | "miniapp";

export interface SubmitIo {
  readonly text: (html: string, keyboard?: InlineKeyboard) => Promise<void>;
  readonly photo: (png: Buffer, caption: string, filename: string) => Promise<void>;
  /** The row passed every guard and the real send is about to start. */
  readonly started: (row: JobApplication) => Promise<void>;
  /** After a sent (confirmed or not) Submit: the surface drops its own now-dead button. */
  readonly settled: () => Promise<void>;
}

export type SubmitResult =
  | { readonly kind: "refused"; readonly toast: string; readonly html?: string }
  | { readonly kind: "failed" | "confirmed" | "unconfirmed" | "code-needed"; readonly row: JobApplication; readonly detail: string };

export const auditKeyFor = (rowId: string): string => `apply-submit:${rowId}`;

export const alreadyAppliedMessage = (row: JobApplication, on: string): string =>
  `✅ Already applied to <b>${safeHtml(row.company)}</b> (${safeHtml(row.title)}) on ${on}. Nothing was sent again.`;

export const alreadyClickedMessage = (row: JobApplication, at: Date): string =>
  `⚠ Submit for <b>${safeHtml(row.company)}</b> was already clicked at ${at.toISOString().slice(11, 16)} UTC with no confirmation. ` +
  `Nothing was sent again. Check your email first; to retry, send <code>/apply ${shortJobId(row.id)}</code>.`;

export const codeNeededMessage = (row: JobApplication): string =>
  `📧 <b>${safeHtml(row.company)}</b> emailed you a confirmation code. Open the form and type it within 10 minutes; nothing is applied until it is accepted.`;

const refuse = (toast: string, html?: string): SubmitResult => ({ kind: "refused", toast, ...(html ? { html } : {}) });

/** Writes the audit row for a confirmed send. The application is already out, so a failure is logged loudly, not thrown. */
async function auditConfirmed(row: JobApplication, via: SubmitVia, targetUrl: string): Promise<void> {
  try {
    const audit = await writeAuditEntry({
      action: "job_application_submitted",
      idempotency_key: auditKeyFor(row.id),
      payload: { rowId: row.id, profileId: row.profile_id, company: row.company, title: row.title, targetUrl, via },
      tenant_id: TENANT,
    });
    if (!audit.written) log.warn({ rowId: row.id }, "apply submit: audit row already existed (a concurrent send won the race)");
  } catch (err) {
    // allow-failopen: the application is sent and marked applied; a lost audit row is reported, never a reason to claim failure.
    log.error({ rowId: row.id, err: (err as Error).message }, "apply submit: audit row not written");
  }
}

/** Re-fill and send one application. The caller holds the row's lock. */
export async function runSubmit(rowId: string, chatId: string, via: SubmitVia, io: SubmitIo): Promise<SubmitResult> {
  const row = await getApplicationById(rowId, getProfile().tenantId);
  if (!row) return refuse("That role is no longer on file.");
  const on = appliedOn(row);
  if (on) return refuse("Already applied", alreadyAppliedMessage(row, on));
  if (heldCodeInfo(rowId)) return refuse("Waiting for your emailed code", codeNeededMessage(row));
  const clickedAt = unconfirmedClickAt(rowId);
  if (clickedAt) return refuse("Already sent once", alreadyClickedMessage(row, clickedAt));
  try {
    if (await hasBeenAudited(auditKeyFor(rowId))) return refuse("Already submitted", alreadyAppliedMessage(row, "an earlier date"));
  } catch (err) {
    log.error({ rowId, err: (err as Error).message }, "apply submit: audit check failed, nothing sent");
    return refuse("Could not check the audit log, so nothing was sent. Try again in a minute.");
  }
  const profile = getProfile(row.profile_id);
  const loaded = await readApplyProfile(applyProfilePathFor(profile.id));
  if (!loaded.ok) return refuse("Apply profile unreadable");
  const artifactDir = artifactDirForChat(chatId);
  const pdfResolved = await resolveResumePdf(row, profile, loaded.profile, artifactDir);
  if (!pdfResolved.ok) return refuse("Resume missing");

  await io.started(row);
  await io.text(`🚀 Submitting your application to <b>${safeHtml(row.company)}</b>…`);

  const dossier = (await readCandidateDossier(profile.id)) ?? undefined;
  const session = sessionForRow(rowId);
  const targetUrl = session?.targetUrl ?? getApplyUrl(row.url ?? "", row.company) ?? row.url ?? "";
  // The letter the card showed; after a restart (no session) the archived one, resolved again.
  const letter = session ? session.coverLetter : letterOf(await resolveCoverLetter(row, profile, artifactDir));
  const facts = { resumePath: pdfResolved.pdfPath, ...letterFacts(letter) };
  // Answers that name the company are never saved to the profile (company-answer.ts); lay them back on from this
  // session and from the snapshot's filled values, so the submit run fills them too, also after a restart.
  const filled = (loadApplySnapshot(rowId)?.summary.filledAnswers ?? []).filter((f) => f.fieldType !== "file");
  const formOnly = [...filled.map((f) => ({ label: f.label, answer: f.value })), ...(session?.answered ?? [])];
  const submitProfile = withFormOnlyAnswers(loaded.profile, formOnly, row.company);
  const result = await getRunnerDeps().submit(targetUrl, row.company, submitProfile, facts, dossier, rowId);

  if (!result.ok) {
    await io.text(
      `⚠ <b>Could not submit for ${safeHtml(row.company)}</b>: ${safeHtml(result.reason)}`,
      buildSubmitKeyboard(row.id, targetUrl, answerLink(row.id), cardTag(sessionForRow(row.id))),
    );
    return { kind: "failed", row, detail: result.reason };
  }
  if (result.afterScreenshotPng.length > 0) {
    const verdict = result.confirmed ? "confirmed" : "needs attention";
    await io.photo(result.afterScreenshotPng, `${row.company} — post-submit (${verdict})`, `apply-submit-${row.id.slice(0, 8)}.png`);
  }
  if (result.confirmed) return settleConfirmed(row, via, targetUrl, io);
  if (result.codeNeeded) {
    // Not applied, not an unconfirmed click: the page is held and the founder types the emailed code.
    onHeldExpired(rowId, () => void settleUnconfirmed(row, targetUrl, "No code was typed within 10 minutes, so the form was closed.", io));
    await io.text(codeNeededMessage(row), buildBlockedKeyboard(row.id, targetUrl, answerLink(row.id), cardTag(sessionForRow(row.id))));
    return { kind: "code-needed", row, detail: result.evidence };
  }
  return settleUnconfirmed(row, targetUrl, result.evidence, io);
}

async function settleConfirmed(row: JobApplication, via: SubmitVia, targetUrl: string, io: SubmitIo): Promise<SubmitResult> {
  await markRowApplied(row);
  await auditConfirmed(row, via, targetUrl);
  endSession(row.id);
  await io.settled();
  await io.text(`✅ <b>Application submitted and marked applied</b> — ${safeHtml(row.company)} (${safeHtml(row.title)}). It's off today's queue.`);
  return { kind: "confirmed", row, detail: "Application submitted and marked applied." };
}

async function settleUnconfirmed(row: JobApplication, targetUrl: string, evidence: string, io: SubmitIo): Promise<SubmitResult> {
  // The click went through, so the application may have arrived: no Submit here or on the tapped card.
  noteUnconfirmedClick(row.id, evidence);
  await io.settled();
  await io.text(
    `⚠ <b>Could not confirm submission for ${safeHtml(row.company)}</b>: ${safeHtml(evidence)}\n` +
      `Submit was clicked, so it may have arrived. Check your email and the screenshot above before trying again; ` +
      `to retry, send <code>/apply ${shortJobId(row.id)}</code>.`,
    buildBlockedKeyboard(row.id, targetUrl, answerLink(row.id), cardTag(sessionForRow(row.id))),
  );
  return { kind: "unconfirmed", row, detail: evidence };
}

export type CodeResult =
  | { readonly kind: "none" | "invalid"; readonly detail: string }
  | { readonly kind: "code-needed" | "confirmed" | "unconfirmed"; readonly row: JobApplication; readonly detail: string };

/** The founder typed the emailed code. The caller holds the row's lock and has authenticated him. */
export async function runCodeEntry(rowId: string, via: SubmitVia, code: string, io: SubmitIo): Promise<CodeResult> {
  const row = await getApplicationById(rowId, getProfile().tenantId);
  if (!row) return { kind: "none", detail: "That role is no longer on file." };
  const entered: CodeEntryResult = await enterEmailCode(rowId, code);
  if (entered.kind === "none") return { kind: "none", detail: "There is no form waiting for a code." };
  if (entered.kind === "invalid") return { kind: "invalid", detail: entered.reason };
  const session = sessionForRow(rowId);
  const targetUrl = session?.targetUrl ?? getApplyUrl(row.url ?? "", row.company) ?? row.url ?? "";
  if (entered.screenshotPng.length > 0) {
    await io.photo(entered.screenshotPng, `${row.company} — post-code (${entered.kind})`, `apply-code-${row.id.slice(0, 8)}.png`);
  }
  if (entered.kind === "confirmed") {
    const done = await settleConfirmed(row, via, targetUrl, io);
    return { kind: "confirmed", row, detail: done.kind === "confirmed" ? done.detail : "" };
  }
  if (entered.kind === "code-needed") return { kind: "code-needed", row, detail: entered.evidence };
  await settleUnconfirmed(row, targetUrl, entered.evidence, io);
  return { kind: "unconfirmed", row, detail: entered.evidence };
}
