/**
 * FounderOS — which slash commands plain words may reach
 * =======================================================
 * The planner is told about the founder's commands so "where are we on oplify" runs
 * `/where oplify` — the tested path — instead of an LLM paraphrase of it. The list is
 * DERIVED from COMMAND_MENU (no second copy to drift) minus the commands plain words
 * must never trigger, and this file adds the one fact the menu does not carry: which
 * commands only read.
 *
 * Direction of the default: a command not named in READ_ONLY asks for a tap before it
 * runs. Forgetting to list a new command costs one extra tap, never an unconfirmed write.
 */

import type { CommandCatalogEntry } from "../kernel/index.js";
import { COMMAND_MENU } from "./command-menu.js";

/** Typed-only: /reset wipes the thread, /start is the welcome screen. Plain words never reach them. */
export const NEVER_FROM_PLAIN_WORDS: ReadonlySet<string> = new Set(["reset", "start"]);

/** Commands that only read: they run the moment the planner picks them. */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "where", "tasks", "jobs", "today", "fresh", "csv", "gaps", "status", "budget", "goals", "commands",
  "focus", "projects", "profile", "review", "now",
  "remind", // pings the founder only (set_reminder has no HITL gate), so a "Run this?" card adds a tap and no safety
  "promote", // reads, then posts its own Promote/Cancel card: that tap is the approval, so no second "Run this?"
]);

/** Read-only with no argument, a write with one: `/focus` shows it, `/focus close the pilot` replaces it. */
const WRITES_WITH_ARGS: ReadonlySet<string> = new Set(["focus", "projects", "profile", "review"]);

/** True when running this command (with these args) changes something, so it needs a tap. */
export function needsConfirmation(name: string, args: string): boolean {
  if (!READ_ONLY_COMMANDS.has(name)) return true;
  return WRITES_WITH_ARGS.has(name) && args.trim() !== "";
}

/** What the planner is told it may route to. */
export function plannableCommands(): CommandCatalogEntry[] {
  // wife_* twins are the same commands with a profile word forced on; "jobs tashi" already reaches them.
  return COMMAND_MENU.filter((e) => !e.hidden && !e.command.startsWith("wife_") && !NEVER_FROM_PLAIN_WORDS.has(e.command)).map((e) => ({
    name: e.command,
    description: e.description,
    mutating: !READ_ONLY_COMMANDS.has(e.command),
    writesWithArgs: WRITES_WITH_ARGS.has(e.command),
  }));
}
