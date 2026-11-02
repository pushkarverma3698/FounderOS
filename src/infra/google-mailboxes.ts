/**
 * FounderOS — which Google mailboxes exist
 * ========================================
 * The one built-in account (`personal`, src/core/accounts.ts) plus any the founder added from Telegram
 * with `/login google add <name>`. An added mailbox is nothing but its signed-in credentials file
 * at `~/.founderos/accounts/<name>/gws/credentials.json`: no DB row, no config. Signing it out
 * (`/login google remove <name>`) deletes that folder and the name is gone everywhere.
 *
 * Google-only on purpose: an AccountKey is a business identity across every platform (LinkedIn,
 * GitHub, Meta); a mailbox the founder adds is only Gmail + Calendar.
 */

import { existsSync, readdirSync } from "node:fs";
import { GOOGLE_BUILTIN_ACCOUNT, isBuiltinGoogleAccount } from "../core/accounts.js";

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

/** The built-in account first, then added ones (turicks and naggar count as added once signed in), alphabetical. */
export function listGoogleMailboxes(fs: MailboxFs = realFs): string[] {
  const added = fs
    .listDirs(`${fs.home()}/.founderos/accounts`)
    .filter((n) => !isBuiltinGoogleAccount(n) && !mailboxNameProblem(n) && fs.exists(`${mailboxProfileDir(n, fs)}/credentials.json`))
    .sort();
  return [GOOGLE_BUILTIN_ACCOUNT, ...added];
}

export function isAddedMailbox(name: string, fs: MailboxFs = realFs): boolean {
  return !isBuiltinGoogleAccount(name) && listGoogleMailboxes(fs).includes(name);
}

/**
 * The gws folder for a mailbox that is NOT built in. Built-in accounts keep their registry route
 * (DB refs). Unknown name → an error naming the valid ones, never a silent fall-through to another inbox.
 */
export function addedMailboxDir(name: string, fs: MailboxFs = realFs): { dir: string } | { error: string } {
  if (isAddedMailbox(name, fs)) return { dir: mailboxProfileDir(name, fs) };
  return { error: `No Google account named "${name}". Known: ${listGoogleMailboxes(fs).join(", ")}. Add one with /login google add <name>.` };
}

/** A word that says "this mailbox" when it follows a mailbox name: "work inbox", "personal email". */
const MAIL_WORD = "(?:inbox|mailbox|mails?|e-?mails?|gmail|account)";

/**
 * The one mailbox the founder's message names next to a mail word ("my work inbox" → "work"), or
 * undefined when it names none or two different ones. read_emails puts this above the model's
 * account argument: on 2026-10-08 "my work inbox" was read from turicks because the model chose.
 */
export function mailboxNamedIn(text: string, mailboxes: readonly string[]): string | undefined {
  const named = new Set(
    mailboxes.filter((name) => new RegExp(`(?<![\\w-])${name}\\s+${MAIL_WORD}\\b`, "i").test(text)),
  );
  return named.size === 1 ? [...named][0] : undefined;
}
