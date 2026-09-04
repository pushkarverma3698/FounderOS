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

import { getProfile, listProfiles, DEFAULT_PROFILE_ID, type JobSearchProfile } from "../tools/jobhunt/profile-config.js";

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
 * Every word that selects a profile, lowercased.
 *
 * Derived from the registry rather than written out: the id (`wife-nl-finance`),
 * each dash-separated segment of it (`wife`, `finance`), and the candidate's
 * first name. A hand-maintained alias table would drift the moment a third
 * profile is added, and the failure would be a command that silently addresses
 * the wrong queue.
 */
function aliasesFor(profile: JobSearchProfile): string[] {
  const first = profile.candidateName.trim().split(/\s+/)[0] ?? "";
  return [profile.id, ...profile.id.split("-"), first]
    .map((a) => a.toLowerCase())
    .filter((a) => a.length > 1);
}

/** Aliases claimed by more than one profile select nothing — ambiguity is a miss. */
function aliasIndex(): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const profile of listProfiles()) {
    for (const alias of aliasesFor(profile)) {
      index.set(alias, index.has(alias) && index.get(alias) !== profile.id ? null : profile.id);
    }
  }
  return index;
}

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

  const resolved = aliasIndex().get(token);
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

/** What the founder is told when the selector did not resolve. */
export function profileMissMessage(miss: ProfileArgMiss): string {
  return (
    `I don't know whose queue "${miss.unknown}" is, so I haven't touched either one. ` +
    `Name one of: ${miss.known.join(", ")} — or leave it off for ${DEFAULT_PROFILE_ID}.`
  );
}
