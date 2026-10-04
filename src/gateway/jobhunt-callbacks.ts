/**
 * FounderOS — the 📝 Draft and ✅ I applied buttons
 * =================================================
 * Handles `jh:` callbacks (see jobhunt-buttons.ts). No kernel turn: a tap is a
 * plain state change or the same tailoring path `/draft` runs.
 *
 * Works for whoever taps in a chat the bot already serves, including Tashi in the
 * family group. The profile is read off THE ROW, never off the chat, so her tap
 * on her own alert applies her CV to her role.
 */

import type { Context } from "grammy";
import { getApplicationById } from "../db/apply-queries.js";
import { getProfile, listProfiles } from "../tools/jobhunt/profile-config.js";
import { childLogger } from "../infra/logger.js";
import { draftRow, type JobhuntCommandDeps } from "./jobhunt-commands.js";
import { markRowApplied, parseJobCallback, JOB_CALLBACK_PREFIX } from "./jobhunt-buttons.js";
import { draftButtonsFor, parseViewCallback, type ViewCallback } from "./jobhunt-compact.js";
import { gapAddReply, parseGapCallback } from "./jobhunt-gap-buttons.js";
import { buildJobsCsv, type JobsViewDeps } from "./jobhunt-view.js";
import { parseBriefRequest, scopeFor } from "../tools/jobhunt/brief-resolver.js";
import { InputFile } from "grammy";

const log = childLogger({ module: "gateway:jobhunt-callbacks" });

/** False when the payload is not ours, so the next callback handler gets it. */
export async function handleJobCallback(
  ctx: Context,
  deps: JobhuntCommandDeps,
  jobs?: JobsViewDeps,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith(JOB_CALLBACK_PREFIX)) return false;

  const gap = parseGapCallback(data);
  if (gap) {
    await ctx.answerCallbackQuery();
    await ctx.reply(gapAddReply(gap.term), { parse_mode: "HTML" });
    return true;
  }

  const view = parseViewCallback(data);
  if (view) return handleViewTap(ctx, view, jobs);

  const parsed = parseJobCallback(data);
  if (!parsed) {
    await ctx.answerCallbackQuery({ text: "That button is out of date." });
    return true;
  }

  const row = await getApplicationById(parsed.rowId, getProfile().tenantId);
  if (!row) {
    await ctx.answerCallbackQuery({ text: "That role is no longer on file." });
    return true;
  }

  if (parsed.action === "applied") {
    const result = await markRowApplied(row);
    if (!result.ok) {
      await ctx.answerCallbackQuery({ text: "Couldn't save that. Nothing changed." });
      return true;
    }
    log.info({ command: "applied", id: row.id, company: row.company, button: true }, "Application marked applied");
    await ctx.answerCallbackQuery({ text: result.already ? "Already marked applied" : "✅ Marked applied" });
    // Spend the button so a second tap cannot look like a second application.
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(
      // allow-failopen: cosmetic; the state is already written.
      () => undefined,
    );
    await ctx.reply(`✅ Marked applied — ${row.company} (${row.title}). It's off today's queue.`);
    return true;
  }

  await ctx.answerCallbackQuery({ text: "Tailoring…" });
  const profile = getProfile(row.profile_id);
  await draftRow(ctx, row, deps, "", profile);
  return true;
}

/** ➕ Show more (the full brief, rebuilt) and 📎 CSV (the queue as a file) under the one-message brief. */
async function handleViewTap(ctx: Context, tap: ViewCallback, jobs?: JobsViewDeps): Promise<boolean> {
  const profile = listProfiles().find((p) => p.id === tap.profileId);
  if (!jobs || !profile) {
    await ctx.answerCallbackQuery({ text: "That button is out of date." });
    return true;
  }
  try {
    if (tap.kind === "csv") {
      await ctx.answerCallbackQuery({ text: "Building the file…" });
      const file = await buildJobsCsv("queue", new Date(), profile.id);
      await ctx.replyWithDocument(new InputFile(Buffer.from(file.csv, "utf8"), file.filename), { caption: file.caption });
      return true;
    }
    await ctx.answerCallbackQuery({ text: "Building the full brief…" });
    const request = parseBriefRequest("", tap.verb);
    if ("unknown" in request) throw new Error("brief request did not resolve");
    const brief = await jobs.buildBrief(profile, scopeFor({ ...request, profileId: profile.id }, { lastFreshView: null }));
    const chunks = jobs.split(brief);
    const buttons = await draftButtonsFor(profile, brief);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1500));
      const last = i === chunks.length - 1 && buttons !== null;
      await ctx.reply(chunks[i] as string, { parse_mode: "HTML", ...(last ? { reply_markup: buttons } : {}) });
    }
  } catch (err) {
    log.error({ err: (err as Error).message, tap: tap.kind }, "Brief view button failed");
    await ctx.reply(`❌ Couldn't build that: ${(err as Error).message.slice(0, 200)}. Try /jobs again.`);
  }
  return true;
}
