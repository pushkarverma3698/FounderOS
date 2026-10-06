/**
 * FounderOS — does this planned command wait for a tap?
 * ======================================================
 * The gateway asks "Run this?" before a mutating command (or a read-only command given
 * write arguments). The planner writes the history reply before the gateway decides, so it
 * needs the same answer: a command only offered must not be recorded as run.
 * The data comes in through the catalog (gateway → kernel direction); a parity test pins
 * this function to the gateway's `needsConfirmation`.
 */

import type { CommandCatalogEntry } from "./planner.js";

export function commandNeedsTap(entry: Pick<CommandCatalogEntry, "mutating" | "writesWithArgs">, args: string): boolean {
  return entry.mutating || (entry.writesWithArgs && args.trim() !== "");
}

/** History line for a planned command: "Offered" until the founder taps, "Ran" when it runs at once. */
export function commandHistoryReply(name: string, args: string, needsTap: boolean): string {
  const text = `/${name}${args ? ` ${args}` : ""}`;
  return needsTap ? `Offered ${text}: not run until the founder taps ✅ Run` : `Ran ${text}`;
}

/** A command missing from the catalog is treated as needing a tap: the loud direction, same as the gateway's default. */
export function needsTapFor(commands: readonly CommandCatalogEntry[], command: { name: string; args: string }): boolean {
  const entry = commands.find((c) => c.name === command.name);
  return entry ? commandNeedsTap(entry, command.args) : true;
}
