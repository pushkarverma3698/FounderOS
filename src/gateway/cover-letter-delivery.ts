/**
 * FounderOS — delivering the cover letter
 * ========================================
 * Split out of jobhunt-commands.ts, which the LOC budget caught at 473 lines.
 * The split is the right shape anyway: composing the two application artefacts
 * and delivering one of them are different jobs, and this file is the second.
 */

import type { Context } from "grammy";
import { recordTailoringResult } from "../db/job-queries.js";
import { buildCoverLetter, type CoverLetterModel } from "../tools/jobhunt/cover-letter.js";
import { invokeWorkerWithFallbacks } from "../agents/worker-invoke.js";
import { uploadFile } from "../infra/storage/s3-client.js";
import { safeHtml } from "./approval-card.js";
import { childLogger } from "../infra/logger.js";
import type { JobApplication } from "../db/schema.js";

const log = childLogger({ module: "gateway:cover-letter" });

/**
 * Write the cover letter and put it in the chat, ready to paste.
 *
 * SENT AS TEXT, NOT A FILE, because of how an application is actually
 * submitted: the CV is uploaded and the letter is pasted into a box. A PDF he
 * has to open and copy out of is a worse version of a message he can already
 * read, and Telegram's own copy control works on a text message.
 *
 * SENT BEFORE the CV delivery turn, so the letter is on screen while the kernel
 * takes its time over `deliver_artifact` and its approval card.
 *
 * NEVER FATAL. The tailored CV is already on disk and about to be delivered. A
 * provider outage, or a draft that could not be cleaned up to the voice rules,
 * costs the letter and not the application — but it says so out loud, because a
 * `/draft` that quietly produced half of what it used to is exactly the kind of
 * silent regression this lane has been bitten by before.
 */
export async function sendCoverLetter(
  ctx: Context,
  row: JobApplication,
  cvMarkdown: string,
): Promise<void> {
  // cover-letter.ts is deliberately ignorant of LangChain so its tests cost
  // nothing and run offline. The role/content pairs it speaks map onto
  // LangChain's tuple message form here, at the one place that knows both.
  //
  // Through the fallback chain, not the bare primary: this used to call
  // `getWorkerModel().invoke` directly, so a Gemini 503 cost the letter even
  // though two working fallbacks were configured on the same key (prod,
  // 2026-08-21). The CV half had the identical bug.
  const model: CoverLetterModel = { invoke: (messages) => invokeWorkerWithFallbacks(messages) };

  const result = await buildCoverLetter(
    {
      companyName: row.company,
      jobTitle: row.title,
      jobDescription: row.description ?? "",
      track: row.track,
      cvText: cvMarkdown,
    },
    model,
  );

  if (!result.success || !result.letter) {
    log.warn(
      { id: row.id, company: row.company, reason: result.error },
      "Cover letter not produced — CV delivery continues",
    );
    await ctx.reply(
      `⚠ No cover letter this time: ${safeHtml((result.error ?? "unknown").slice(0, 300))}\n` +
        `The tailored CV is still on its way.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  await archiveCoverLetter(row, result.letter);
  await ctx.reply(
    `<b>Cover letter — ${safeHtml(row.company)}</b>\n` +
      `<i>Tap to copy, then paste it into the application form.</i>\n\n` +
      `<pre>${safeHtml(result.letter)}</pre>`,
    { parse_mode: "HTML" },
  );
}

/**
 * Keep a copy beside the CV in S3. Best-effort, exactly like `archiveTailoredCv`.
 *
 * `cover_letter_s3_key` has existed on `job_applications` since the table was
 * written and nothing has ever set it. Writing it here is what makes the column
 * mean something: two weeks from now, "what did I actually send Ockto" has an
 * answer that is not a guess.
 */
async function archiveCoverLetter(row: JobApplication, letter: string): Promise<void> {
  try {
    const prefix = `ready-applications/${new Date().toISOString().slice(0, 10)}/${row.company.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    const key = await uploadFile(Buffer.from(letter, "utf8"), "cover_letter.txt", row.id, prefix);
    await recordTailoringResult(row.id, { tailorStatus: "tailored", coverLetterS3Key: key });
  } catch (err) {
    // allow-failopen: the letter is already written and about to reach Telegram;
    // losing the archive copy must not cost the founder the delivery itself.
    log.warn(
      { id: row.id, company: row.company, err: (err as Error).message },
      "S3 archive of the cover letter failed — Telegram delivery still proceeds",
    );
  }
}
