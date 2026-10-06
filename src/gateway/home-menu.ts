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
import { REVIEWER } from "../tools/dispatch-roles.js";
import { labelForRepo } from "./repo-picker.js";
import { buildWifeCommandsHelp } from "./wife-commands.js";
import { CAPABILITIES_CALLBACK, DEPARTMENT_LABELS, sendCapabilities } from "./capabilities-screen.js";
import { WORKERS } from "../kernel/contracts.js";
import { buildCommandsHelp } from "./command-menu.js";
import { splitForTelegram } from "./format.js";

export const MENU_CALLBACK_PREFIX = "menu:";

/** The ➕ button on the home screen: the complete command list, one message per section. */
export const FULL_LIST_CALLBACK = `${MENU_CALLBACK_PREFIX}full`;

/** `wife` is Tashi's commands, reached from the Jobs screen — the same text as /wife_commands. */
export type MenuSection = "home" | "build" | "jobs" | "system" | "wife";

/** Every section. Exported so the tests cover a new one without being told about it. */
export const MENU_SECTIONS: readonly MenuSection[] = ["home", "build", "jobs", "system", "wife"];
const SECTIONS = MENU_SECTIONS;

/** The three lanes the home screen offers; `wife` hangs off `jobs`. */
const LANES: readonly MenuSection[] = ["build", "jobs", "system"];

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
    `    <code>/task</code> · <code>/tasks</code> · <code>/where</code>\n` +
    `⚡ <b>System</b> — health, today's spend, the emergency stop\n` +
    `    <code>/status</code> · <code>/budget</code> · <code>/login</code>\n\n` +
    // Every kernel worker, named from the same table the 🧭 list uses. The old
    // hand-written list left out jobhunt and marked "asks first" by hand (Admin
    // was wrong: schedule_task and record_event are gated). Which tools ask
    // first is now read from HITL_GATED_TOOLS, one tap away.
    `<b>Or just talk to me</b> — I route it to the right team:\n` +
    WORKERS.map((w) => `${DEPARTMENT_LABELS[w].emoji} ${DEPARTMENT_LABELS[w].label}`).join(" · ") +
    `\n<i>🧭 Everything I can do lists every tool each team has, and which ones ask you first.</i>\n\n` +
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
    `4️⃣ The coding CLI (Antigravity or Claude Code) writes the code and opens a pull request\n` +
    `5️⃣ <b>The app is started and photographed</b> — screenshots land in this chat\n` +
    `6️⃣ A different model, in a fresh session, reviews the PR (${REVIEWER}) and posts a verdict\n` +
    `7️⃣ Anything unresolved goes back to step 4, by itself\n\n` +
    `<b>Choosing who builds it:</b>\n` +
    `🔹 <code>/claude</code> · <code>/agy</code> — like /task, with Claude Code or Antigravity doing the work\n` +
    `🔹 <code>/engine</code> — which one plain /task uses; <code>/engine claude</code> switches it\n` +
    `🔹 <code>/review</code> — step 6 on or off, and which models review and write; <code>/review off</code> pauses it\n\n` +
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
    `🔹 <code>/replied 1</code> — a live application got an answer\n` +
    `🔹 <code>/rejected 1</code> — a live application was turned down\n` +
    `🔹 <code>/gaps</code> — keywords the market wants that your CV does not say\n` +
    `🔹 <code>/profile</code> — what every application form gets filled from\n\n` +
    `👩 <b>Tashi's queue:</b> add <code>tashi</code> to any of these — <code>/jobs tashi</code>, ` +
    `<code>/draft tashi 1</code>. Her <code>wife_</code> commands still work: tap below, or ` +
    `<code>/wife_commands</code>.\n\n` +
    `<b>Plain English hits the same code:</b>\n` +
    `<i>"tashi's jobs" · "what did we find in the last 2 days" · "roles posted this week"</i>\n\n` +
    `<b>posted</b> = when the employer published it. <b>found</b> = when we first saw it. ` +
    `Every row prints both.`
  );
}

function systemText(): string {
  return (
    `⚡ <b>System</b>\n\n` +
    `🔹 <code>/now</code> — coding, jobs and approvals in three lines, a button each\n` +
    `🔹 <code>/status</code> — health and anything waiting on your approval\n` +
    `🔹 <code>/budget</code> — today's spend against the daily cap\n` +
    `🔹 <code>/focus</code> — what you are focused on, with the date you last confirmed it. <code>/focus close the Acme pilot</code> replaces it\n` +
    `🔹 <code>/projects</code> — your active projects. <code>/projects FounderOS; Naggar site</code> replaces the list\n` +
    `🔹 <code>/remind call the landlord at 3pm</code> — a reminder, pinged at that time\n` +
    `🔹 <code>/goals</code> — your goals, each measured from real events and reported at 09:00\n` +
    `🔹 <code>/goal add …</code> — set a goal, report a value, finish, drop or block one (send <code>/goal</code> for the grammar)\n` +
    `🔹 <code>/connect</code> — search and add an MCP server\n` +
    `🔹 <code>/reset</code> — clear this thread's mission state\n` +
    `🔹 <code>/commands</code> — this screen; its 📜 button has every command\n` +
    `🔹 <code>/start</code> — this home screen\n\n` +
    `🛑 <code>/halt</code> — emergency stop, refuse all new work\n` +
    `▶️ <code>/resume</code> — lift a halt\n\n` +
    `<i>Every command is also in the ☰ button next to the message box.</i>`
  );
}

/**
 * Every command with what it does, rendered from COMMAND_MENU. `/commands` used to send this wall; it now
 * sends the home screen and this sits behind its 📜 button.
 */
export async function sendFullCommandList(ctx: Context): Promise<void> {
  const chunks = splitForTelegram(buildCommandsHelp().join("\n\n"));
  for (let i = 0; i < chunks.length; i += 1) {
    await ctx.reply(chunks[i] as string, {
      parse_mode: "HTML",
      disable_notification: i > 0,
      ...(i === chunks.length - 1 ? { reply_markup: menuKeyboard("home") } : {}),
    });
  }
}

export function buildMenuSection(section: MenuSection, firstName?: string): string {
  if (section === "build") return buildText();
  if (section === "jobs") return jobsText();
  if (section === "system") return systemText();
  if (section === "wife") return buildWifeCommandsHelp();
  return homeText(firstName);
}

const LABELS: Readonly<Record<MenuSection, string>> = {
  home: "🏠 Back",
  build: "🤖 Build something",
  jobs: "🎯 Jobs",
  system: "⚡ System",
  wife: "👩 Tashi's jobs",
};

/**
 * The buttons under a section.
 *
 * The section you are already reading is never offered again — a button that
 * re-renders the identical message reads as a dead button, and Telegram rejects
 * an edit that changes nothing, so it would also throw. Tashi's commands hang
 * off Jobs: that is where the question "what about hers?" comes up.
 */
export function buildMenuKeyboardRows(active: MenuSection): { text: string; callback_data: string }[][] {
  const button = (s: MenuSection) => ({ text: LABELS[s], callback_data: `${MENU_CALLBACK_PREFIX}${s}` });

  if (active === "home") {
    return [
      [button("build")],
      [button("jobs"), button("system")],
      [{ text: "🧭 Everything I can do", callback_data: CAPABILITIES_CALLBACK }],
      [{ text: "📜 All commands", callback_data: FULL_LIST_CALLBACK }],
    ];
  }
  if (active === "wife") {
    return [[button("jobs")], [button("home")]];
  }
  return [
    ...(active === "jobs" ? [[button("wife")]] : []),
    LANES.filter((s) => s !== active).map(button),
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

  if (data === FULL_LIST_CALLBACK) {
    await ctx.answerCallbackQuery();
    await sendFullCommandList(ctx);
    return true;
  }

  // Not a section: ~85 rows is several messages, so it is sent below, not edited in.
  if (data === CAPABILITIES_CALLBACK) {
    await ctx.answerCallbackQuery();
    await sendCapabilities(ctx, menuKeyboard("home"));
    return true;
  }

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
