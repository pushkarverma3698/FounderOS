/**
 * Product capability copy for /start and process-restart notifications.
 * Single source of truth — update here when departments/tools change.
 */

/** Full welcome shown on /start. */
export function buildWelcomeMessage(firstName?: string): string {
  const greet = firstName ? ` ${firstName}` : "";
  return (
    `👋 <b>FounderOS${greet}</b> — your AI chief of staff for Turicks + Naggar.\n\n` +
    `<b>What you can do</b> (just type naturally — I route to the right team):\n\n` +
    `🧠 <b>Admin</b> — focus, deals, memory\n` +
    `<i>"What's my focus?" · "What did we decide about beta soak?" · /context</i>\n\n` +
    `🔍 <b>Research</b> — web + knowledge base\n` +
    `<i>"Research Stripe's pricing" · "What's trending in AI agents?"</i>\n\n` +
    `📨 <b>Comms</b> — inbox + email + calendar ✋\n` +
    `<i>"Summarise my inbox" · "Email alex@acme.com a short intro"</i>\n\n` +
    `⚙️ <b>Engineering</b> — GitHub + code ✋\n` +
    `<i>"List open issues on FounderOS" · "Create a GitHub issue for …"</i>\n\n` +
    `📣 <b>Marketing</b> — LinkedIn drafts ✋\n` +
    `<i>"Draft a build-in-public post about today's ship"</i>\n\n` +
    `📈 <b>Sales</b> — ICP + cold outreach ✋\n` +
    `<i>/target Acme, Beta · /outbound · "Draft outreach to Razorpay"</i>\n\n` +
    `💻 <b>Personal</b> — your laptop (files, shell, Safari) ✋\n` +
    `<i>"List ~/Projects" · "Read founderos.log" · "Open URL in Safari"</i>\n\n` +
    `🎯 <b>Jobhunt</b> — CV + job search\n` +
    `<i>"Find LangGraph roles" · "Draft a cover letter from my CV"</i>\n\n` +
    `🏭 <b>Workflows</b> — multi-step SOPs\n` +
    `<code>/workflows</code> · <code>/run onboarding company=Acme</code>\n\n` +
    `⚡ <b>Power shortcuts</b>\n` +
    `<code>/q research …</code> · <code>/signals</code> · <code>/runs</code> · ` +
    `<code>/status</code> · <code>/ping</code> · <code>/departments</code> · <code>/help</code>\n\n` +
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
    `• <i>"Research [company] and score them for outreach"</i>\n` +
    `• <i>"List open GitHub issues on FounderOS"</i>\n` +
    `• <i>"What's my focus this week?"</i>\n` +
    `• <code>/target CompanyA, CompanyB</code> then <code>/outbound</code>\n\n` +
    `Full capability guide: <code>/start</code> · live status: <code>/status</code>`
  );
}
