/**
 * FounderOS — the FREE classifier's vocabulary
 * ============================================
 * Every word list `classifyTrack` matches against. Split out of tracks.ts on
 * 2026-08-20, when measuring what the live boards actually post pushed that
 * file past its 400-line budget — the same precedent as brief-persist.ts and
 * board-harvest.ts.
 *
 * The split is not only about size. tracks.ts now holds two things that fail
 * differently: `TRACK_TITLES` is a metered SEARCH vocabulary where every added
 * phrase costs supply, and everything here is a free LOCAL vocabulary where
 * every added phrase buys it. Keeping them in one file is what let a phrase
 * that belonged in one get judged by the economics of the other.
 *
 * Nothing here is guessed. Every entry, and every deliberate omission, was
 * measured against a 4,412-posting sample of the live free registry on
 * 2026-08-20 — the counts in the comments are from that run.
 */

import type { RoleTrack } from "./tracks.js";

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
    // Measured 2026-08-20 against 4,412 live board postings: "data scientist"
    // appeared 25 times and classified as nothing. It is not caught by the
    // qualifier pass below either — "scientist" is a role noun, but "data" is
    // deliberately NOT a qualifier (it would swallow "Data Entry Clerk").
    "data scientist",
    "applied scientist",
    // "Research Engineer" carries no AI qualifier of its own, yet 10 of the 11
    // in that sample were model/LLM research posts at AI labs. The two
    // "researcher" spellings are named here rather than making "researcher" a
    // role noun, which also swept in "Staff UX Researcher".
    "research engineer",
    "research scientist",
    "machine learning researcher",
    "ai researcher",
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
    // The SINGULAR was missing while the plural was present, so "System
    // Engineer (Compute Node)" classified as nothing four times in one sample.
    "system engineer",
    "python developer",
    "java developer",
    "golang developer",
    "go developer",
    "node developer",
    "api engineer",
  ],
  frontend: [
    "web developer",
    "web engineer",
    "javascript developer",
    "typescript developer",
    "angular developer",
    "vue developer",
    "ui developer",
  ],
};

/**
 * The words that make a title a ROLE rather than a subject.
 *
 * Half of the qualifier mechanism below: a track qualifier alone is a topic
 * ("Frontend"), and a role noun alone is a job of some kind ("Engineer"). Only
 * the two together name an engineering role, which is what keeps "UX Designer"
 * and "Mechanical Engineer" out while letting "Frontend Software Engineer" in.
 *
 * Dutch forms are included because the free registry now polls Recruitee, whose
 * customers are overwhelmingly Dutch SMEs posting in Dutch.
 */
export const ROLE_NOUNS: readonly string[] = [
  "engineer",
  "developer",
  "programmer",
  "architect",
  "scientist",
  "ontwikkelaar",
  "programmeur",
];
// "researcher" and "lead" were tried here and REMOVED after measuring what
// they actually caught: "Staff UX Researcher", "AI Deployment Lead, Hedge
// Funds" and "AI Business Consulting Lead" are not engineering roles, and the
// engineering titles they were meant to rescue ("Tech Lead", "Machine Learning
// Researcher") are named explicitly instead — precisely, and without the tail.

/**
 * What marks a title as belonging to a track, when paired with a role noun.
 *
 * WHY THIS EXISTS. Until 2026-08-20 a title had to contain a whole phrase from
 * one of the two lists above, so "Frontend Software Engineer" and "Senior
 * Software Engineer, Frontend" both matched backend's "Software Engineer" and
 * neither matched anything in frontend — frontend is checked LAST, and backend
 * had already returned. Production showed the damage: 228 backend rows against
 * 10 frontend, on the track that is the deepest three years of the CV. Pairing
 * a qualifier with a role noun catches every word order without enumerating it.
 *
 * DELIBERATELY ABSENT: cloud-vendor names (aws, gcp, azure) and the bare word
 * "cloud". Each of them turns "Solutions Architect" — a customer-facing
 * pre-sales role, 42 of them in one sample and not one an engineering job —
 * into a backend match. "Cloud Engineer" stays covered by its exact term above.
 * "data" is absent for the same reason: it would take "Data Entry Clerk" with it.
 */
export const TRACK_QUALIFIERS: Record<RoleTrack, readonly string[]> = {
  ai: [
    "ai", "a.i.", "artificial intelligence", "ml", "machine learning",
    "deep learning", "nlp", "llm", "llms", "genai", "generative ai",
    "computer vision", "mlops", "ml ops", "data science", "rag",
  ],
  fullstack: ["full stack", "full-stack", "fullstack", "mern", "mean stack"],
  backend: [
    "backend", "back end", "back-end", "server side", "server-side",
    "python", "java", "golang", "rust", "kotlin", "scala", "ruby",
    "ruby on rails", "rails", "php", "laravel", "symfony", "c#", ".net",
    "dotnet", "c++", "elixir", "django", "spring boot", "node", "node.js",
    "nodejs", "api", "apis", "microservices", "platform", "infrastructure",
    "devops", "sre", "kubernetes", "k8s", "docker", "terraform",
    // Bare "systems"/"system" are ABSENT: they turned "Lead Product Designer
    // (UI & Design Systems)" into a backend engineer. "System Engineer" and
    // "Systems Engineer" are named exactly in TRACK_CLASSIFY_TERMS instead.
    "distributed systems", "linux", "sql", "postgres", "embedded", "compiler",
  ],
  frontend: [
    "frontend", "front end", "front-end", "react", "reactjs", "react.js",
    "react native", "vue", "vue.js", "vuejs", "angular", "svelte",
    // Bare "web" is ABSENT: "Principal Architect: Amazon Web Services (AWS)"
    // matched it and came back a frontend role. "Web Developer"/"Web Engineer"
    // are named exactly below.
    "next.js", "nextjs", "ui", "ux", "javascript", "typescript", "css", "html",
  ],
};

/**
 * Titles that say "this is a software role" without saying WHICH one.
 *
 * Matched only after every track's own vocabulary has failed, and resolved to
 * `GENERIC_FALLBACK_TRACK`. That ordering is the whole point: "Software
 * Engineer" sitting inside backend's phrase list is what made backend win
 * every title that merely CONTAINED it.
 *
 * Every entry here was measured in the 2026-08-20 sample: "staff engineer" (23
 * postings, all software), "principal engineer" (7, all software), "forward
 * deployed engineer" (38 — a real and now-common title with no track marker at
 * all). Bare "senior engineer" is excluded: it did not appear once in that
 * corpus as a software role, and on the hardware-heavy boards in this registry
 * it is usually mechanical or electrical.
 */
export const GENERIC_ENGINEERING_TERMS: readonly string[] = [
  "software engineer",
  "software developer",
  // The GERUND, separately: "Software Engineering Manager" does not contain
  // the substring "software engineer" as a whole word (the "ing" swallows the
  // boundary), and without this line eight such titles that used to classify
  // as backend would silently stop reaching the pipeline at all. They are
  // leadership roles the experience gate will very likely reject — but it must
  // be the gate that rejects them, with a reason on the row, not the
  // classifier dropping them where nobody can see it.
  "software engineering",
  "software development engineer",
  "sde",
  "swe",
  "staff engineer",
  "principal engineer",
  "forward deployed engineer",
  "forward deployed architect",
  "tech lead",
  "technical lead",
  "softwareontwikkelaar",
  "software ontwikkelaar",
  "ontwikkelaar",
  "programmeur",
];

/** Where an unqualified software title lands. Backend is the historical default. */
export const GENERIC_FALLBACK_TRACK: RoleTrack = "backend";

/**
 * Paid phrases that name no track. Excluded from the track-specific pass so
 * they cannot pre-empt a more specific match — they are still QUERIED for the
 * backend track (TRACK_TITLES is untouched), only their classifying power moves.
 */
export const GENERIC_PAID_PHRASES = new Set(["software engineer", "software developer"]);