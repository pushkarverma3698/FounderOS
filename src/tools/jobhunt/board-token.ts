/**
 * FounderOS — extracting a free-board token from a posting URL
 * ==============================================================
 * The paid ATS/Indeed sweep sees postings from thousands of companies it never
 * queries the free lane for by name. Every one of those postings' URLs is
 * itself evidence: if it points at a Greenhouse/Lever/Ashby/Recruitee board,
 * that company can be polled directly, for nothing, forever — the free lane
 * grows even though this sweep only runs every third day.
 *
 * Regexes measured against 209 real production posting URLs (2026-08-20). The
 * naive `boards.greenhouse.io` / `jobs.lever.co` forms only matched 74/209 —
 * the missing 135 were the `job-boards.greenhouse.io` and `.eu.` regional
 * variants both platforms also serve traffic from.
 */

import type { BoardMarket, FreeAts } from "./free-boards.js";

export interface ExtractedBoardToken {
  readonly ats: FreeAts;
  readonly token: string;
}

export interface DiscoveredBoard {
  readonly name: string;
  readonly ats: FreeAts;
  readonly token: string;
  readonly markets: readonly BoardMarket[];
}

/**
 * A posting shape loose enough to come straight from `RawPosting` without
 * this module depending on ats-source.ts — kept structural on purpose so the
 * harvest logic stays pure and testable with plain fixtures.
 */
export interface HarvestableSighting {
  readonly url: string | null | undefined;
  readonly company: string;
  readonly country?: "NL" | "IN" | "other" | "unknown" | null;
}

interface TokenPattern {
  readonly ats: FreeAts;
  readonly re: RegExp;
}

/**
 * Ordered by how the group is captured: the first three pull a PATH segment
 * (the token comes after the host); Recruitee pulls the SUBDOMAIN itself.
 *
 * Recruitee tokens are only recoverable when the URL is the platform's own
 * `<token>.recruitee.com` domain. A white-labelled custom domain (verified
 * live 2026-08-20: `werkenbijdalsem.nl/o/...` for the `dalsem` board) carries
 * no token at all — a real ceiling on this mechanism, not a bug to chase.
 */
const PATTERNS: readonly TokenPattern[] = [
  { ats: "greenhouse", re: /^https?:\/\/(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/i },
  { ats: "lever", re: /^https?:\/\/jobs(?:\.eu)?\.lever\.co\/([^/?#]+)/i },
  { ats: "ashby", re: /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)/i },
  { ats: "recruitee", re: /^https?:\/\/([a-z0-9-]+)\.recruitee\.com(?:\/|$|\?)/i },
  { ats: "smartrecruiters", re: /^https?:\/\/jobs\.smartrecruiters\.com\/([^/?#]+)/i },
  // The `/j/` segment is REQUIRED, not decoration. Workable also serves
  // `apply.workable.com/j/<id>` with no account in the path; without this the
  // capture group takes the literal "j" and registers a board called `j` that
  // polls nothing forever.
  { ats: "workable", re: /^https?:\/\/apply\.workable\.com\/([^/?#]+)\/j\//i },
  // Both hosts, because Personio serves the same board from `.com` and `.de` and
  // a sponsor's posting can reach us as either. The token is the SUBDOMAIN, like
  // Recruitee — and `jobs` is excluded so the bare `jobs.personio.com` marketing
  // host cannot register a board called `jobs` that polls nothing forever, the
  // same defect the Workable `/j/` segment exists to prevent.
  {
    ats: "personio",
    re: /^https?:\/\/(?!jobs\.)([a-z0-9-]+)\.jobs\.personio\.(?:com|de)(?:\/|$|\?)/i,
  },
];

/**
 * Pull `{ ats, token }` out of a posting URL, or null when it points at
 * nothing we can poll directly (a company's own site, an aggregator, an ATS
 * we don't have a free-board mapper for).
 *
 * Pure and total — never throws on a malformed or empty string, because this
 * runs across every posting a sweep fetches and one bad URL must not cost the
 * rest their harvest.
 */
export function extractBoardToken(url: string): ExtractedBoardToken | null {
  if (typeof url !== "string" || url.trim().length === 0) return null;

  for (const { ats, re } of PATTERNS) {
    const match = url.match(re);
    const raw = match?.[1];
    if (!raw) continue;
    try {
      const token = decodeURIComponent(raw);
      if (token.length === 0) continue;
      return { ats, token };
    } catch {
      // Malformed percent-encoding — treat as no match rather than throw.
      continue;
    }
  }
  return null;
}

/**
 * Find boards worth adding to the free registry among a batch of postings —
 * a rejected posting donates its token exactly like a passing one, since a
 * company's board is worth polling forever regardless of what any one of its
 * postings screened as (founder direction, 2026-08-20: harvest at the fetch
 * boundary, not after screening).
 *
 * Pure: takes what is already known so the caller decides freshness, and
 * returns what to write rather than writing it — this runs once per pool per
 * sweep and the caller batches every pool's result into one file write,
 * because appending per-posting would re-parse the whole registry on every
 * single discovery.
 */
export function harvestNewBoardTokens(
  postings: readonly HarvestableSighting[],
  alreadyKnown: ReadonlySet<string>,
): DiscoveredBoard[] {
  const found = new Map<string, DiscoveredBoard>();

  for (const posting of postings) {
    if (!posting.url) continue;
    const extracted = extractBoardToken(posting.url);
    if (!extracted) continue;

    const key = `${extracted.ats}:${extracted.token}`;
    if (alreadyKnown.has(key) || found.has(key)) continue;

    found.set(key, {
      name: posting.company,
      ats: extracted.ats,
      token: extracted.token,
      // Only a POSITIVE NL/IN carries through — "other" or "unknown" writes
      // an empty markets column rather than defaulting to NL, the exact
      // defect that filed every unclassified company as Dutch in an earlier
      // draft of this harvester.
      markets: posting.country === "NL" || posting.country === "IN" ? [posting.country] : [],
    });
  }

  return [...found.values()];
}
