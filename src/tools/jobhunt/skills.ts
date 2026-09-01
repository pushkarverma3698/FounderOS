/**
 * FounderOS — skill-signal extraction
 * ===================================
 * Turns a job posting body into the set of technologies it asks for.
 *
 * Pure and deterministic: no network, no model, no DB. That is the point —
 * frequency counts across hundreds of postings only mean something if the
 * extractor gives the same answer to the same text every time.
 *
 * TWO INVARIANTS, both of which look like details and are not:
 *
 *   1. A term is counted ONCE PER POSTING, never once per occurrence. A posting
 *      that says "Kubernetes" eight times is one employer asking for Kubernetes.
 *      Counting occurrences would let the most verbose postings write the table.
 *
 *   2. Matching uses non-alphanumeric boundaries, not substring search, so
 *      "rag" does not fire inside "ragged" and "go" does not fire inside "going".
 *      (Short English words are excluded from the alias lists entirely — see
 *      skills-dictionary.ts.)
 *
 * The unknown-term pass is the dictionary's escape hatch: technology-shaped
 * tokens the dictionary has never heard of are recorded so the founder can
 * promote genuinely rising ones (this is how "MCP" would have been caught in
 * 2025). It is deliberately conservative and its output is only ever REPORTED
 * above a frequency threshold — see gaps.ts.
 */

import { SKILL_DICTIONARY, type SkillCategory, type SkillTerm } from "./skills-dictionary.js";

/** Dictionary categories plus the bucket for terms it has never heard of. */
export type SignalCategory = SkillCategory | "unknown";

export interface ExtractedSignal {
  readonly term: string;
  readonly category: SignalCategory;
}

/** Canonical term → category, built once so lookups don't rescan the dictionary. */
const TERM_CATEGORY: ReadonlyMap<string, SkillCategory> = new Map(
  SKILL_DICTIONARY.map((entry) => [entry.term, entry.category]),
);

/** The dictionary category a matched term belongs to, or undefined for anything not in it. */
export function categoryOf(term: string): SkillCategory | undefined {
  return TERM_CATEGORY.get(term);
}

/** Bound the text we scan so one pathological posting can't stall the sweep. */
const MAX_SCAN_CHARS = 40_000;

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Alias → anchored matcher. Boundaries are "not alphanumeric" rather than \b
 * because \b sits between "c" and "+", so /\bc\+\+\b/ never matches "C++".
 */
function aliasPattern(alias: string): RegExp {
  return new RegExp(`(?<![a-z0-9])${escapeRegex(alias)}(?![a-z0-9])`);
}

/** Compiled once at module load — the sweep re-uses these across every posting. */
const COMPILED: ReadonlyArray<{ entry: SkillTerm; patterns: readonly RegExp[] }> =
  SKILL_DICTIONARY.map((entry) => ({
    entry,
    patterns: entry.aliases.map(aliasPattern),
  }));

/** Every canonical term and alias, lowercased — used to suppress known terms
 *  from the unknown pass. */
const KNOWN_SURFACE_FORMS: ReadonlySet<string> = new Set(
  SKILL_DICTIONARY.flatMap((e) => [e.term.toLowerCase(), ...e.aliases]),
);

/**
 * Extract the dictionary terms a posting asks for. Returns a de-duplicated,
 * stably ordered list (dictionary order), so two runs over the same text
 * produce byte-identical output.
 */
export function extractSkillTerms(description: string): ExtractedSignal[] {
  const haystack = description.slice(0, MAX_SCAN_CHARS).toLowerCase();
  if (haystack.trim().length === 0) return [];

  const found: ExtractedSignal[] = [];
  for (const { entry, patterns } of COMPILED) {
    if (patterns.some((p) => p.test(haystack))) {
      found.push({ term: entry.term, category: entry.category });
    }
  }
  return found;
}

// ── Unknown-term pass ─────────────────────────────────────────────────────────

/**
 * Tokens that pass the technology shape test but are business, legal, or
 * geographic noise. Everything here would otherwise recur in every Dutch
 * posting and drown the signal.
 */
const UNKNOWN_STOPWORDS: ReadonlySet<string> = new Set([
  // Geography / legal entity
  "eu", "nl", "uk", "usa", "us", "emea", "apac", "bv", "nv", "gmbh", "llc",
  "inc", "ltd", "plc", "kvk", "btw", "iban", "ind", "gdpr", "avg", "kyc", "aml",
  // Business / HR
  "hr", "cv", "ceo", "cto", "coo", "cfo", "cio", "vp", "svp", "evp", "it",
  "kpi", "kpis", "okr", "okrs", "ote", "wfh", "pto", "b2b", "b2c", "saas",
  "roi", "sme", "ux", "ui", "qa", "pm", "po", "sla", "nda", "faq", "tbd",
  // Education
  "phd", "msc", "bsc", "mba", "bs", "ms", "ba", "hbo", "wo", "mbo",
  // Time / misc
  "am", "pm", "id", "ok", "ps", "eod", "eta", "fte", "ftes",
  // Generic technical vocabulary — real words, but they describe everything and
  // therefore distinguish nothing. All observed in the first live run (2026-07-29).
  "api", "apis", "sdk", "sdks", "ide", "cli", "gui", "os", "vm", "vms", "pc",
  "http", "https", "url", "urls", "json", "xml", "yaml", "csv", "html", "css",
  "bi", "crm", "erp", "cms", "orm", "mvp", "poc", "eol", "ssl", "tls", "ssh",
  // Halves of dictionary terms that also appear standalone (CI/CD → "CI", "CD").
  "ci", "cd", "ml", "ai",
]);

/** CamelCase (LangGraph, PyTorch, DevOps) or a short all-caps acronym (MCP). */
const CAMEL_OR_ACRONYM = /^(?:[A-Z][a-z0-9]*(?:[A-Z0-9][A-Za-z0-9]*)+|[A-Z]{2,6})$/;

/** Split on anything that can't be inside a technology name. */
const TOKEN_SPLIT = /[^A-Za-z0-9.+#-]+/;

/**
 * Technology-shaped tokens the dictionary doesn't know, once per posting.
 *
 * `companyName` is excluded because CamelCase brand names ("TravelBase") pass
 * the shape test and would otherwise be indistinguishable from a real emerging
 * technology in the report.
 */
export function extractUnknownTerms(description: string, companyName = ""): string[] {
  const companyTokens = new Set(
    companyName.split(TOKEN_SPLIT).filter(Boolean).map((t) => t.toLowerCase()),
  );

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of description.slice(0, MAX_SCAN_CHARS).split(TOKEN_SPLIT)) {
    const token = raw.replace(/^[.+#-]+|[.+#-]+$/g, "");
    if (token.length < 2 || token.length > 20) continue;
    if (!CAMEL_OR_ACRONYM.test(token)) continue;

    const lower = token.toLowerCase();
    if (seen.has(lower)) continue;
    if (KNOWN_SURFACE_FORMS.has(lower)) continue;
    if (UNKNOWN_STOPWORDS.has(lower)) continue;
    if (companyTokens.has(lower)) continue;

    seen.add(lower);
    out.push(token);
  }
  return out;
}

/**
 * Everything one posting contributes to `cv_signals`: known terms with their
 * category, plus unknown candidates tagged for review.
 */
export function signalsForPosting(
  description: string,
  companyName = "",
): ExtractedSignal[] {
  return [
    ...extractSkillTerms(description),
    ...extractUnknownTerms(description, companyName).map((term) => ({
      term,
      category: "unknown" as const,
    })),
  ];
}
