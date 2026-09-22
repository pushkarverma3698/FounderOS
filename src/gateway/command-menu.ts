/**
 * FounderOS — the one list of commands
 * ====================================
 * Every command the bot answers, in the order it should be read, with the
 * description the founder sees. Three surfaces consume this list and no surface
 * is allowed its own copy:
 *
 *   1. Telegram's native menu   — `setMyCommands` on startup (the ☰ button)
 *   2. `/commands`               — the same list rendered into a chat message
 *   3. `tests/unit/gateway/command-menu.test.ts` — cross-checks it against the
 *      real `bot.command(...)` registrations in telegram.ts
 *
 * WHY IT EXISTS. Discovery was a memory test. The only way to learn a command
 * was `/commands`, which you had to already know about, and the welcome screen
 * spent weeks advertising twelve commands deleted with the v2 orchestration
 * layers — `/target`, `/outbound`, `/workflows` and the rest, every one landing
 * on "unknown command". Telegram has had a native menu for this the whole time
 * and the bot never called it. The founder's question on 2026-08-21 was "how
 * can i get to know all the commands", and the honest answer was: you can't.
 *
 * Two consequences of the native menu shape the entries below.
 * · Descriptions are PLAIN TEXT. The menu does not parse HTML, so `<n>` prints
 *   as those three characters. Placeholders are written as "n" in the menu and
 *   escaped only in the chat rendering.
 * · Order is the read order. Telegram shows the list unsorted, so the jobs loop
 *   goes first — it is the lane used daily, and it sat below an MCP registry
 *   line while `/draft` went un-typed for seven days running.
 */

import { esc } from "../tools/jobhunt/telegram-format.js";

/** One row of Telegram's `setMyCommands` payload. */
export interface MenuCommand {
  /** Lowercase, 1–32 chars of [a-z0-9_] — Telegram rejects the whole call otherwise. */
  readonly command: string;
  /** Plain text, ≤256 chars. No HTML: the native menu does not parse it. */
  readonly description: string;
  /** Heading this command sits under in the chat rendering. */
  readonly group: "jobs" | "engineering" | "system";
}

export const COMMAND_MENU: readonly MenuCommand[] = [
  // ── The daily loop ────────────────────────────────────────────────────────
  //
  // THREE VERBS OVER ONE QUEUE, in the order the founder reads them: what has
  // arrived since he last looked, what employers published today, everything on
  // file. They share one ranking and one set of row numbers, so /draft 3 means
  // the same role after any of them — see BriefRow.rank.
  {
    command: "fresh",
    description: "What has arrived since you last looked. fresh 2d for a window",
    group: "jobs",
  },
  {
    command: "wife_fresh",
    description: "What has arrived in your wife's queue since you last looked",
    group: "jobs",
  },
  {
    command: "today",
    description: "Only roles an employer published in the last 24h",
    group: "jobs",
  },
  {
    command: "wife_today",
    description: "Only roles an employer published in the last 24h, for your wife",
    group: "jobs",
  },
  {
    command: "jobs",
    description: "Everything on file, freshest first. jobs 3d to limit it by age",
    group: "jobs",
  },
  {
    command: "wife_jobs",
    description: "Your wife's whole queue, freshest first. wife_jobs 3d to limit it by age",
    group: "jobs",
  },
  {
    command: "csv",
    description: "Download the apply queue as a spreadsheet. /csv all for everything screened",
    group: "jobs",
  },
  {
    command: "wife_csv",
    description: "Download your wife's apply queue as a spreadsheet. /wife_csv all for everything screened",
    group: "jobs",
  },
  {
    command: "draft",
    // Names all three forms. A bulk command nobody knows about is a bulk
    // command nobody uses, and the whole point of adding it was that 543
    // screened roles had produced two applications one row at a time.
    description: "draft n | draft 1,3,5 | draft all — tailor a CV + cover letter and the apply link",
    group: "jobs",
  },
  {
    command: "wife_draft",
    description: "wife_draft n | wife_draft 1,3,5 | wife_draft all — tailor your wife's CV + cover letter and the apply link",
    group: "jobs",
  },
  {
    command: "ask",
    description: "ask n — write the one question that unblocks row n",
    group: "jobs",
  },
  {
    command: "wife_ask",
    description: "wife_ask n — write the one question that unblocks row n of your wife's queue",
    group: "jobs",
  },
  {
    command: "gaps",
    // Says what to DO with it. /draft can only use words already on the CV, so
    // this list is the only thing that moves the number a recruiter searches on.
    description: "Keywords the market asks for that your CV doesn't say. Add the true ones to your base CV",
    group: "jobs",
  },
  {
    command: "wife_gaps",
    description: "Keywords your wife's market asks for that her CV doesn't say",
    group: "jobs",
  },
  {
    command: "applied",
    description: "applied n — mark row n applied and drop it off the queue",
    group: "jobs",
  },
  {
    command: "wife_applied",
    description: "wife_applied n — mark row n of your wife's queue applied and drop it off",
    group: "jobs",
  },
  {
    command: "replied",
    description: "replied n — mark row n of your live applications as replied to",
    group: "jobs",
  },
  {
    command: "wife_replied",
    description: "wife_replied n — mark row n of your wife's live applications as replied to",
    group: "jobs",
  },
  {
    command: "rejected",
    description: "rejected n — mark row n of your live applications as rejected",
    group: "jobs",
  },
  {
    command: "wife_rejected",
    description: "wife_rejected n — mark row n of your wife's live applications as rejected",
    group: "jobs",
  },
  {
    // In the jobs group, not system: it is the thing that decides what lands in
    // an employer's form, and it belongs beside the commands that open one.
    command: "profile",
    // No angle brackets: this string is sent to Telegram's setMyCommands, which
    // takes plain text and does not parse HTML (see command-menu.test.ts).
    description: "What every application form gets filled from. profile set phone +31… changes one field",
    group: "jobs",
  },
  {
    command: "wife_profile",
    description: "What your wife's application forms get filled from. wife_profile set phone +31… changes one field",
    group: "jobs",
  },
  // ── Engineering ───────────────────────────────────────────────────────────
  //
  // Its own group, not a corner of "System". These three are the whole loop —
  // start work, watch work, start a place to put work — and they sat below
  // /connect in a list headed by uptime and spend, which is where a founder
  // stops reading. The order is the order they are used in.
  {
    command: "task",
    // Names the repo selector in the description itself: the hint is the one
    // thing /task cannot guess and the one thing nobody would think to type.
    description:
      "Build something. task repo:app fix the flaky CSV export. Repos: app, api, hulda, founderos",
    group: "engineering",
  },
  {
    command: "tasks",
    description: "What the agent loop is doing right now — queued, building, in review, blocked",
    group: "engineering",
  },
  {
    command: "newproject",
    description: "Start a new project: creates a private repo the agent loop can work in. newproject name what it is",
    group: "engineering",
  },
  // ── System ────────────────────────────────────────────────────────────────
  { command: "status", description: "System health and pending approvals", group: "system" },
  { command: "budget", description: "Today's spend against the daily cap", group: "system" },
  { command: "commands", description: "Show every command with what it does", group: "system" },
  { command: "connect", description: "Search and add an MCP server from the registry", group: "system" },
  { command: "start", description: "What this bot can do", group: "system" },
  { command: "reset", description: "Clear this thread's mission state", group: "system" },
  { command: "halt", description: "Emergency stop — refuse all new work", group: "system" },
  { command: "resume", description: "Lift a halt and accept work again", group: "system" },
];

/** The payload Telegram wants: command + description, nothing else. */
export function telegramCommandPayload(): { command: string; description: string }[] {
  return COMMAND_MENU.map(({ command, description }) => ({ command, description }));
}

/**
 * The `/commands` message sequence — ONE message per section, in send order.
 *
 * Rendered from the same array so the chat text cannot drift from the menu.
 * Descriptions are escaped on the way in — they are plain text by contract, and
 * an unescaped "&" or "<" here would cost the whole message (see
 * `escapeStrayAngles`). Placeholders are re-rendered as "&lt;n&gt;" so they read
 * as placeholders rather than as literal argument names.
 *
 * Sections, not commands. One message per command reads well in a mockup and
 * badly in a chat: it was 19 messages for 2,258 characters, four of them under
 * 60, two of them a bare section heading. `handleCommands` awaits them in a
 * tight loop and this bot registers no throttler or auto-retry, so a burst that
 * size is also the shape Telegram answers with 429 — a help command that
 * half-sends and then throws. Four messages keep the per-command formatting and
 * stay far inside TELEGRAM_MAX_CHARS (largest section ≈ 1.6k of 4,096); the
 * command-menu test asserts that bound rather than trusting this sentence.
 */
export function buildCommandsHelp(): string[] {
  const formatDetail = (entry: MenuCommand): string =>
    esc(entry.description).replace(new RegExp(`^${entry.command} n —`), "&lt;n&gt; —");

  const jobs = COMMAND_MENU.filter((e) => e.group === "jobs");
  const engineering = COMMAND_MENU.filter((e) => e.group === "engineering");
  const system = COMMAND_MENU.filter((e) => e.group === "system");

  // His command and its wife_ counterpart belong in one block — they are the
  // same action against two candidates, and separating them is what made the
  // paired list unreadable in the first place.
  const jobLines = jobs
    .filter((e) => !e.command.startsWith("wife_"))
    .map((entry) => {
      const partner = jobs.find((e) => e.command === `wife_${entry.command}`);
      const own = `🔹 <b>/${entry.command}</b>\n<i>${formatDetail(entry)}</i>`;
      return partner ? `${own}\n🔸 <b>/${partner.command}</b>\n<i>${formatDetail(partner)}</i>` : own;
    });

  // Any wife_ command whose base is missing would otherwise vanish silently.
  const orphans = jobs
    .filter((e) => e.command.startsWith("wife_") && !jobs.some((b) => `wife_${b.command}` === e.command))
    .map((entry) => `🔸 <b>/${entry.command}</b>\n<i>${formatDetail(entry)}</i>`);

  // The engineering block explains the LOOP, not just its three commands. The
  // founder's question was never "which letters do I type" — it was "what
  // happens after I type them, and how will I know". A list of three verbs
  // answers neither, and the loop's six stages are invisible by construction:
  // they run on a VPS over half an hour while he is elsewhere.
  const engineeringBlock = [
    "<b>Engineering — build things while you are away</b>",
    ...engineering.map((e) => `🤖 <b>/${e.command}</b>\n<i>${formatDetail(e)}</i>`),
    "<b>What happens after you send /task</b>\n" +
      "1️⃣ I expand your line into a full brief and show you an approval card\n" +
      "2️⃣ You approve → it is filed as a GitHub issue\n" +
      "3️⃣ Antigravity writes the code and opens a pull request\n" +
      "4️⃣ The app is started and photographed — you get the screenshots here\n" +
      "5️⃣ Claude reviews it adversarially and re-dispatches anything it finds\n" +
      "6️⃣ You get a verdict: CLEARED, or changes requested with the reason\n\n" +
      "<i>Typical: 20–40 minutes, unattended. " +
      "On the Oplify repos the final merge is always left to you.</i>",
    "<b>Naming the repo</b>\n" +
      "<code>repo:app</code> · <code>repo:api</code> · <code>repo:hulda</code> — " +
      "leave it off and it means FounderOS.\n" +
      "<i>Anything else is refused before a single token is spent.</i>",
  ];

  const parts: string[] = [
    ["<b>Jobs — the daily loop</b>", ...jobLines, ...orphans].join("\n\n"),
    engineeringBlock.join("\n\n"),
    ["<b>System</b>", ...system.map((e) => `⚙️ <b>/${e.command}</b>\n<i>${formatDetail(e)}</i>`)].join("\n\n"),
    "💡 All of these are in the ☰ menu button next to the message box, so you never have to remember them.\n\n" +
      "<b>Plain English works too, and hits the same code.</b>\n" +
      "<i>“tashi's jobs” · “what did we find in the last 2 days” · “roles posted this week” · " +
      "“tashi's last 2 days jobs founded”</i>\n\n" +
      "<b>posted</b> is when the employer published it. <b>found</b> is when we first saw it. " +
      "They differ when a new job board is added, and every row prints both.",
  ];

  return parts;
}
