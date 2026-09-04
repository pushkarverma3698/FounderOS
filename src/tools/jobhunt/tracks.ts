/**
 * FounderOS — career tracks
 * =========================
 * The three markets the campaign searches, and how a posting title maps to one.
 *
 * Split out of ats-source.ts because this vocabulary is not about the ATS feed:
 * the Indeed source, the screening path, the gap report and the daily brief all
 * need it, and none of them should have to import a network module to classify
 * a string.
 */

/**
 * The four tracks Pushkar applies for (founder direction, 2026-07-31 / 2026-08-01).
 *
 * Frontend is the deepest track on his CV — three years of production React and
 * Next.js — and until 2026-07-31 it was not searched at all, so the pipeline
 * could not have surfaced the roles he is most obviously qualified for.
 *
 * `fullstack` was split out of frontend on 2026-08-01 after the founder reported
 * seeing no full-stack roles at all. It had been ONE phrase ("Full Stack
 * Engineer:*") competing with three others inside the frontend track's budget,
 * which is the same starvation that hid frontend itself a day earlier — one
 * level down. It is also the track his CV matches most directly: three years of
 * React + Node + Postgres, shipped.
 */
import { getProfile, type JobSearchProfile } from "./profile-config.js";

/**
 * RoleTrack — string track identifier e.g. "ai", "fullstack", "backend", "frontend", "fpa", "compliance-kyc".
 */
export type RoleTrack = string;

/**
 * TITLES ARE MATCHED AS SUBSTRINGS, NOT PREFIXES.
 *
 * The `:*` suffix reads like a prefix wildcard and the feed's docs describe it
 * as one, but the live behaviour is a substring match — "Software Engineer:*"
 * returned "Graduate Software Engineer (2027)" on 2026-08-01. That cuts both
 * ways, and this list is built around the useful direction: "Backend Engineer"
 * already covers "Senior Backend Engineer" and "Backend Engineer III", so
 * seniority prefixes are NOT enumerated here.
 *
 * What must be enumerated is every way a company SPELLS the role, because those
 * are genuinely different substrings:
 *
 *   · "Engineer" vs "Developer" — Dutch scale-ups and startups overwhelmingly
 *     post "Developer"; enterprises post "Engineer". Searching only "Engineer"
 *     silently selects for large companies, which is the exact bias the founder
 *     asked to remove ("open the pool for mid sized companies and startups").
 *   · "Full Stack" vs "Full-Stack" vs "Fullstack" — three distinct substrings
 *     for one role. Matching one of the three drops roughly two thirds of them.
 *   · "Founding Engineer" / "Product Engineer" — startup-native titles with no
 *     enterprise equivalent. A startup's first engineering hire is never
 *     advertised as "Backend Engineer II".
 */
export const TRACK_TITLES: Record<RoleTrack, readonly string[]> = {
  ai: [
    "AI Engineer:*",
    "AI Developer:*",
    "Machine Learning Engineer:*",
    "LLM Engineer:*",
    "MLOps Engineer:*",
    "GenAI:*",
  ],
  // The bare stem, not "Full Stack Engineer". Substring matching means the stem
  // covers Engineer, Developer, Architect and Team Lead in one phrase — and it
  // is the only form that also matches "Full Stack SOFTWARE Engineer", where a
  // word sits between the two halves. Enumerating the suffixes instead let that
  // title fall through to the backend track, which is how a full-stack role
  // ended up counted as something else.
  fullstack: [
    "Full Stack:*",
    "Full-Stack:*",
    "Fullstack:*",
    "Founding Engineer:*",
    "Product Engineer:*",
  ],
  backend: [
    "Backend Engineer:*",
    "Back End Engineer:*",
    "Backend Developer:*",
    "Software Engineer:*",
    "Software Developer:*",
    "Platform Engineer:*",
    "Data Engineer:*",
    "Node.js Developer:*",
  ],
  frontend: [
    "Frontend Engineer:*",
    "Front End Engineer:*",
    "Frontend Developer:*",
    "Front End Developer:*",
    "Front-End Developer:*",
    "React Developer:*",
    "React Engineer:*",
    "UI Engineer:*",
  ],
};

/**
 * The FREE classifier's vocabulary lives in track-vocabulary.ts and is
 * re-exported here so every existing import site keeps resolving. The lists
 * moved when measurement pushed this file past its budget; the reason they are
 * a separate module rather than a longer one is that they have the opposite
 * economics to TRACK_TITLES above — see that file's header.
 */
export {
  TRACK_CLASSIFY_TERMS,
  TRACK_QUALIFIERS,
  GENERIC_ENGINEERING_TERMS,
  GENERIC_FALLBACK_TRACK,
} from "./track-vocabulary.js";

import {
  TRACK_CLASSIFY_TERMS,
  TRACK_QUALIFIERS,
  GENERIC_ENGINEERING_TERMS,
  GENERIC_FALLBACK_TRACK,
  GENERIC_PAID_PHRASES,
  ROLE_NOUNS,
} from "./track-vocabulary.js";

/**
 * Priority order. Since 2026-08-01 every track gets its OWN query and its own
 * budget, so this no longer decides who gets starved — but it still decides two
 * real things: the order the sweep runs in (so a mid-sweep failure loses the
 * least important track), and how `classifyTrack` breaks a tie.
 *
 * `fullstack` sits above `backend` deliberately: "Full Stack Software Engineer"
 * contains both "full stack" and "software engineer", and full-stack is the more
 * specific — and more accurate — reading of that posting.
 */
export const TRACK_PRIORITY: readonly RoleTrack[] = [
  "ai",
  "fullstack",
  "backend",
  "frontend",
];

/** Titles for the given tracks, in priority order, de-duplicated. */
export function titlesForTracks(tracks: readonly RoleTrack[]): string[] {
  const ordered = TRACK_PRIORITY.filter((t) => tracks.includes(t));
  return [...new Set(ordered.flatMap((t) => TRACK_TITLES[t] ?? []))];
}

/** Escapes regex metacharacters so a term can be embedded literally in a RegExp. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `term` appears in `normalisedTitle` as whole words, not as a
 * fragment of a longer word. TRACK_CLASSIFY_TERMS contains short acronyms
 * ("sde", "sre") that plain `includes()` also finds mid-word — see the
 * TRACK_CLASSIFY_TERMS comment for the concrete false positives this avoids.
 * It has never contained a bare "go"; the term is "go developer".
 *
 * NOT `\b`, which is defined against word characters and therefore cannot see
 * the edge of a term that BEGINS or ENDS in punctuation: `\b\.net\b` never
 * matches ".NET Developer" (there is no word boundary before a dot preceded by
 * a space) and `\bc#\b` never matches "C# Developer". Since half the language
 * qualifiers are spelled with punctuation, the boundary is expressed directly
 * as "not flanked by an alphanumeric", and only on the side where the term's
 * own edge is alphanumeric — so ".net" still matches inside "ASP.NET".
 */
function matchesAsWholeWord(normalisedTitle: string, term: string): boolean {
  const left = /^[a-z0-9]/i.test(term) ? "(?<![a-z0-9])" : "";
  const right = /[a-z0-9]$/i.test(term) ? "(?![a-z0-9])" : "";
  return new RegExp(`${left}${escapeForRegExp(term)}${right}`).test(normalisedTitle);
}

/**
 * Which track a posting belongs to, from its title alone.
 *
 * Deterministic and pure: the same title always lands in the same track, so a
 * shift in the per-track market numbers is attributable to the market rather
 * than to the classifier. A title matching more than one track resolves by
 * TRACK_PRIORITY — "Full Stack Software Engineer" reads as fullstack rather
 * than backend, and "AI/Backend" as ai.
 *
 * Matches against the union of TRACK_TITLES (paid vocabulary, substring match)
 * and TRACK_CLASSIFY_TERMS (free vocabulary, whole-word match) for each track,
 * still walked in TRACK_PRIORITY order — so a term added to widen recognition
 * can never outrank a track that already matched via its paid phrases.
 *
 * Returns null when nothing matches. That is recorded as "unclassified" rather
 * than forced into a track, because a wrong track silently corrupts the gap
 * report for two tracks at once: the term is counted where it does not belong
 * and missing where it does.
 */
export function classifyTrack(
  title: string,
  profile: JobSearchProfile = getProfile(),
): RoleTrack | null {
  const normalised = title.toLowerCase();

  const trackPriority = profile.trackPriority;
  const tracks = profile.tracks;

  // Pass 1 — profile track titles and classify terms
  for (const trackId of trackPriority) {
    const trackConfig = tracks[trackId];
    if (!trackConfig) continue;

    const matchedTitlePhrase = trackConfig.titles.some((phrase) => {
      const term = phrase.replace(/:\*$/, "").toLowerCase();
      return !GENERIC_PAID_PHRASES.has(term) && normalised.includes(term);
    });

    const matchedClassifyTerm = trackConfig.classifyTerms.some((term) =>
      matchesAsWholeWord(normalised, term),
    );

    if (matchedTitlePhrase || matchedClassifyTerm) return trackId;
  }

  // Fallback to legacy tech classification only for tech profiles
  if (profile.skillsDictionaryName === "tech") {
    for (const track of TRACK_PRIORITY) {
      const matchedPaidPhrase = TRACK_TITLES[track]?.some((phrase) => {
        const term = phrase.replace(/:\*$/, "").toLowerCase();
        return !GENERIC_PAID_PHRASES.has(term) && normalised.includes(term);
      });
      const matchedClassifyTerm = TRACK_CLASSIFY_TERMS[track]?.some((term) =>
        matchesAsWholeWord(normalised, term),
      );
      if (matchedPaidPhrase || matchedClassifyTerm) return track;
    }

    if (ROLE_NOUNS.some((noun) => matchesAsWholeWord(normalised, noun))) {
      for (const track of TRACK_PRIORITY) {
        if (TRACK_QUALIFIERS[track]?.some((q) => matchesAsWholeWord(normalised, q))) return track;
      }
    }

    if (GENERIC_ENGINEERING_TERMS.some((term) => matchesAsWholeWord(normalised, term))) {
      return GENERIC_FALLBACK_TRACK;
    }
  }

  return null;
}
