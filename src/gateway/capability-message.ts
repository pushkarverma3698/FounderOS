/**
 * Product capability copy for /start and process-restart notifications.
 * Single source of truth — update here when departments/tools change.
 *
 * EVERY COMMAND NAMED HERE MUST BE REGISTERED IN `telegram.ts`. On 2026-08-21
 * this file was advertising twelve that were not: /target, /outbound,
 * /proofdrop, /signals, /runs, /ping, /departments, /help, /workflows, /run, /q
 * and the four /miso_* commands all died with the v2 orchestration layers (see
 * the header of commands.ts) and every one of them landed on
 * `unknownCommandReply`. The first screen a founder sees was a menu of dead
 * buttons, which teaches him not to trust the live ones either.
 *
 * The jobs loop leads, because it is the one used daily.
 */

import { buildMenuSection } from "./home-menu.js";

/**
 * Full welcome shown on /start.
 *
 * REDIRECTED 2026-09-23 to the tappable home screen in `home-menu.ts`. The old
 * body was a 48-line wall naming twenty commands: complete, accurate, and still
 * a screen the founder had to read, hold in his head and retype from. The
 * content did not shrink — it moved behind three buttons, which is the only
 * change that makes it reachable without remembering anything.
 *
 * This stays a named export because /start is not the only thing that wants the
 * welcome, and because the ONE-COPY rule at the top of this file is the point:
 * a second hand-maintained welcome is how the last one ended up advertising
 * twelve dead commands.
 */
export function buildWelcomeMessage(firstName?: string): string {
  return buildMenuSection("home", firstName);
}

/** Compact message sent to Telegram when the process boots or restarts. */
export function buildRestartMessage(): string {
  return (
    `🚀 <b>FounderOS is back online</b>\n\n` +
    `<b>8 departments ready:</b>\n` +
    `admin · research · comms · engineering · marketing · sales · personal · jobhunt\n\n` +
    `<b>Try now:</b>\n` +
    `• <code>/jobs</code> — today's ranked shortlist\n` +
    `• <code>/csv</code> — the queue as a spreadsheet file\n` +
    `• <i>"Research [company] and score them for outreach"</i>\n` +
    `• <i>"What's my focus this week?"</i>\n\n` +
    `Full capability guide: <code>/start</code> · every command: <code>/commands</code> · ` +
    `live status: <code>/status</code>`
  );
}
