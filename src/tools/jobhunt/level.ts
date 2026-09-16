/**
 * FounderOS — the title-LEVEL gate
 * ================================
 * Founder direction, 2026-09-15: "make sure too senior roles doesn't appear for
 * both as they are useless and CV will not get Screened."
 *
 * WHY THIS EXISTS ALONGSIDE `experience.ts`, WHICH REFUSES TO READ TITLES.
 * That refusal is still right for what it covers — the years gate screens on a
 * NUMBER the employer wrote down, and a title is a guess about one. But two
 * measurements on the live table (2026-09-15) show the number is absent or wrong
 * exactly where the level matters most:
 *
 *   · 21 of Pushkar's 122 actionable rows and 58 of Tashi's 124 state no year
 *     figure at all. `experienceGate` passes every one of them, whatever the
 *     title says, and that is how "Principal Architect — Cloud & AI
 *     Engineering" and "Manager, Financial Planning and Analysis" arrived in DO
 *     TODAY for a 3.5-year engineer and a 2.4-year analyst.
 *   · Where a figure is stated it can be the wrong figure. See
 *     experience-qualifier.test.ts for the prod row whose verdict read "Asks for
 *     2 year(s)" while quoting "8+ years of software engineering experience".
 *
 * So the two gates answer different questions and neither replaces the other:
 * `experienceGate` asks what the employer demanded, this asks what seat they are
 * hiring for. A staff-or-above seat is not won by a strong mid-level
 * application; it is filtered out before a human reads it, which is the founder's
 * own words for why this gate is worth its cost.
 *
 * THE CEILING IS A PROPERTY OF THE PROFILE. Pushkar at 3.5 years wins "Senior X"
 * routinely, so senior is silent for him. Tashi at 2.4 years is a genuine
 * stretch for it, so senior FLAGS for her and the row survives into STRETCH
 * rather than vanishing. One hardcoded ladder would be wrong for one of them.
 *
 * REJECTED INSIDE THE PIPELINE, NEVER DROPPED OUTSIDE IT. A rejected row keeps
 * its reason in `gate_json` and stays in `/csv` (founder direction, 2026-08-01:
 * "store all the data we are collecting even if it is senior and of no use to
 * us"). A filtered-out row and an empty market are indistinguishable from
 * outside, and that ambiguity has already cost this pipeline weeks.
 */

import type { Gate } from "./gates.js";
import { getProfile, type JobSearchProfile } from "./profile-config.js";

/**
 * The seat a title advertises, as a recruiter reads it.
 *
 * Numeric so a profile can state a ceiling as a comparison rather than a set,
 * and ordered so `classifyTitleLevel` can take the HIGHEST level a title names.
 * "Senior Lead-AI Engineer" opens with the lower word; reading left to right
 * would call it senior.
 */
export const TITLE_LEVEL = {
  /** No level word at all, or a junior/associate one. The default. */
  MID: 3,
  /** Senior, Sr., and the banking Assistant Vice President grade. */
  SENIOR: 4,
  /** Staff, Principal, Lead, Architect, Manager — typically 8 years and up. */
  STAFF: 5,
  /** Director, Head of, Chief, Senior Manager, Vice President. */
  EXEC: 6,
} as const;

export type TitleLevel = (typeof TITLE_LEVEL)[keyof typeof TITLE_LEVEL];

/** How each level reads in a sentence the founder has to act on. */
const LEVEL_WORD: Readonly<Record<TitleLevel, string>> = {
  [TITLE_LEVEL.MID]: "mid-level",
  [TITLE_LEVEL.SENIOR]: "senior",
  [TITLE_LEVEL.STAFF]: "staff/principal-level",
  [TITLE_LEVEL.EXEC]: "director-level",
};

/**
 * Phrases that CONTAIN a ladder word without naming that level, removed before
 * any tier is scanned.
 *
 * Every entry was found in the real 2,383-row table, not imagined. Getting this
 * list wrong is the expensive direction: an over-eager title gate removes
 * reachable roles and emits no signal that it did.
 *
 *   · "business partner"  — an ordinary finance seat. "AMEA FC Commercial
 *                           Finance Business Partner" is not an equity partner.
 *   · "lead associate"    — a WNS mid-level grade; the title itself says
 *                           "3 - 5 Years".
 *   · "lead generation"   — a sales function, not a level.
 *   · "assistant vice president" / "avp" — see ASSISTANT_VP_RE below.
 */
const NEUTRALISED: readonly RegExp[] = [
  /\bbusiness partner\b/g,
  /\blead associate\b/g,
  /\blead generation\b/g,
];

/**
 * The banking AVP grade, which is a SENIOR individual contributor and not an
 * executive.
 *
 * At Citi, ING and ABN an Assistant Vice President is roughly a four-to-six year
 * IC seat — "Senior Python Developer - Assistant Vice President" is a real
 * target. Reading the words "Vice President" literally would discard a whole
 * reachable band of the Dutch and Indian banking market. A plain or SENIOR Vice
 * President is the executive grade and is left to the EXEC tier below.
 */
const ASSISTANT_VP_RE = /\b(?:assistant vice president|avp)\b/g;

/**
 * Tier markers, matched as WHOLE TOKENS on a normalised title.
 *
 * Tokens, never substrings: "leadership" is not "lead", "management" is not
 * "manager", "architecture" is not "architect" and "staffing" is not "staff".
 * All four appear in real titles and all four would be false rejects.
 */
const EXEC_TERMS: readonly string[] = [
  "director",
  "chief",
  "cto",
  "cfo",
  "coo",
  "ceo",
];

/** Multi-word executive markers, matched as phrases on the normalised title. */
const EXEC_PHRASES: readonly RegExp[] = [
  /\bhead of\b/,
  /\bvice president\b/,
  /\bsvp\b/,
  /\bsenior manager\b/,
  /\bsr manager\b/,
];

const STAFF_TERMS: readonly string[] = [
  "staff",
  "principal",
  "architect",
  "manager",
  "lead",
];

const SENIOR_TERMS: readonly string[] = ["senior", "sr"];

/**
 * Lowercase, and reduce every separator the feeds emit to a single space.
 *
 * "Sr." → "sr", "Senior/Staff" → "senior staff", "FP&A Manager" → "fp a
 * manager", "Senior Lead-AI Engineer" → "senior lead ai engineer". Tokenising
 * this way is what lets the tier scan use whole-word equality instead of a
 * regex per term.
 */
function normalise(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function hasToken(tokens: ReadonlySet<string>, terms: readonly string[]): boolean {
  return terms.some((t) => tokens.has(t));
}

/**
 * The seat a title advertises. Pure, case-insensitive, and dependent on nothing
 * but the string.
 *
 * Takes the HIGHEST level named. A title carrying two ladder words means the
 * higher one: "Senior Staff Software Engineer" is a staff seat, and "Lead Java
 * Software Engineer - Vice President" is an executive one.
 */
export function classifyTitleLevel(title: string): TitleLevel {
  let text = normalise(title);

  // Order matters. The AVP grade is removed BEFORE the EXEC phrases run, or
  // "assistant vice president" matches "vice president" and reads as executive.
  const isAssistantVp = ASSISTANT_VP_RE.test(text);
  ASSISTANT_VP_RE.lastIndex = 0;
  text = text.replace(ASSISTANT_VP_RE, " ");
  for (const phrase of NEUTRALISED) text = text.replace(phrase, " ");

  const tokens = new Set(text.split(/\s+/).filter((t) => t.length > 0));

  if (hasToken(tokens, EXEC_TERMS) || EXEC_PHRASES.some((re) => re.test(text))) {
    return TITLE_LEVEL.EXEC;
  }
  if (hasToken(tokens, STAFF_TERMS)) return TITLE_LEVEL.STAFF;
  if (isAssistantVp || hasToken(tokens, SENIOR_TERMS)) return TITLE_LEVEL.SENIOR;
  return TITLE_LEVEL.MID;
}

/**
 * The Level gate — three outcomes, and SILENCE is one of them.
 *
 *   · at or under `maxTitlePass`     → null. Nothing to say.
 *   · at or under `maxTitleStretch`  → flag, so the row lands in STRETCH.
 *   · above it                       → reject, with the level named.
 *
 * Returning null rather than a passing gate is deliberate. A "✅ your level is
 * fine" line on every row in the brief is noise wearing the costume of
 * information, and the brief's own legend only earns its space for checks that
 * can actually go the other way (see `locationGate`, which does the same).
 *
 * THE TITLE DECIDES REGARDLESS OF STATED YEARS. A "Staff Engineer" advertising
 * "2+ years" is describing a sub-requirement of a staff seat, not a staff seat
 * open to two years — that exact posting is the one that reached rank 32 of DO
 * TODAY. Where the two gates disagree, the seat is the more reliable evidence.
 */
export function levelGate(
  title: string,
  profile: JobSearchProfile = getProfile(),
): Gate | null {
  const level = classifyTitleLevel(title);
  if (level <= profile.maxTitlePass) return null;

  const years = profile.experienceYears;
  const word = LEVEL_WORD[level];

  if (level <= profile.maxTitleStretch) {
    return {
      gate: "Level",
      status: "flag",
      evidence:
        `"${title}" is a ${word} seat — above your ~${years} years, but the kind of ` +
        `stretch that is won by applying early with a close stack match. Worth an ` +
        `application, not a question.`,
    };
  }

  return {
    gate: "Level",
    status: "reject",
    evidence:
      `"${title}" is a ${word} seat, which employers fill from ~8 years and up — ` +
      `clear of even a stretch from your ~${years}. A CV at your level is filtered ` +
      `out of this one before a human reads it. Kept on record so the market stays ` +
      `auditable, but not worth an application.`,
  };
}
