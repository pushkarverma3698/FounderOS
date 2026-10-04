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
import { getProfile } from "../tools/jobhunt/profile-config.js";
import { childLogger } from "../infra/logger.js";
import { draftRow, type JobhuntCommandDeps } from "./jobhunt-commands.js";
import { markRowApplied, parseJobCallback, JOB_CALLBACK_PREFIX } from "./jobhunt-buttons.js";

const log = childLogger({ module: "gateway:jobhunt-callbacks" });

/** False when the payload is not ours, so the next callback handler gets it. */
export async function handleJobCallback(ctx: Context, deps: JobhuntCommandDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith(JOB_CALLBACK_PREFIX)) return false;

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
