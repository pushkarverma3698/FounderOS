/**
 * IND recognised-sponsor matching
 * ================================
 * Only a recognised sponsor can lawfully hire a non-EU candidate on a highly
 * skilled migrant permit, so this is the first and hardest gate in the pipeline.
 *
 * The asymmetry drives the design. A false NEGATIVE costs one missed opportunity.
 * A false POSITIVE costs a whole application — research, letter, follow-up — aimed
 * at a company that cannot lawfully make the hire. So the verdict is three-way:
 * anything short of an exact normalised match returns `uncertain` and routes to a
 * human, rather than being silently passed or silently dropped.
 *
 * A prior naive substring implementation matched "ing" inside "Consulting" and
 * "Holding" and produced 1,427 false positives. Hence exact-match-on-normalised
 * plus explicit token-subset detection, never a raw `includes`.
 */

/** normalised name → the canonical registered name it came from. */
export type SponsorIndex = ReadonlyMap<string, string>;

export type SponsorVerdict = "sponsor" | "not-sponsor" | "uncertain";

export interface SponsorMatch {
  readonly verdict: SponsorVerdict;
  /** Canonical register name, present only on an exact match. */
  readonly registered_name?: string;
  /** Plausible register entries a human should disambiguate. */
  readonly candidates: readonly string[];
  readonly evidence: string;
}

/**
 * Dutch legal-form tokens, stripped only from the END of a name.
 *
 * Deliberately excludes "holding", "group" and "international": "Deeploy Holding"
 * is a genuinely different legal entity from "Deeploy", and collapsing them would
 * manufacture exactly the false positives this module exists to prevent.
 */
const LEGAL_SUFFIX_TOKENS = new Set(["b", "v", "n", "bv", "nv", "cv", "vof"]);

/** Tokens too generic to carry identity on their own. */
const GENERIC_TOKENS = new Set(["the", "and", "of", "company", "tech", "technologies"]);

/**
 * Lowercase, strip punctuation, drop trailing legal-form tokens, collapse spaces.
 * Idempotent: normalise(normalise(x)) === normalise(x).
 */
export function normaliseCompanyName(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  while (tokens.length > 1 && LEGAL_SUFFIX_TOKENS.has(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }
  return tokens.join(" ");
}

function identityTokens(normalised: string): string[] {
  return normalised.split(" ").filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t));
}

function isTokenSubset(inner: readonly string[], outer: readonly string[]): boolean {
  if (inner.length === 0) return false;
  const set = new Set(outer);
  return inner.every((t) => set.has(t));
}

/**
 * Decide whether a job ad's company name corresponds to a register entry.
 *
 * Exact normalised match → `sponsor`. Any partial overlap in either direction →
 * `uncertain` with candidates, because "ASML" could be either ASML entity and
 * "Adyen Consulting Group" is probably not Adyen at all. Everything else →
 * `not-sponsor`.
 */
export function matchSponsor(companyName: string, index: SponsorIndex): SponsorMatch {
  const normalised = normaliseCompanyName(companyName);

  if (normalised.length === 0) {
    return {
      verdict: "uncertain",
      candidates: [],
      evidence: "Empty or unparseable company name — cannot screen against the register.",
    };
  }

  const exact = index.get(normalised);
  if (exact) {
    return {
      verdict: "sponsor",
      registered_name: exact,
      candidates: [],
      evidence: `Exact register match: "${exact}" (normalised "${normalised}").`,
    };
  }

  const queryTokens = identityTokens(normalised);
  const candidates: string[] = [];

  for (const [key, registered] of index) {
    const keyTokens = identityTokens(key);
    if (isTokenSubset(queryTokens, keyTokens) || isTokenSubset(keyTokens, queryTokens)) {
      candidates.push(registered);
    }
  }

  if (candidates.length > 0) {
    return {
      verdict: "uncertain",
      candidates,
      evidence:
        `"${companyName}" partially overlaps ${candidates.length} register ` +
        `entry/entries (${candidates.slice(0, 3).join(", ")}). Needs a human check — ` +
        `a wrong guess here wastes an entire application.`,
    };
  }

  return {
    verdict: "not-sponsor",
    candidates: [],
    evidence:
      `"${companyName}" (normalised "${normalised}") is absent from the recognised-sponsor ` +
      `register. They cannot lawfully sponsor a highly skilled migrant permit.`,
  };
}

/** Build the lookup index from register rows. */
export function buildSponsorIndex(registeredNames: readonly string[]): SponsorIndex {
  const index = new Map<string, string>();
  for (const name of registeredNames) {
    const key = normaliseCompanyName(name);
    if (key.length > 0 && !index.has(key)) index.set(key, name);
  }
  return index;
}
