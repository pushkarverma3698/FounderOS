/**
 * FounderOS: delivering the cover letter
 * ======================================
 * Writing the letter lives in src/tools/jobhunt/cover-letter-write.ts, shared with the daily pre-tailor step.
 * This file is the Telegram half: put the letter in the chat, ready to paste.
 */

import type { Context } from "grammy";
import { writeCoverLetter } from "../tools/jobhunt/cover-letter-write.js";
import { safeHtml } from "./approval-card.js";
import { childLogger } from "../infra/logger.js";
import type { JobApplication } from "../db/schema.js";

export { founderContextFor } from "../tools/jobhunt/cover-letter-write.js";

const log = childLogger({ module: "gateway:cover-letter" });

/**
 * SENT AS TEXT, NOT A FILE, because of how an application is actually submitted: the CV is uploaded and the letter
 * is pasted into a box. Telegram's own copy control works on a text message.
 */
export function coverLetterMessage(company: string, letter: string): string {
  return (
    `<b>Cover letter — ${safeHtml(company)}</b>\n` +
    `<i>Tap to copy, then paste it into the application form.</i>\n\n` +
    `<pre>${safeHtml(letter)}</pre>`
  );
}

/**
 * Write the cover letter and put it in the chat. SENT BEFORE the CV, so the letter is on screen while the PDF arrives.
 *
 * NEVER FATAL. The tailored CV is already built. A provider outage, or a draft that could not be cleaned up to the
 * voice rules, costs the letter and not the application, but it says so out loud: a /draft that quietly produced half
 * of what it used to is the kind of silent regression this lane has been bitten by before.
 */
export async function sendCoverLetter(ctx: Context, row: JobApplication, cvMarkdown: string): Promise<void> {
  const result = await writeCoverLetter(row, cvMarkdown);
  if (!result.ok) {
    log.warn({ id: row.id, company: row.company, reason: result.reason }, "Cover letter not produced — CV delivery continues");
    await ctx.reply(
      `⚠ No cover letter this time: ${safeHtml(result.reason.slice(0, 300))}\n` + `The tailored CV is still on its way.`,
      { parse_mode: "HTML" },
    );
    return;
  }
  await ctx.reply(coverLetterMessage(row.company, result.letter), { parse_mode: "HTML" });
}
