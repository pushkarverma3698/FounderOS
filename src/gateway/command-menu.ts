/**
 * FounderOS — the one list of commands
 * ====================================
 * Every command the bot answers, in the order it should be read, with the
 * description the founder sees. Four surfaces consume this list and no surface
 * is allowed its own copy:
 *
 *   1. Telegram's native menu   — `setMyCommands` on startup (the ☰ button),
 *      without the `hidden` aliases
 *   2. `/commands`               — the same list rendered into a chat message
 *   3. `/wife_commands`          — the hidden aliases (wife-commands.ts)
 *   4. `tests/unit/jobs/jobs-bot.test.ts` — cross-checks it against the
 *      real `bot.command(...)` registrations in src/jobs/bot.ts
 *
 * Since 2026-10-10 the bot is the standalone jobs bot: the engineering and
 * system rows (/task, /halt, /ask, …) left with the kernel.
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
  readonly group: "jobs" | "system";
  /**
   * Registered and working, but kept out of the ☰ menu: the `wife_` aliases.
   * `/wife_commands` and `/commands` still list every one (wife-commands.ts).
   */
  readonly hidden?: true;
  /** A usage line for a hidden alias, shown by /wife_commands. */
  readonly example?: string;
}

export const COMMAND_MENU: readonly MenuCommand[] = [
  // ── The daily loop ────────────────────────────────────────────────────────
  //
  // THREE VERBS OVER ONE QUEUE, in the order the founder reads them: what has
  // arrived since he last looked, what employers published today, everything on
  // file. They share one ranking and one set of row numbers, so /draft 3 means
  // the same role after any of them — see BriefRow.rank.
  //
  // ONE COMMAND SET (2026-09-28). Every job command takes a profile word —
  // `/jobs tashi`, `/draft tashi 3` (jobhunt-profile-arg.ts) — so each row says
  // so, and the `wife_` twins are `hidden`: still registered (he has typed them
  // for months), still listed by /wife_commands and /commands, out of the ☰ menu.
  {
    command: "fresh",
    description: "What has arrived since you last looked. fresh 2d for a window, fresh tashi for Tashi's",
    group: "jobs",
  },
  {
    command: "wife_fresh",
    description: "What has arrived in your wife's queue since you last looked",
    group: "jobs",
    hidden: true,
    example: "/wife_fresh 2d",
  },
  {
    command: "today",
    description: "Only roles an employer published in the last 24h. today tashi for Tashi's",
    group: "jobs",
  },
  {
    command: "wife_today",
    description: "Only roles an employer published in the last 24h, for your wife",
    group: "jobs",
    hidden: true,
    example: "/wife_today",
  },
  {
    command: "jobs",
    description: "Everything on file, freshest first. jobs 3d to limit it by age, jobs tashi for Tashi's",
    group: "jobs",
  },
  {
    command: "wife_jobs",
    description: "Your wife's whole queue, freshest first. wife_jobs 3d to limit it by age",
    group: "jobs",
    hidden: true,
    example: "/wife_jobs 3d",
  },
  {
    command: "csv",
    description: "Download the apply queue as a spreadsheet. /csv all for everything screened, /csv tashi for Tashi's",
    group: "jobs",
  },
  {
    command: "wife_csv",
    description: "Download your wife's apply queue as a spreadsheet. /wife_csv all for everything screened",
    group: "jobs",
    hidden: true,
    example: "/wife_csv all",
  },
  {
    command: "draft",
    // Names all three forms. A bulk command nobody knows about is a bulk
    // command nobody uses, and the whole point of adding it was that 543
    // screened roles had produced two applications one row at a time.
    description: "draft n | draft 1,3,5 | draft all — tailor a CV + cover letter and the apply link. draft tashi n for Tashi's",
    group: "jobs",
  },
  {
    command: "wife_draft",
    description: "wife_draft n | wife_draft 1,3,5 | wife_draft all — tailor your wife's CV + cover letter and the apply link",
    group: "jobs",
    hidden: true,
    example: "/wife_draft 1",
  },
  {
    command: "gaps",
    // Says what to DO with it. /draft can only use words already on the CV, so
    // this list is the only thing that moves the number a recruiter searches on.
    description: "Keywords the market asks for that your CV doesn't say. Add the true ones to your base CV. gaps tashi for Tashi's",
    group: "jobs",
  },
  {
    command: "wife_gaps",
    description: "Keywords your wife's market asks for that her CV doesn't say",
    group: "jobs",
    hidden: true,
    example: "/wife_gaps",
  },
  {
    command: "applied",
    description: "applied n — mark row n applied and drop it off the queue. applied tashi n for Tashi's",
    group: "jobs",
  },
  {
    command: "wife_applied",
    description: "wife_applied n — mark row n of your wife's queue applied and drop it off",
    group: "jobs",
    hidden: true,
    example: "/wife_applied 1",
  },
  {
    command: "replied",
    description: "replied n — mark row n of your live applications as replied to. replied tashi n for Tashi's",
    group: "jobs",
  },
  {
    command: "wife_replied",
    description: "wife_replied n — mark row n of your wife's live applications as replied to",
    group: "jobs",
    hidden: true,
    example: "/wife_replied 1",
  },
  {
    command: "rejected",
    description: "rejected n — mark row n of your live applications as rejected. rejected tashi n for Tashi's",
    group: "jobs",
  },
  {
    command: "wife_rejected",
    description: "wife_rejected n — mark row n of your wife's live applications as rejected",
    group: "jobs",
    hidden: true,
    example: "/wife_rejected 1",
  },
  {
    // In the jobs group, not system: it is the thing that decides what lands in
    // an employer's form, and it belongs beside the commands that open one.
    command: "profile",
    // No angle brackets: this string is sent to Telegram's setMyCommands, which
    // takes plain text and does not parse HTML (see command-menu.test.ts).
    description: "What every application form gets filled from. profile set phone +31… changes one field, profile tashi for Tashi's",
    group: "jobs",
  },
  {
    command: "wife_profile",
    description: "What your wife's application forms get filled from. wife_profile set phone +31… changes one field",
    group: "jobs",
    hidden: true,
    example: "/wife_profile",
  },
  {
    // VISIBLE, unlike the aliases it lists: one row in the menu instead of
    // eleven, and nothing Tashi's queue can do goes missing (the founder's
    // condition for hiding them, 2026-09-28).
    command: "wife_commands",
    description: "Every command for Tashi's queue, with an example each. Or add tashi to any job command",
    group: "jobs",
  },
  // ── System ────────────────────────────────────────────────────────────────
  { command: "commands", description: "Every command on one screen", group: "system" },
  { command: "start", description: "What this bot can do", group: "system" },
];

/**
 * The payload Telegram wants: command + description, nothing else.
 *
 * `hidden` rows stay out. On 2026-09-23 the menu was a flat scroll of 33 rows
 * (34 by 09-28) and eleven of the first twenty-two were near-identical `wife_`
 * twins; the engineering loop sat at number 23 and the founder's verdict was "I
 * am unable to see the improved UI or UX". Sorting the twins last was the first
 * fix. Every job command takes a profile word, so the twins now leave the menu
 * altogether: 24 rows, and /wife_commands is the one that lists hers.
 *
 * Read order is COMMAND_MENU's, which is the property `command-menu.test.ts` pins.
 */
export function telegramCommandPayload(): { command: string; description: string }[] {
  return COMMAND_MENU.filter((entry) => !entry.hidden).map(({ command, description }) => ({ command, description }));
}

/**
 * A description for chat, escaped, with a leading "cmd n —" shown as "<n> —".
 * Shared by /commands and /wife_commands so the two cannot render one row differently.
 */
export function formatCommandDetail(entry: MenuCommand): string {
  return esc(entry.description).replace(new RegExp(`^${entry.command} n —`), "&lt;n&gt; —");
}

/**
 * The `/commands` (and `/start`) message sequence, one message per section, rendered
 * from COMMAND_MENU so the chat text cannot drift from the ☰ menu. Descriptions are
 * plain text by contract and escaped on the way in; "cmd n —" reads as "<n> —".
 */
export function buildCommandsHelp(): string[] {
  const jobs = COMMAND_MENU.filter((e) => e.group === "jobs");
  const system = COMMAND_MENU.filter((e) => e.group === "system");

  // His command and its wife_ twin sit in one block: the same action against two
  // candidates. Paired by the `hidden` flag, since /wife_commands is visible on its own.
  const jobLines = jobs
    .filter((e) => !e.hidden)
    .map((entry) => {
      const partner = jobs.find((e) => e.hidden && e.command === `wife_${entry.command}`);
      const own = `🔹 <b>/${entry.command}</b>\n<i>${formatCommandDetail(entry)}</i>`;
      return partner ? `${own}\n🔸 <b>/${partner.command}</b>\n<i>${formatCommandDetail(partner)}</i>` : own;
    });

  // Any hidden alias whose base is missing would otherwise vanish silently.
  const orphans = jobs
    .filter((e) => e.hidden && !jobs.some((b) => !b.hidden && `wife_${b.command}` === e.command))
    .map((entry) => `🔸 <b>/${entry.command}</b>\n<i>${formatCommandDetail(entry)}</i>`);

  return [
    [
      "<b>Jobs — the daily loop</b>\n<i>🔸 = Tashi's version. Out of the ☰ menu, every one still works; " +
        "/wife_commands lists them, or add tashi to any command.</i>",
      ...jobLines,
      ...orphans,
    ].join("\n\n"),
    [
      ...system.map((e) => `⚙️ <b>/${e.command}</b>\n<i>${formatCommandDetail(e)}</i>`),
      "💡 All of these are in the ☰ menu button next to the message box. This bot answers commands only.\n\n" +
        "<b>posted</b> is when the employer published it. <b>found</b> is when we first saw it. " +
        "They differ when a new job board is added, and every row prints both.",
    ].join("\n\n"),
  ];
}
