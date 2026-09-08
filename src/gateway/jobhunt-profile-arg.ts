/**
 * FounderOS — the profile selector on a job command
 * =================================================
 * `/jobs`, `/csv`, `/draft`, `/applied` and `/ask` all address ONE candidate's
 * queue. With a second profile registered they need to say which, and the
 * founder types those commands on a phone — so the selector is a bare leading
 * word (`/jobs wife`), never a flag.
 *
 * WHY A DEFAULT AND NOT A PROMPT. An unqualified `/jobs` resolves to the default
 * profile rather than asking. It is what he has typed for months, it is his own
 * queue, and a command that starts answering with a question is a command that
 * costs a round trip every single time to serve the common case.
 *
 * WHY THE MISS IS LOUD. An unrecognised word is REFUSED, never silently treated
 * as "no profile given". `/draft wfie 3` must not quietly draft Pushkar's row 3:
 * the cost of guessing wrong here is a tailored application sent to the wrong
 * company about the wrong person.
 */

import type { Context } from "grammy";
import {
  getProfile,
  listProfiles,
  resolveProfileToken,
  DEFAULT_PROFILE_ID,
  type JobSearchProfile,
} from "../tools/jobhunt/profile-config.js";

// One wording for the refusal, shared with the English surface. See brief-resolver.ts.
export { profileMissMessage } from "../tools/jobhunt/brief-resolver.js";

export interface ProfileArg {
  readonly profile: JobSearchProfile;
  /** The argument string with the profile token removed, for the caller's own parser. */
  readonly rest: string;
  /** True when the founder actually named a profile, rather than falling back. */
  readonly explicit: boolean;
}

export interface ProfileArgMiss {
  readonly unknown: string;
  readonly known: readonly string[];
}

/**
 * The alias table lives in `profile-config.ts` (`resolveProfileToken`), not here.
 *
 * It was a byte-identical private copy in this file until 2026-09-08 — the id,
 * each dash-separated segment of it, and the candidate's first name, derived
 * from the registry both times. Two copies of "which word means which
 * candidate" is precisely the drift B1 exists to remove: the slash surface
 * cannot resolve "tashi" differently from the English surface if there is only
 * one function that resolves it.
 */
/**
 * Split a leading profile token off a command argument.
 *
 * Returns a `ProfileArgMiss` when the first word looks like a profile selector
 * and is not one. "Looks like" means: not a number and not one of the caller's
 * own keywords — so `/csv all` and `/draft 3` still reach their own parsers
 * untouched, and only a genuinely unrecognised word is refused.
 */
export function resolveProfileArg(
  raw: string,
  reservedWords: readonly string[] = [],
  restLooksValid?: (rest: string) => boolean,
): ProfileArg | ProfileArgMiss {
  const trimmed = raw.trim();
  const fallback: ProfileArg = { profile: getProfile(DEFAULT_PROFILE_ID), rest: trimmed, explicit: false };
  if (trimmed.length === 0) return fallback;

  const [head, ...tail] = trimmed.split(/\s+/);
  const token = (head ?? "").toLowerCase();
  const rest = tail.join(" ");

  // The caller's own vocabulary wins. `/csv all` means the log tab, not a
  // profile called "all", and a number is always a row.
  if (reservedWords.includes(token)) return fallback;
  if (/^[\d,\s-]+$/.test(token)) return fallback;

  const resolved = resolveProfileToken(token);
  if (resolved) return { profile: getProfile(resolved), rest, explicit: true };

  // Only one profile registered: nothing here can be a selector, so leave the
  // word alone rather than refusing a command that was never ambiguous.
  if (listProfiles().length < 2) return fallback;

  // An unknown first word is only a MISSED SELECTOR when what follows it is a
  // usable argument — `/draft wfie 3` is a typo one character away from drafting
  // the wrong person's row 3, and that is what must be refused. `/draft the
  // first one` is not a profile mistake at all; handing it back unchanged lets
  // the caller answer with its own Usage line, which is the more useful reply.
  if (restLooksValid && !restLooksValid(rest)) return fallback;

  return { unknown: token, known: listProfiles().map((p) => p.id) };
}

export function isProfileArgMiss(value: ProfileArg | ProfileArgMiss): value is ProfileArgMiss {
  return "unknown" in value;
}

/**
 * Force a profile token onto `ctx.match` before delegating to a command's
 * normal handler — what `/wife_jobs` runs, so it behaves exactly like
 * `/jobs wife` instead of a second, parallel parser that could drift from it.
 *
 * `ctx.match` is a plain writable string on grammy's Context — the same
 * property its own `bot.command()` middleware sets — so overwriting it in
 * place, rather than cloning ctx, leaves every other binding (ctx.reply,
 * ctx.chat, …) untouched.
 */
export function withForcedProfileToken(ctx: Context, token: string): Context {
  const rest = ctx.match?.toString() ?? "";
  ctx.match = rest.length > 0 ? `${token} ${rest}` : token;
  return ctx;
}
