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
  readonly group: "jobs" | "system";
}

export const COMMAND_MENU: readonly MenuCommand[] = [
  // ── The daily loop ────────────────────────────────────────────────────────
  {
    command: "jobs",
    description: "Rank the queue now and show the shortlist",
    group: "jobs",
  },
  {
    command: "csv",
    description: "Download the apply queue as a spreadsheet. /csv all for everything screened",
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
    command: "ask",
    description: "ask n — write the one question that unblocks row n",
    group: "jobs",
  },
  {
    command: "applied",
    description: "applied n — mark row n applied and drop it off the queue",
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
 * The `/commands` message.
 *
 * Rendered from the same array so the chat text cannot drift from the menu.
 * Descriptions are escaped on the way in — they are plain text by contract, and
 * an unescaped "&" or "<" here would cost the whole message (see
 * `escapeStrayAngles`). Placeholders are re-rendered as "&lt;n&gt;" so they read
 * as placeholders rather than as literal argument names.
 */
export function buildCommandsHelp(): string {
  const render = (group: MenuCommand["group"]): string[] =>
    COMMAND_MENU.filter((entry) => entry.group === group).map((entry) => {
      const detail = esc(entry.description).replace(
        new RegExp(`^${entry.command} n —`),
        "&lt;n&gt; —",
      );
      return `/${entry.command} ${detail.startsWith("&lt;n&gt;") ? detail : `— ${detail}`}`;
    });

  return [
    "<b>Jobs — the daily loop</b>",
    ...render("jobs"),
    "",
    "<b>System</b>",
    ...render("system"),
    "",
    "All of these are in the ☰ menu button next to the message box, so you never have to remember them.",
    "Everything else is natural language — the planner routes it.",
  ].join("\n");
}
