/**
 * FounderOS — one parser behind /jobs, /today, /fresh and their English
 * =====================================================================
 * THE PROBLEM THIS SOLVES. There are now three verbs × two candidates × two
 * date axes, reachable both as slash commands and as typed English. Written
 * twice — once in a `bot.command` handler and once in a tool's argument
 * schema — the two surfaces drift, and the drift is invisible: `/jobs wife 2d`
 * and "tashi's jobs from the last 2 days" both return a plausible list, and
 * nothing tells the founder that one of them is wrong.
 *
 * So both reduce to a `BriefRequest` HERE, before anything reads the database.
 * The slash handlers pass `ctx.match`; the `job_brief` tool passes whatever the
 * planner extracted. Same function, same defaults, same refusals.
 *
 * IT LIVES IN tools/, NOT gateway/. `verify-architecture.ts` R1 forbids anything
 * outside src/gateway from importing it, and the NL path runs inside a tool — so
 * a resolver in the gateway could only ever serve half the surface, which is the
 * drift this file exists to prevent.
 *
 * TWO AXES, KEPT APART. `posted` is when the employer published; `found` is when
 * we first stored it. They agree on an ordinary day (median discovery lag is
 * twelve minutes) and diverge exactly when a board is added to the registry —
 * which is when the founder most needs to know which question he asked. His own
 * phrasing carries it: "last 2 days jobs FOUNDED" is about our discovery.
 */

import { resolveProfileToken, listProfiles, DEFAULT_PROFILE_ID } from "./profile-config.js";

export type BriefVerb = "jobs" | "today" | "fresh";

/** Which date column a window is measured against. */
export type BriefAxis = "posted" | "found";

/** `/today`'s window IS its identity, so a range argument cannot move it. */
export const TODAY_WINDOW_HOURS = 24;

export interface BriefRequest {
  readonly verb: BriefVerb;
  readonly profileId: string;
  /** True when the founder actually named a candidate rather than falling back. */
  readonly explicitProfile: boolean;
  /**
   * Hours back from now, or null for the verb's own default —
   * `jobs`: no age limit · `fresh`: since you last looked.
   */
  readonly windowHours: number | null;
  readonly axis: BriefAxis;
}

export interface ProfileMiss {
  readonly unknown: string;
  readonly known: readonly string[];
}

export type BriefRequestResult = BriefRequest | ProfileMiss;

export function isProfileMiss(value: BriefRequestResult): value is ProfileMiss {
  return "unknown" in value;
}

/**
 * Filler a sentence carries and an argument never means, and the verb words
 * themselves — so "tashi's jobs founded" does not read "jobs" as a range.
 *
 * TWO CONSTANTS PER PATTERN, ONE GLOBAL AND ONE NOT, DELIBERATELY. A `/g` regex
 * carries `lastIndex` across calls, so `RE.test(a)` followed by `RE.test(b)`
 * resumes mid-string and returns false for a string that plainly matches. Used
 * for `.replace` it is required; used for `.test` it is a bug that fires on
 * every second call — which here would mean `/jobs wife 2d` intermittently
 * refusing a profile it had just accepted.
 */
const FILLER_WORDS = "last|past|the|in|for|from|of|me|my|show|give|list|please|s";
const VERB_WORDS = "jobs?|today|fresh|brief|roles?|postings?";
const FILLER_ALL = new RegExp(`\\b(?:${FILLER_WORDS})\\b`, "g");
const IS_FILLER = new RegExp(`^(?:${FILLER_WORDS})$`);
const IS_VERB_WORD = new RegExp(`^(?:${VERB_WORDS})$`);

const HOURS_PER = { h: 1, d: 24, w: 168, m: 720 } as const;

/**
 * Read a window out of free text, in hours.
 *
 * Returns null on anything it does not positively recognise. A misread window
 * silently changes which roles the founder sees, and "recently" has no defensible
 * number behind it — null lets the verb's own default apply, and the default is
 * printed on screen where he can see it was used.
 */
export function parseWindowHours(text: string): number | null {
  const cleaned = text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(FILLER_ALL, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;

  // "today" and a bare "week"/"month" carry an implied 1.
  if (/\btoday\b/.test(cleaned)) return TODAY_WINDOW_HOURS;
  if (/\byesterday\b/.test(cleaned)) return 48;
  if (/\bthis week\b|^week$|\bweek\b(?!\s*\d)/.test(cleaned) && !/\d/.test(cleaned)) {
    return HOURS_PER.w;
  }
  if (/\bmonth\b/.test(cleaned) && !/\d/.test(cleaned)) return HOURS_PER.m;

  const match = /(\d+)\s*(hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mos?)\b/.exec(cleaned);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = (match[2] ?? "")[0] as keyof typeof HOURS_PER;
  const per = HOURS_PER[unit];
  return per === undefined || n <= 0 ? null : n * per;
}

/**
 * Read the axis out of the founder's own word, or null when he did not say one.
 *
 * Null, not a default, because the DEFAULT belongs to the verb: `/fresh` is
 * about discovery and `/today` is about publication, and neither should have to
 * restate that in every sentence.
 */
export function parseAxis(text: string): BriefAxis | null {
  const lower = text.toLowerCase();
  if (/\b(?:found|founded|finding|discovered|added|new to us)\b/.test(lower)) return "found";
  if (/\b(?:posted|published|listed|advertised)\b/.test(lower)) return "posted";
  return null;
}

/** Each verb's window when the founder named none. */
function defaultWindowHours(verb: BriefVerb): number | null {
  // `today` is fixed: the window is what the word means.
  // `jobs` is null = no age limit (founder direction 2026-09-08, revising 24h).
  // `fresh` is null = a delta against the last time he looked, not a range.
  return verb === "today" ? TODAY_WINDOW_HOURS : null;
}

/** Each verb's axis when the founder named none. */
function defaultAxis(verb: BriefVerb): BriefAxis {
  return verb === "fresh" ? "found" : "posted";
}

/**
 * Split a leading profile word off, refusing a near-miss rather than guessing.
 *
 * The refusal is the point: `/draft wfie 3` is one keystroke from tailoring an
 * application about the wrong person, so an unrecognised FIRST word followed by
 * a usable argument is an error, never a silent fallback. A word inside a
 * sentence is different — "show me the jobs" contains no candidate and is not a
 * typo — so a miss is only raised when the token leads and the rest parses.
 */
function splitProfile(raw: string): { profileId: string; explicit: boolean } | ProfileMiss {
  const trimmed = raw.trim();
  const fallback = { profileId: DEFAULT_PROFILE_ID, explicit: false };
  if (trimmed.length === 0) return fallback;

  // Anywhere in the text, not only the head: the English surface puts the name
  // first ("tashi's jobs") and the slash surface puts it first too, but a
  // planner-extracted phrase may not.
  for (const word of trimmed.toLowerCase().replace(/['’]s\b/g, "").split(/[\s,]+/)) {
    const resolved = resolveProfileToken(word);
    if (resolved) return { profileId: resolved, explicit: true };
  }

  // Only one profile registered: nothing here can be a selector, so leave the
  // word alone rather than refusing a command that was never ambiguous.
  if (listProfiles().length < 2) return fallback;

  const [head = "", ...tail] = trimmed.split(/\s+/);
  const token = head.toLowerCase();
  // A number is always a row, and a recognised range is always a range.
  if (/^[\d,\s-]+$/.test(token) || parseWindowHours(head) !== null) return fallback;
  if (parseAxis(head) !== null || IS_VERB_WORD.test(token)) return fallback;
  // A leading filler word means this is a sentence, not a selector slot.
  if (IS_FILLER.test(token)) return fallback;
  // An unknown leading word is only a MISSED SELECTOR when what follows it is a
  // usable argument. `/jobs the first one` is not a profile mistake at all.
  const rest = tail.join(" ");
  if (rest.length === 0 || parseWindowHours(rest) === null) return fallback;

  return { unknown: token, known: listProfiles().map((p) => p.id) };
}

/**
 * The one entry point. `raw` is everything after the command word, or the
 * planner's phrase; `verb` is which list was asked for.
 */
export function parseBriefRequest(raw: string, verb: BriefVerb): BriefRequestResult {
  const profile = splitProfile(raw);
  if ("unknown" in profile) return profile;

  const named = parseWindowHours(raw);
  return {
    verb,
    profileId: profile.profileId,
    explicitProfile: profile.explicit,
    // `/today` ignores a range on purpose — see TODAY_WINDOW_HOURS.
    windowHours: verb === "today" ? TODAY_WINDOW_HOURS : (named ?? defaultWindowHours(verb)),
    axis: parseAxis(raw) ?? defaultAxis(verb),
  };
}

/**
 * The same object, from named arguments instead of a phrase.
 *
 * What the `job_brief` tool calls when the planner has already split the
 * founder's sentence into fields. It routes through the identical primitives, so
 * an English request and its slash equivalent cannot resolve differently.
 */
export function briefRequestFromArgs(args: {
  who?: string | undefined;
  verb?: string | undefined;
  range?: string | undefined;
  axis?: string | undefined;
}): BriefRequestResult {
  const verb: BriefVerb =
    args.verb === "today" || args.verb === "fresh" || args.verb === "jobs" ? args.verb : "jobs";
  const parts = [args.who, args.range, args.axis].filter((p): p is string => Boolean(p));
  return parseBriefRequest(parts.join(" "), verb);
}

/** A window in the words a person would use, for the header's scope line. */
export function describeWindow(hours: number): string {
  if (hours % 168 === 0 && hours >= 168) {
    const weeks = hours / 168;
    return weeks === 1 ? "the last week" : `the last ${weeks} weeks`;
  }
  if (hours % 24 === 0 && hours >= 24) {
    const days = hours / 24;
    return days === 1 ? "the last 24h" : `the last ${days} days`;
  }
  return `the last ${hours}h`;
}

/** The display filter a request resolves to, plus the words the header prints. */
export interface BriefScopePlan {
  readonly windowHours: number | null;
  readonly since?: Date;
  readonly axis: BriefAxis;
  readonly label: string;
}

/**
 * Turn a request into the slice of the queue to print, and say what it is.
 *
 * EVERY LIST NAMES ITS OWN SCOPE — UX rule 2 of the fresh-first plan. With three
 * verbs over one queue, a list that does not say what it excluded leaves an
 * empty market and a narrow window looking identical, which is the T-2 defect
 * this whole audit is about.
 *
 * `/fresh` ON ITS FIRST RUN SHOWS EVERYTHING, and says so. A delta against a
 * marker that does not exist yet has no honest answer; falling back to 24h would
 * silently hide the low-supply lane's whole fortnight the one time the founder
 * had never looked. After the first run the marker exists and every later run is
 * a true delta.
 */
export function scopeFor(
  request: BriefRequest,
  opts: { lastFreshView?: Date | null } = {},
): BriefScopePlan {
  const verb = request.axis === "found" ? "found" : "posted";

  if (request.verb === "fresh" && request.windowHours === null) {
    const since = opts.lastFreshView ?? null;
    return since
      ? {
          windowHours: null,
          since,
          axis: "found",
          label: `found since ${since.toISOString().slice(11, 16)} UTC`,
        }
      : {
          windowHours: null,
          axis: "found",
          label: "everything on file — you have not run /fresh before",
        };
  }

  if (request.windowHours === null) {
    return { windowHours: null, axis: request.axis, label: "everything on file" };
  }

  return {
    windowHours: request.windowHours,
    axis: request.axis,
    label: `${verb} in ${describeWindow(request.windowHours)}`,
  };
}

/** What the founder is told when the selector did not resolve. */
export function profileMissMessage(miss: ProfileMiss): string {
  return (
    `I don't know whose queue "${miss.unknown}" is, so I haven't touched either one. ` +
    `Name one of: ${miss.known.join(", ")} — or leave it off for ${DEFAULT_PROFILE_ID}.`
  );
}
