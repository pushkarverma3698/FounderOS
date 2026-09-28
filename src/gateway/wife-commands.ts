/**
 * FounderOS — /wife_commands: every command for Tashi's queue
 * ===========================================================
 * The `wife_` aliases left the ☰ menu on 2026-09-28 (they were 11 of its 34
 * rows, and every job command already takes a profile word). The founder's
 * condition: nothing she can do may go missing. This is the one visible row
 * that lists them all, and the Jobs screen's "👩 Tashi's jobs" button shows the
 * same text (home-menu.ts), so the two cannot drift.
 *
 * Rendered from COMMAND_MENU's `hidden` rows — description and `example` come
 * from the one list, so adding an alias there adds it here. A test fails if a
 * registered `wife_` command is on no visible surface.
 */

import type { Context } from "grammy";
import { COMMAND_MENU, formatCommandDetail } from "./command-menu.js";
import { esc } from "../tools/jobhunt/telegram-format.js";
import { splitForTelegram } from "./format.js";

/** The whole list as one HTML message (splitting, if ever needed, happens on send). */
export function buildWifeCommandsHelp(): string {
  const rows = COMMAND_MENU.filter((e) => e.hidden).map(
    (e) =>
      `🔸 <b>/${e.command}</b> — <i>${formatCommandDetail(e)}</i>` +
      (e.example ? `\n    e.g. <code>${esc(e.example)}</code>` : ""),
  );
  return [
    "👩 <b>Tashi's commands</b>",
    "These act on Tashi's queue. They are out of the ☰ menu to keep it short, and every one still works.",
    "<b>Or add tashi to any job command:</b> <code>/jobs tashi</code> · <code>/draft tashi 3</code> · <code>/csv tashi</code>",
    ...rows,
  ].join("\n\n");
}

/** `/wife_commands` — split across messages rather than truncated if it ever outgrows one. */
export async function handleWifeCommands(ctx: Context): Promise<void> {
  for (const part of splitForTelegram(buildWifeCommandsHelp())) {
    await ctx.reply(part, { parse_mode: "HTML" });
  }
}
