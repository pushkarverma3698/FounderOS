/**
 * FounderOS — the tappable home screen
 * ====================================
 * `/start` and `/commands` stop being walls of text you have to read, memorise
 * and then retype. They become four buttons.
 *
 * WHY. Everything this bot can do was already documented in the chat, and the
 * founder's verdict on 2026-09-23 was "I am unable to see the improved UI or
 * UX". He was right, and the reason is not that the copy was bad. Reading a
 * 48-line message, remembering one command out of 33, and typing it back with
 * exact syntax is three separate chances to drop the thread — and the ☰ menu
 * that was supposed to fix that has 33 entries with the engineering loop at
 * number 23, under 22 job commands.
 *
 * A button costs one tap and nothing to remember. That is the whole idea here:
 * NOTHING on this screen has to be typed to be reachable.
 *
 * ## Why the sections re-render in place
 *
 * Each tap EDITS the message rather than sending a new one. A help screen that
 * appends pushes the thing you were reading off the top of the phone, which is
 * how a chat becomes something to scroll rather than something to use. One
 * message, four faces, a Back button on each.
 *
 * ## No state
 *
 * The section is in the callback payload. Nothing is remembered between taps, so
 * a restart mid-browse loses nothing and an old message stays live.
 */

import type { Context } from "grammy";
import { DISPATCH_REPO_ALLOWLIST } from "../tools/dispatch-repos.js";
import { labelForRepo } from "./repo-picker.js";

export const MENU_CALLBACK_PREFIX = "menu:";

export type MenuSection = "home" | "build" | "jobs" | "system";

const SECTIONS: readonly MenuSection[] = ["home", "build", "jobs", "system"];

export function isMenuSection(value: string): value is MenuSection {
  return (SECTIONS as readonly string[]).includes(value);
}

/**
 * The first screen.
 *
 * Deliberately short. Its job is not to teach the product — it is to show that
 * there are three lanes and that each is one tap away. The detail lives behind
 * the buttons, where it is read on purpose rather than skimmed by accident.
 */
function homeText(firstName?: string): string {
  const greet = firstName ? ` ${firstName}` : "";
  return (
    `👋 <b>FounderOS${greet}</b> — your AI chief of staff for Turicks + Naggar.\n\n` +
    `<b>Tap a lane. Nothing here has to be memorised.</b>\n\n` +
    // The commands are named as well as buttoned. A button is faster, but the
    // name is what makes the ☰ menu and the keyboard legible to each other —
    // and what he can type straight away when he already knows what he wants.
    `🎯 <b>Jobs</b> — the daily shortlist and the apply queue\n` +
    `    <code>/jobs</code> · <code>/csv</code> · <code>/draft 1</code>\n` +
    `🤖 <b>Build</b> — describe a change, it ships while you are away\n` +
    `    <code>/task</code> · <code>/tasks</code>\n` +
    `⚡ <b>System</b> — health, today's spend, the emergency stop\n` +
    `    <code>/status</code> · <code>/budget</code>\n\n` +
    `<b>Or just talk to me</b> — I route it to the right team:\n` +
    `🧠 Admin\n` +
    `🔍 Research\n` +
    `📨 Comms \u2022 asks first\n` +
    `⚙️ Engineering \u2022 asks first\n` +
    `📣 Marketing \u2022 asks first\n` +
    `📈 Sales \u2022 asks first\n` +
    `💻 Personal \u2022 asks first\n\n` +
    `<i>"What's my focus?" · "Research Stripe's pricing" · "Summarise my inbox"</i>`
  );
}

/**
 * The engineering loop, written as what HAPPENS rather than as a command list.
 *
 * The numbered stages are the point. The loop runs unattended for 20–40 minutes
 * and posts to this chat at two of those stages; a founder who does not know
 * that a screenshot is coming reads the silence as a failure and the photo as
 * noise.
 */
function buildText(): string {
  return (
    `🤖 <b>Build things while you are away</b>\n\n` +
    `Send <code>/task</code> and say what you want, in one line. ` +
    `<b>I ask which repo with buttons</b> — you never type a repo name.\n\n` +
    `<i>Example: /task the login page is broken on mobile</i>\n\n` +
    `<b>What then happens, unattended, in 20–40 min:</b>\n` +
    `1️⃣ I expand your line into a full engineering brief\n` +
    `2️⃣ <b>You approve it</b> — one tap, here\n` +
    `3️⃣ It becomes a GitHub issue the agent loop can claim\n` +
    `4️⃣ Antigravity writes the code and opens a pull request\n` +
    `5️⃣ <b>The app is started and photographed</b> — screenshots land in this chat\n` +
    `6️⃣ Claude reviews the PR and posts a verdict\n` +
    `7️⃣ Anything unresolved goes back to step 4, by itself\n\n` +
    `<b>The other two:</b>\n` +
    `🔹 <code>/tasks</code> — what the loop is doing right now, and what needs you\n` +
    `🔹 <code>/newproject pricing-api usage-based pricing</code> — starts a whole new repo\n\n` +
    `<b>Repos it can work in:</b>\n` +
    DISPATCH_REPO_ALLOWLIST.map((slug) => `· ${labelForRepo(slug)}`).join("\n") +
    `\n\n<i>On the Oplify repos you always click merge yourself.</i>`
  );
}

function jobsText(): string {
  return (
    `🎯 <b>Jobs — the daily loop</b>\n\n` +
    `🔹 <code>/fresh</code> — what arrived since you last looked\n` +
    `🔹 <code>/today</code> — only what an employer published in the last 24h\n` +
    `🔹 <code>/jobs</code> — everything on file, freshest first\n` +
    `🔹 <code>/csv</code> — the queue as a spreadsheet file\n` +
    `🔹 <code>/draft 1</code> — tailor a CV + cover letter for row 1\n` +
    `🔹 <code>/ask 1</code> — the one question that unblocks row 1\n` +
    `🔹 <code>/applied 1</code> — mark it applied, drop it off the queue\n` +
    `🔹 <code>/gaps</code> — keywords the market wants that your CV does not say\n` +
    `🔹 <code>/profile</code> — what every application form gets filled from\n\n` +
    `<b>Every one of these has a <code>wife_</code> twin</b> for Tashi's queue — ` +
    `<code>/wife_jobs</code>, <code>/wife_draft 1</code>, and so on.\n\n` +
    `<b>Plain English hits the same code:</b>\n` +
    `<i>"tashi's jobs" · "what did we find in the last 2 days" · "roles posted this week"</i>\n\n` +
    `<b>posted</b> = when the employer published it. <b>found</b> = when we first saw it. ` +
    `Every row prints both.`
  );
}

function systemText(): string {
  return (
    `⚡ <b>System</b>\n\n` +
    `🔹 <code>/status</code> — health and anything waiting on your approval\n` +
    `🔹 <code>/budget</code> — today's spend against the daily cap\n` +
    `🔹 <code>/connect</code> — search and add an MCP server\n` +
    `🔹 <code>/reset</code> — clear this thread's mission state\n` +
    `🔹 <code>/commands</code> — the full list, every command, in text\n\n` +
    `🛑 <code>/halt</code> — emergency stop, refuse all new work\n` +
    `▶️ <code>/resume</code> — lift a halt\n\n` +
    `<i>Every command is also in the ☰ button next to the message box.</i>`
  );
}

export function buildMenuSection(section: MenuSection, firstName?: string): string {
  if (section === "build") return buildText();
  if (section === "jobs") return jobsText();
  if (section === "system") return systemText();
  return homeText(firstName);
}

const LABELS: Readonly<Record<MenuSection, string>> = {
  home: "🏠 Back",
  build: "🤖 Build something",
  jobs: "🎯 Jobs",
  system: "⚡ System",
};

/**
 * The buttons under a section.
 *
 * The section you are already reading is never offered again — a button that
 * re-renders the identical message reads as a dead button, and Telegram rejects
 * an edit that changes nothing, so it would also throw.
 */
export function buildMenuKeyboardRows(active: MenuSection): { text: string; callback_data: string }[][] {
  const button = (s: MenuSection) => ({ text: LABELS[s], callback_data: `${MENU_CALLBACK_PREFIX}${s}` });

  if (active === "home") {
    return [[button("build")], [button("jobs"), button("system")]];
  }
  return [
    SECTIONS.filter((s) => s !== "home" && s !== active).map(button),
    [button("home")],
  ];
}

export function menuKeyboard(active: MenuSection): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  return { inline_keyboard: buildMenuKeyboardRows(active) };
}

/**
 * A tapped section button.
 *
 * Returns false for a payload that is not ours so the caller falls through to
 * its other handlers. An edit that fails (message too old to edit, or Telegram
 * deciding the content is unchanged) is answered with a fresh message rather
 * than swallowed: a tap that produces nothing at all is the failure this whole
 * screen exists to remove.
 */
export async function handleMenuCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith(MENU_CALLBACK_PREFIX)) return false;

  const section = data.slice(MENU_CALLBACK_PREFIX.length);
  if (!isMenuSection(section)) {
    await ctx.answerCallbackQuery({ text: "Unknown section" });
    return true;
  }

  await ctx.answerCallbackQuery();
  const text = buildMenuSection(section, ctx.from?.first_name);
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: menuKeyboard(section) });
  } catch {
    // allow-failopen: an un-editable message must still answer the tap — sending is the fallback, silence is not.
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: menuKeyboard(section) });
  }
  return true;
}
