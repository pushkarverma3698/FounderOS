/**
 * FounderOS — which Google mailboxes exist
 * ========================================
 * The three built-in accounts (src/core/accounts.ts) plus any the founder added from Telegram
 * with `/login google add <name>`. An added mailbox is nothing but its signed-in credentials file
 * at `~/.founderos/accounts/<name>/gws/credentials.json`: no DB row, no config. Signing it out
 * (`/login google remove <name>`) deletes that folder and the name is gone everywhere.
 *
 * Google-only on purpose: an AccountKey is a business identity across every platform (LinkedIn,
 * GitHub, Meta); a mailbox the founder adds is only Gmail + Calendar.
 */

import { existsSync, readdirSync } from "node:fs";
import { ACCOUNT_KEYS, isAccountKey } from "../core/accounts.js";

export interface MailboxFs {
  home(): string;
  listDirs(path: string): string[];
  exists(path: string): boolean;
}

const realFs: MailboxFs = {
  home: () => process.env["HOME"] ?? "/home/founderos",
  listDirs: (path) => {
    // allow-failopen: no accounts folder yet just means no added mailboxes.
    try {
      return readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  },
  exists: existsSync,
};

const NAME_SHAPE = /^[a-z][a-z0-9-]{1,19}$/;
const RESERVED = new Set(["add", "remove", "all", "default"]);

/** Why a new mailbox name is refused, or undefined when it is fine. */
export function mailboxNameProblem(name: string): string | undefined {
  if (!NAME_SHAPE.test(name)) return "Use 2-20 lowercase letters, digits or dashes, starting with a letter (e.g. wife, oplify).";
  if (RESERVED.has(name)) return `"${name}" is a command word; pick another name.`;
  return undefined;
}

/** Same folder layout as defaultGwsProfileDir, so a built-in account and an added one look alike. */
export function mailboxProfileDir(name: string, fs: MailboxFs = realFs): string {
  return `${fs.home()}/.founderos/accounts/${name}/gws`;
}

/** Built-in accounts first, then added ones (signed in at least once), alphabetical. */
export function listGoogleMailboxes(fs: MailboxFs = realFs): string[] {
  const added = fs
    .listDirs(`${fs.home()}/.founderos/accounts`)
    .filter((n) => !isAccountKey(n) && !mailboxNameProblem(n) && fs.exists(`${mailboxProfileDir(n, fs)}/credentials.json`))
    .sort();
  return [...ACCOUNT_KEYS, ...added];
}

export function isAddedMailbox(name: string, fs: MailboxFs = realFs): boolean {
  return !isAccountKey(name) && listGoogleMailboxes(fs).includes(name);
}

/**
 * The gws folder for a mailbox that is NOT built in. Built-in accounts keep their registry route
 * (DB refs). Unknown name → an error naming the valid ones, never a silent fall-through to another inbox.
 */
export function addedMailboxDir(name: string, fs: MailboxFs = realFs): { dir: string } | { error: string } {
  if (isAddedMailbox(name, fs)) return { dir: mailboxProfileDir(name, fs) };
  return { error: `No Google account named "${name}". Known: ${listGoogleMailboxes(fs).join(", ")}. Add one with /login google add <name>.` };
}
