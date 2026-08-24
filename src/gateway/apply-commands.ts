/**
 * FounderOS — /apply
 * ===================
 * The command that replaces "48 fields, one at a time" with one tap.
 *
 * `/draft N` produces a tailored CV and a link — the founder still fills the
 * form himself. `/apply N` does the same tailoring, then drives the actual
 * form: fills it (attaching the tailored CV), screenshots the result, and
 * shows it to him. Nothing is sent to the employer at this point — the
 * screenshot is informational, the same trust class as `deliver_artifact`
 * sending a PDF.
 *
 * The one thing that IS an external action — clicking Submit — happens only
 * after a kernel turn routes to `submit_application`, which is HITL-gated
 * (ADR-018). This command never calls it directly; it only asks the kernel to.
 *
 * PLATFORM SCOPE, v1: Greenhouse, Lever, Ashby, Workable, Recruitee — see
 * `apply-driver.ts`'s `detectApplyAts`. Workday and anything unrecognised
 * falls back to pointing at `/draft N`, never silently does nothing.
 */

import type { Context } from "grammy";
import * as path from "node:path";
import { resolveBriefRow, buildApplicationPacket, DRAFT_SECTIONS } from "../tools/jobhunt/apply-packet.js";
import { readApplyProfile } from "../tools/jobhunt/apply-profile.js";
import { previewApplyFlow } from "../tools/jobhunt/apply-headless.js";
import { detectApplyAts } from "../tools/jobhunt/apply-driver.js";
import { sendCoverLetter } from "./cover-letter-delivery.js";
import { unresolvedMessage } from "./jobhunt-commands.js";
import { parseRowArg } from "./jobhunt-commands.js";
import { sendPhoto } from "../infra/telegram-send.js";
import { ARTIFACT_ROOT } from "../core/config.js";
import { threadIdFor } from "./kernel-run.js";
import { childLogger } from "../infra/logger.js";
import type { JobhuntCommandDeps } from "./jobhunt-commands.js";

const log = childLogger({ module: "gateway:apply-commands" });

function artifactDirFor(ctx: Context): string {
  const safeThreadDir = threadIdFor(ctx.chat?.id ?? "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(ARTIFACT_ROOT, safeThreadDir);
}

/** `/apply N` — fill the real form, show it, then hand off to the HITL-gated submit. */
export async function handleApply(ctx: Context, deps: JobhuntCommandDeps): Promise<void> {
  const rank = parseRowArg(ctx.match?.toString() ?? "");
  if (rank === null) {
    await ctx.reply(unresolvedMessage("apply", null));
    return;
  }

  const row = await resolveBriefRow(rank, DRAFT_SECTIONS);
  if (!row) {
    await ctx.reply(unresolvedMessage("apply", rank));
    return;
  }

  const ats = detectApplyAts(row.url ?? "");
  if (!ats) {
    await ctx.reply(
      `${row.company}'s form isn't one of the five platforms I can drive yet (Greenhouse, Lever, Ashby, Workable, Recruitee). ` +
        `Send /draft ${rank} for the tailored CV and a direct link instead.`,
    );
    return;
  }

  const profileRead = await readApplyProfile();
  if (!profileRead.ok) {
    await ctx.reply(
      `Can't fill a form yet — no usable apply profile: ${profileRead.reason}. Send /profile to see what's missing.`,
    );
    return;
  }

  log.info({ command: "apply", rank, company: row.company, id: row.id, ats }, "Apply command resolved");
  await ctx.reply(`📝 Filling the form for ${row.company}… this takes 20–40s.`);

  const built = await buildApplicationPacket(row, artifactDirFor(ctx));
  if (!built.ok) {
    await ctx.reply(
      `⚠ Couldn't tailor a CV for ${row.company} (${built.reason.slice(0, 200)}) — falling back to a text draft.`,
    );
    await deps.runKernelText(ctx, `Draft a job application for row ${rank} of the brief.`);
    return;
  }

  const { packet } = built;
  await sendCoverLetter(ctx, row, packet.cvMarkdown);

  const preview = await previewApplyFlow(row.url ?? "", profileRead.profile, { resumePath: packet.pdfPath, coverLetterText: packet.cvMarkdown });
  if (!preview.ok) {
    await ctx.reply(
      `⚠ Couldn't fill the form automatically for ${row.company} (${preview.reason}). ` +
        `The tailored CV above is still yours to use — apply at ${row.url ?? "the posting"} and send /applied ${rank} when done.`,
    );
    return;
  }

  const { summary, unansweredQuestions } = preview;
  const unansweredList =
    unansweredQuestions.length > 0
      ? `\n\nLeft for you: ${unansweredQuestions.slice(0, 6).join("; ")}${unansweredQuestions.length > 6 ? `, +${unansweredQuestions.length - 6} more` : ""}`
      : "\n\nNothing left blank.";

  await sendPhoto(preview.screenshotPng, {
    caption: `${row.company} — ${row.title}\n${summary.filled}/${summary.total} fields filled.${unansweredList}`,
  });

  await deps.runKernelText(
    ctx,
    `Call the submit_application tool now with job_id="${row.id}". ` +
      `Do not do anything else — do not read the file, do not summarize it, do not compose any other message. ` +
      `Just call that one tool with exactly that one argument.`,
  );
}
