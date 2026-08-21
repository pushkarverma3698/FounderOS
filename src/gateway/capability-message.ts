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

/** Full welcome shown on /start. */
export function buildWelcomeMessage(firstName?: string): string {
  const greet = firstName ? ` ${firstName}` : "";
  return (
    `👋 <b>FounderOS${greet}</b> — your AI chief of staff for Turicks + Naggar.\n\n` +
    `🎯 <b>Jobs — the daily loop</b>\n` +
    `<code>/jobs</code> — the ranked shortlist, top roles re-checked as still open\n` +
    `<code>/csv</code> — the queue as a spreadsheet file (<code>/csv all</code> = everything screened)\n` +
    `<code>/draft 1</code> — tailor a CV PDF for row 1 and send it to you to approve\n` +
    `<code>/ask 1</code> — the one question that unblocks row 1\n` +
    `<code>/applied 1</code> — mark it applied, drop it off the queue\n\n` +
    `<b>Everything else is plain English</b> — I route it to the right team:\n\n` +
    `🧠 <b>Admin</b> — <i>"What's my focus?" · "What did we decide about beta soak?"</i>\n` +
    `🔍 <b>Research</b> — <i>"Research Stripe's pricing" · "What's trending in AI agents?"</i>\n` +
    `📨 <b>Comms</b> ✋ — <i>"Summarise my inbox" · "Email alex@acme.com a short intro"</i>\n` +
    `⚙️ <b>Engineering</b> ✋ — <i>"List open issues on FounderOS"</i>\n` +
    `📣 <b>Marketing</b> ✋ — <i>"Draft a build-in-public post about today's ship"</i>\n` +
    `📈 <b>Sales</b> ✋ — <i>"Draft outreach to Razorpay"</i>\n` +
    `💻 <b>Personal</b> ✋ — <i>"List ~/Projects" · "Read founderos.log"</i>\n\n` +
    `⚡ <b>System</b>\n` +
    `<code>/status</code> · <code>/budget</code> · <code>/commands</code> · ` +
    `<code>/connect</code> · <code>/reset</code>\n\n` +
    `✋ = you approve before anything leaves the building (email, LinkedIn, GitHub writes, shell).\n` +
    `🛑 <code>/halt</code> pauses all work · <code>/resume</code> lifts it.`
  );
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
