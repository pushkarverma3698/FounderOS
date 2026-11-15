/**
 * Auto-send driver: sends one prepared, approved row through the existing Submit path (ADR-018 amendment 2026-11-15)
 * =================================================================================================================
 * The shadow pass has already decided `canAutoSend` (auto-send-rules.ts). This file only runs the send, and it
 * adds no way to click: it takes the row's lock, reserves the attempt, then calls `runSubmit`, which keeps every
 * guarantee (already-applied and already-audited checks, idempotency key, checkValidity before the click,
 * applied only on a confirmed page, an unconfirmed click remembered, the action_log row).
 *
 *   lock -> row on file -> cover letter clean (only when the form requires one) -> reserve attempt -> runSubmit -> result row -> Telegram
 *
 * The attempt row (job-auto-send-queries.ts) is written before the click and never deleted, so a row is never
 * sent twice, an unconfirmed click is never repeated, and the daily cap counts it.
 */

import type { InlineKeyboard } from "grammy";
import { getApplicationById } from "../db/apply-queries.js";
import { recordAutoSendResult, reserveAutoSend } from "../db/job-auto-send-queries.js";
import type { JobApplication } from "../db/schema.js";
import { childLogger } from "../infra/logger.js";
import { jobsChatId, sendMessageTo, sendPhoto } from "../infra/telegram-send.js";
import { letterIsRequired } from "../tools/jobhunt/auto-send-rules.js";
import type { FormPlanSummary } from "../tools/jobhunt/form-filled.js";
import { getProfile } from "../tools/jobhunt/profile-config.js";
import { artifactDirForChat, resolveCoverLetter } from "./apply-material.js";
import { tryLockApply } from "./apply-session.js";
import { runSubmit, type SubmitIo, type SubmitResult } from "./apply-submit.js";
import { safeHtml } from "./safe-html.js";

const log = childLogger({ module: "gateway:apply-auto-send" });

export type AutoSendOutcome =
  | { readonly kind: "sent"; readonly result: SubmitResult["kind"]; readonly detail: string }
  | { readonly kind: "no-letter"; readonly detail: string }
  | { readonly kind: "skipped"; readonly detail: string };

export interface AutoSendDeps {
  readonly chatId: () => string;
  readonly loadRow: (id: string, profileId: string) => Promise<JobApplication | null>;
  readonly letter: (row: JobApplication, profileId: string, chatId: string) => Promise<{ readonly ok: boolean; readonly reason?: string }>;
  readonly reserve: (row: { id: string; company: string; title: string }, profileId: string) => Promise<boolean>;
  readonly submit: typeof runSubmit;
  readonly record: (rowId: string, profileId: string, result: string, detail: string) => Promise<void>;
  readonly text: (chatId: string, html: string, keyboard?: InlineKeyboard) => Promise<void>;
  readonly photo: (chatId: string, png: Buffer, caption: string, filename: string) => Promise<void>;
}

export function realAutoSendDeps(): AutoSendDeps {
  return {
    chatId: jobsChatId,
    loadRow: (id, profileId) => getApplicationById(id, getProfile(profileId).tenantId),
    letter: async (row, profileId, chatId) => {
      const out = await resolveCoverLetter(row, getProfile(profileId), artifactDirForChat(chatId));
      return out.ok ? { ok: true } : { ok: false, reason: out.reason };
    },
    reserve: reserveAutoSend,
    submit: runSubmit,
    record: recordAutoSendResult,
    text: (chatId, html, keyboard) => sendMessageTo(chatId, html, { parse_mode: "HTML", ...(keyboard ? { reply_markup: keyboard } : {}) }),
    photo: (chatId, png, caption, filename) => sendPhoto(png, { chatId, caption, filename }),
  };
}

const RESULT_LABEL: Readonly<Record<SubmitResult["kind"], string>> = {
  confirmed: "confirmed",
  unconfirmed: "unconfirmed, not retried",
  failed: "not sent",
  "code-needed": "waiting for your emailed code",
  refused: "refused before sending",
};

function detailOf(result: SubmitResult): string {
  return result.kind === "refused" ? result.toast : result.detail;
}

/** Send one row the rules already cleared. Never throws for an expected refusal; a crash after the attempt is recorded and reported. */
export async function runAutoSend(
  row: { readonly id: string; readonly company: string; readonly title: string },
  profileId: string,
  summary: FormPlanSummary,
  deps: AutoSendDeps = realAutoSendDeps(),
): Promise<AutoSendOutcome> {
  const release = tryLockApply(row.id, Date.now(), "submit");
  if (!release) return { kind: "skipped", detail: "the row is being filled or sent already" };
  const chatId = deps.chatId();
  try {
    const full = await deps.loadRow(row.id, profileId);
    if (!full) return { kind: "skipped", detail: "the role is no longer on file" };
    if (letterIsRequired(summary)) {
      const letter = await deps.letter(full, profileId, chatId);
      if (!letter.ok) return { kind: "no-letter", detail: `the form requires a cover letter and none passed the fact check: ${letter.reason ?? "not written"}` };
    }
    if (!(await deps.reserve(full, profileId))) return { kind: "skipped", detail: "an earlier auto-send attempt exists for this row; never repeated" };

    const io: SubmitIo = {
      text: (html, keyboard) => deps.text(chatId, html, keyboard),
      photo: (png, caption, filename) => deps.photo(chatId, png, caption, filename),
      started: async () => undefined,
      settled: async () => undefined,
    };
    let result: SubmitResult;
    try {
      result = await deps.submit(row.id, chatId, "auto", io);
    } catch (err) {
      // allow-failopen: the attempt row stays (no repeat); the crash is recorded and told to the candidate.
      const message = (err as Error).message;
      log.error({ rowId: row.id, err: message }, "Auto-send crashed after the attempt was recorded");
      await deps.record(row.id, profileId, "error", message);
      await deps.text(chatId, `🤖 <b>Auto-send crashed</b> for ${safeHtml(full.company)} (${safeHtml(full.title)}): ${safeHtml(message)}. Not retried; check your email before applying by hand.`);
      return { kind: "sent", result: "failed", detail: message };
    }
    const detail = detailOf(result);
    await deps.record(row.id, profileId, result.kind, detail);
    await deps.text(chatId, `🤖 <b>Auto-sent</b> — ${safeHtml(full.company)}, ${safeHtml(full.title)}: ${RESULT_LABEL[result.kind]}. ${safeHtml(detail)}`);
    return { kind: "sent", result: result.kind, detail };
  } finally {
    release();
  }
}
