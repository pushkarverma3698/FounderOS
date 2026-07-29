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
 *
 * Token subsets alone then overshot the other way. 3,381 register entries reduce
 * to a single identity token, and many of those tokens are category words rather
 * than names ("netherlands" in 1,002 entries, "systems" in 123). So "Analytics in
 * HR B.V." was inherited as a candidate by every company with "Analytics" in its
 * name, and 44.7% of real company names came back `uncertain` — a queue the
 * founder cannot read. The fix is in `matchSponsor`: the direction where a
 * register entry sits INSIDE a longer ad name now requires the entry to be
 * identifying. Measured on the real register: real names 44.7% → 23.7%
 * uncertain, unrelated-name noise 53% → ~0%, with recall on abbreviated register
 * names unchanged (97% still uncertain, none newly rejected).
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
 * How many register entries a token may appear in and still count as an identity.
 *
 * Measured, not guessed (`scripts/jobhunt-sponsor-uncertain-rate.ts`): 10 is ~0.08%
 * of the ~12.9k register and sits at the knee. At 25 the noise returns ("analytics"
 * slips back in); at 3 the false-negative rate on real register entries doubles,
 * 0.73% → 1.30%, for no measurable gain in precision.
 */
const MAX_IDENTIFYING_ENTRIES = 10;

/**
 * token → how many register entries carry it. Derived from the index rather than
 * a hand-kept stopword list, so it tracks the register as it is re-scraped each
 * month. Memoised per index: one O(entries) pass, and the index itself is built
 * once per process (`sponsor-registry.ts`).
 */
const frequencyCache = new WeakMap<SponsorIndex, ReadonlyMap<string, number>>();

function tokenFrequency(index: SponsorIndex): ReadonlyMap<string, number> {
  const memo = frequencyCache.get(index);
  if (memo) return memo;

  const frequency = new Map<string, number>();
  for (const key of index.keys()) {
    for (const token of new Set(identityTokens(key))) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  frequencyCache.set(index, frequency);
  return frequency;
}

/**
 * Does this register entry actually name a company, as opposed to describing a
 * category? Two words are an identity even when both are common ("Systems Alpha");
 * one word is an identity only when few other entries share it.
 */
function isIdentifying(tokens: readonly string[], frequency: ReadonlyMap<string, number>): boolean {
  if (tokens.length >= 2) return true;
  return tokens.some((t) => (frequency.get(t) ?? 0) <= MAX_IDENTIFYING_ENTRIES);
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
  const frequency = tokenFrequency(index);
  const candidates: string[] = [];

  for (const [key, registered] of index) {
    const keyTokens = identityTokens(key);

    // The ad gives less name than the register does ("ASML" for "ASML Netherlands
    // B.V."). Abbreviation is how postings normally write employers, so this
    // direction stays wide open — it is the recall path.
    if (isTokenSubset(queryTokens, keyTokens)) {
      candidates.push(registered);
      continue;
    }

    // The register entry sits inside a longer ad name ("Analytics in HR B.V."
    // inside "Kwyjibo Analytics"). Only meaningful when the entry names a company;
    // a lone category word here is a coincidence, not a lead.
    if (isTokenSubset(keyTokens, queryTokens) && isIdentifying(keyTokens, frequency)) {
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
