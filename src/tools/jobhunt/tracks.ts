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
 * The three tracks Pushkar applies for (founder direction, 2026-07-31).
 *
 * Frontend is the deepest track on his CV — three years of production React and
 * Next.js — and until 2026-07-31 it was not searched at all, so the pipeline
 * could not have surfaced the roles he is most obviously qualified for.
 */
export type RoleTrack = "ai" | "backend" | "frontend";

export const TRACK_TITLES: Record<RoleTrack, readonly string[]> = {
  ai: [
    "AI Engineer:*",
    "Machine Learning Engineer:*",
    "LLM Engineer:*",
    "MLOps Engineer:*",
  ],
  backend: [
    "Backend Engineer:*",
    "Software Engineer:*",
    "Platform Engineer:*",
    "Data Engineer:*",
  ],
  frontend: [
    "Frontend Engineer:*",
    "Front End Engineer:*",
    "Full Stack Engineer:*",
    "React Developer:*",
  ],
};

/**
 * Priority order. This is NOT cosmetic: the sweep fetches a bounded number of
 * postings a day, so whichever titles the feed matches first spend the budget.
 * AI leads because it is the stated priority; frontend trails because those
 * roles are the easiest to find by hand if the budget runs out.
 */
export const TRACK_PRIORITY: readonly RoleTrack[] = ["ai", "backend", "frontend"];

/** Titles for the given tracks, in priority order, de-duplicated. */
export function titlesForTracks(tracks: readonly RoleTrack[]): string[] {
  const ordered = TRACK_PRIORITY.filter((t) => tracks.includes(t));
  return [...new Set(ordered.flatMap((t) => TRACK_TITLES[t]))];
}

/**
 * Which track a posting belongs to, from its title alone.
 *
 * Deterministic and pure: the same title always lands in the same track, so a
 * shift in the per-track market numbers is attributable to the market rather
 * than to the classifier. A title matching more than one track resolves by
 * TRACK_PRIORITY — "Full Stack" reads as frontend, "AI/Backend" as ai.
 *
 * Returns null when nothing matches. That is recorded as "unclassified" rather
 * than forced into a track, because a wrong track silently corrupts the gap
 * report for two tracks at once: the term is counted where it does not belong
 * and missing where it does.
 */
export function classifyTrack(title: string): RoleTrack | null {
  const normalised = title.toLowerCase();
  for (const track of TRACK_PRIORITY) {
    const matched = TRACK_TITLES[track].some((phrase) =>
      normalised.includes(phrase.replace(/:\*$/, "").toLowerCase()),
    );
    if (matched) return track;
  }
  return null;
}
