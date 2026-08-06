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
export type RoleTrack = "ai" | "fullstack" | "backend" | "frontend";

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
 * PAID vocabulary vs FREE vocabulary — TRACK_TITLES above and this list do two
 * different jobs, and giving them opposite widths is the point, not an
 * inconsistency.
 *
 * TRACK_TITLES feeds `titleSearch` to a metered Apify actor capped at
 * `MIN_ATS_LIMIT` (10) postings per query — in the last production sweep 5 of
 * 12 queries came back at exactly that cap. The cap is binding: adding a
 * phrase to TRACK_TITLES does not buy more postings, it makes more title
 * shapes compete for the same 10 slots. So it stays narrow.
 *
 * `classifyTrack` below does not query anything — it labels a posting the feed
 * already returned. That is pure local string work, free regardless of list
 * size, so it can be as wide as real title vocabulary actually is. Before this
 * list, "Software Development Engineer II" — the standard India/SDE title,
 * and it does NOT contain the substring "software engineer" because
 * "development" sits between the two halves — plus DevOps, SRE, cloud,
 * Python/Java/web-developer titles all returned null and were logged as
 * "unclassified", even though they had already been fetched and paid for.
 * That gap gets worse once the free job-board polling lane (added after this
 * paid pipeline) starts fetching whole boards unfiltered: every one of these
 * shapes will show up and needs a real track, not "unclassified".
 *
 * Terms here are plain lowercase with no `:*` suffix — that suffix is feed
 * search syntax and means nothing to a local string match. They are matched
 * with word boundaries, not `includes()`: several are short acronyms ("sde",
 * "sre") that `includes()` would also find inside unrelated words
 * ("misdeeds", "misreads"). TRACK_TITLES keeps plain `includes()` — its
 * phrases are long enough that a false positive is not realistic, and
 * changing how it matches now would risk reclassifying a title that already
 * classifies correctly today.
 */
export const TRACK_CLASSIFY_TERMS: Record<RoleTrack, readonly string[]> = {
  ai: [
    "ml engineer",
    "nlp engineer",
    "computer vision engineer",
    "deep learning engineer",
    "ai/ml engineer",
  ],
  fullstack: ["full stack developer", "mern developer", "mern stack developer"],
  backend: [
    "software development engineer",
    "sde",
    "devops engineer",
    "devops",
    "site reliability engineer",
    "sre",
    "cloud engineer",
    "infrastructure engineer",
    "systems engineer",
    "python developer",
    "java developer",
    "golang developer",
    "go developer",
    "node developer",
    "api engineer",
  ],
  frontend: [
    "web developer",
    "javascript developer",
    "typescript developer",
    "angular developer",
    "vue developer",
    "ui developer",
  ],
};

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
  return [...new Set(ordered.flatMap((t) => TRACK_TITLES[t]))];
}

/** Escapes regex metacharacters so a term can be embedded literally in a RegExp. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `term` appears in `normalisedTitle` as whole words, not as a
 * fragment of a longer word. TRACK_CLASSIFY_TERMS contains short acronyms
 * ("sde", "sre", "go") that plain `includes()` also finds mid-word — see the
 * TRACK_CLASSIFY_TERMS comment for the concrete false positives this avoids.
 */
function matchesAsWholeWord(normalisedTitle: string, term: string): boolean {
  return new RegExp(`\\b${escapeForRegExp(term)}\\b`).test(normalisedTitle);
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
export function classifyTrack(title: string): RoleTrack | null {
  const normalised = title.toLowerCase();
  for (const track of TRACK_PRIORITY) {
    const matchedPaidPhrase = TRACK_TITLES[track].some((phrase) =>
      normalised.includes(phrase.replace(/:\*$/, "").toLowerCase()),
    );
    const matchedClassifyTerm = TRACK_CLASSIFY_TERMS[track].some((term) =>
      matchesAsWholeWord(normalised, term),
    );
    if (matchedPaidPhrase || matchedClassifyTerm) return track;
  }
  return null;
}
