/**
 * FounderOS: Draft returns what the morning already built
 * =========================================================
 * The daily pre-tailor step (src/tools/jobhunt/pretailor-cron.ts) stores a tailored CV and a cover letter in S3 for
 * the top roles. Before this file the Draft button ignored them and tailored again, 20-40 s and a paid call each
 * tap. Now a row that has a stored CV is answered from storage in a second or two; a row without one falls through
 * to the normal tailoring path, unchanged. Nothing here calls a model, and nothing leaves the chat that tapped.
 */

import { InputFile, type Context } from "grammy";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { downloadFile } from "../infra/storage/s3-client.js";
import { getApplyUrl, tailoredCvPath } from "../tools/jobhunt/apply-packet.js";
import { coverLetterMessage } from "./cover-letter-delivery.js";
import { packetKeyboard } from "./jobhunt-buttons.js";
import { safeHtml } from "./approval-card.js";
import { childLogger } from "../infra/logger.js";
import type { JobApplication } from "../db/schema.js";

const log = childLogger({ module: "gateway:jobhunt-stored-draft" });

/** The line that tells the founder what to do with the form. Shared with the fresh-draft packet message. */
export function applyLinkLine(applyUrl: string, opensTheForm: boolean): string {
  if (applyUrl.length === 0) return "⚠ No URL on file for this posting — search the company's careers page.";
  return opensTheForm
    ? "Tap <b>Open the form</b>, send the CV above, then tap <b>I applied</b>."
    : "Tap <b>Open the form</b> <i>(this ATS hides the form behind its own button)</i>, send the CV above, then tap <b>I applied</b>.";
}

/** Storage reads, injected so the test needs no S3. */
export interface StoredDraftIo {
  readonly download: (key: string) => Promise<Buffer>;
}

const REAL_IO: StoredDraftIo = { download: downloadFile };

/**
 * Answer a Draft tap from storage. True when the stored CV was sent; false when the caller should tailor as before
 * (no stored CV, or it could not be read). Everything is downloaded BEFORE anything is sent, so a false return
 * never leaves half a draft in the chat.
 */
export async function sendStoredDraft(
  ctx: Context,
  row: JobApplication,
  artifactDir: string,
  rank?: number,
  io: StoredDraftIo = REAL_IO,
): Promise<boolean> {
  const cvKey = row.tailored_cv_s3_key;
  if (!cvKey) return false;
  let pdfPath: string;
  let letter: string | null = null;
  try {
    const pdf = await io.download(cvKey);
    if (pdf.length === 0) throw new Error("stored CV is empty");
    pdfPath = tailoredCvPath(artifactDir, row);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(pdfPath, pdf);
  } catch (err) {
    // allow-failopen: the stored copy is an optimisation; the caller tailors fresh when it cannot be read.
    log.warn({ id: row.id, company: row.company, err: (err as Error).message }, "Stored CV unreadable — tailoring fresh");
    return false;
  }
  if (row.cover_letter_s3_key) {
    try {
      letter = (await io.download(row.cover_letter_s3_key)).toString("utf8");
    } catch (err) {
      // allow-failopen: the CV is the deliverable; a missing letter is said out loud below.
      log.warn({ id: row.id, company: row.company, err: (err as Error).message }, "Stored cover letter unreadable");
    }
  }
  log.info({ id: row.id, company: row.company, letter: letter !== null }, "Draft served from storage");
  await ctx.reply(`📝 Already tailored for ${safeHtml(row.company)}, sending it now.`, { parse_mode: "HTML" });
  if (letter) await ctx.reply(coverLetterMessage(row.company, letter), { parse_mode: "HTML" });
  else await ctx.reply("⚠ No cover letter was stored for this role.");
  await ctx.replyWithDocument(new InputFile(pdfPath, path.basename(pdfPath)), { caption: `Tailored CV — ${row.company} — ${row.title}` });
  const formUrl = getApplyUrl(row.url ?? "", row.company);
  const applyUrl = formUrl ?? row.url ?? "";
  await ctx.reply(
    `<b>${rank === undefined ? "" : `${rank}. `}${safeHtml(row.company)} — ${safeHtml(row.title)}</b>\n` +
      `Permit basis: ${safeHtml(row.route)}\n\n${applyLinkLine(applyUrl, formUrl !== null)}`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: packetKeyboard(row.id, applyUrl) },
  );
  return true;
}
