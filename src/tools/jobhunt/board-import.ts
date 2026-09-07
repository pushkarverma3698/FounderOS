/**
 * FounderOS — joining the IND sponsor register to published ATS board tokens
 * ==========================================================================
 * Which company job boards are worth polling? The previous answer was to GUESS:
 * derive a slug from a company name, hit four ATS domains with it, keep the 200s
 * (`scripts/probe-sponsor-boards.ts`). Measured against the 12.9k IND register
 * that returned a 0.36% hit rate on Greenhouse/Lever/Ashby, ~46 boards, and the
 * result never reached prod at all.
 *
 * This module answers it by JOIN instead. Open-source projects already publish
 * the company→token mappings the probe tries to rediscover — `kalil0321/ats-scrapers`
 * maintains one CSV per platform in `name,slug,url` form. Intersecting those with
 * the recognised-sponsor register is deterministic, costs nothing, needs no LLM,
 * and finds 4.4x more boards on the same three platforms than probing did.
 *
 * Everything here is PURE. The fetching, the live verification and the file write
 * live in `scripts/jobhunt-import-sponsor-boards.ts`, so the whole join contract
 * is unit-testable without a network or a filesystem — the same split as
 * free-boards.ts (parse) and free-ats-source.ts (poll).
 */

import type { BoardMarket, FreeAts, FreeBoard } from "./free-boards.js";
import { workdayTokenFromUrl } from "./adapters/workday.js";
import { LEGAL_SUFFIX_TOKENS } from "./sponsor-match.js";
import { parseCsvLine } from "./sponsor-registry.js";

/** One row of an upstream ATS corpus CSV (`name,slug,url`). */
export interface AtsCorpusRow {
  readonly name: string;
  readonly slug: string;
  /**
   * The board's public URL. Empty when the corpus omits it.
   *
   * Kept because Workday's `slug` is lossy: it reads `tenant/site` and drops the
   * datacenter, which is NOT derivable — the corpus carries at least ten distinct
   * values (wd1, wd3, wd5, wd12, wd103, wd501 …) and only this column says which.
   * Every other platform ignores it.
   */
  readonly url: string;
}

/**
 * One row of the curated NL finance-employer list
 * (`docs/strategy/data/nl-finance-employers.csv`).
 *
 * A second employer list exists for one measured reason. The IND register join
 * above is the right tool for tech: the register's names and the ATS corpora's
 * names agree often enough on Greenhouse/Lever/Ashby to have found 858 boards.
 * It is the wrong tool for Dutch finance, because the employers who hire FP&A,
 * audit and KYC at 0-4 years are registered under names no board ever writes —
 * `Coöperatieve Rabobank U.A.` against a Workday corpus row that says
 * `Rabobank`, `Deloitte Accountants` against `Deloitte Netherlands`. Both boards
 * were sitting in a corpus we already download, unmatched, on 2026-09-07.
 */
export interface EmployerBrand {
  readonly name: string;
  readonly sector: string;
}

/** A board the join proposes polling, before it has been verified live. */
export interface CandidateBoard {
  /**
   * The company name AS THE ATS CORPUS WRITES IT — never the IND register's.
   *
   * This is the single most important line in the module. `free-ats-mappers.ts`
   * sets `company: candidate.board.name`, so whatever lands in this field is what
   * `matchSponsor` later screens. Writing the registered name here ("Deliveroo
   * Netherlands B.V.") would make every posting on the board an EXACT register
   * match by construction — a confident `sponsor` verdict manufactured by our own
   * CSV rather than established from the posting. That is the failure the whole
   * three-way verdict exists to prevent, and it would fail silently.
   *
   * With the corpus name ("Deliveroo") the posting screens to `uncertain` with
   * `Deliveroo Netherlands B.V.` named as the candidate, and a human decides.
   */
  readonly name: string;
  readonly ats: FreeAts;
  readonly token: string;
  /**
   * What the join matched on — the IND register entry for `joinSponsorBoards`,
   * the curated brand for `joinEmployerBoards`. Reported, never written to the CSV.
   */
  readonly matchedSponsor: string;
}

/**
 * Tokens dropped from a name before comparing it, ON TOP of the trailing
 * legal-form tokens `normaliseCompanyName` already removes.
 *
 * These are the words a national register adds that a job board never does. The
 * IND lists "Deliveroo Netherlands B.V."; Ashby's board is "Deliveroo". Nine
 * companies out of ten in that shape — Stripe, Samsara, Airbnb, Datadog — are
 * lost to a country word alone.
 */
const CORPORATE_NOISE_TOKENS = new Set([
  ...["netherlands", "nederland", "holland"],
  ...["holding", "holdings", "group", "groep", "groupe"],
  ...["international", "europe", "european", "benelux"],
  ...["company", "the"],
]);

const MATCH_NOISE = new Set([...LEGAL_SUFFIX_TOKENS, ...CORPORATE_NOISE_TOKENS]);

/**
 * The key two names are compared on to decide whether to POLL a board.
 *
 * Deliberately looser than `normaliseCompanyName` in sponsor-match.ts, which
 * refuses to strip "holding" or "netherlands" because "Deeploy Holding" is a
 * different legal entity from "Deeploy". That strictness is right for a
 * SPONSORSHIP VERDICT and wrong for a POLLING DECISION, and the two are not the
 * same question:
 *
 *   - Being in this registry means "we send this URL one GET per sweep".
 *   - Being a sponsor is decided per posting, downstream, by the untouched
 *     `matchSponsor`, on the posting's own company name.
 *
 * So the cost of a loose match here is one wasted HTTP request, and its postings
 * still face the strict gate. The cost of being strict here is 130 real sponsor
 * boards never polled at all. Loose wins, but only because `name` above carries
 * the corpus name rather than the registered one.
 *
 * Unlike the sponsor normaliser, noise is stripped ANYWHERE in the name, not just
 * from the end ("Aleph The Netherlands Corporation B.V." → "aleph"). Never
 * reduces to empty: a name made entirely of noise keeps its original tokens, so
 * "The Company B.V." cannot collide with every other all-noise name.
 */
export function boardMatchKey(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const kept = tokens.filter((t) => !MATCH_NOISE.has(t));
  return (kept.length > 0 ? kept : tokens).join(" ");
}

/**
 * Parse one upstream corpus CSV (`name,slug,url`).
 *
 * Rows missing a name or a slug are SKIPPED rather than thrown on, for the same
 * reason `parseBoardRegistry` skips them: one malformed line in a 6,000-row
 * third-party file must not cost the other 5,999 their join.
 */
export function parseAtsCorpus(csv: string): AtsCorpusRow[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows: AtsCorpusRow[] = [];

  // Row 0 is the header (`name,slug,url`).
  for (const line of lines.slice(1)) {
    const [name, slug, url] = parseCsvLine(line);
    const trimmedName = (name ?? "").trim();
    const trimmedSlug = (slug ?? "").trim();
    if (trimmedName.length === 0 || trimmedSlug.length === 0) continue;
    rows.push({ name: trimmedName, slug: trimmedSlug, url: (url ?? "").trim() });
  }

  return rows;
}

/**
 * The registry token for one corpus row.
 *
 * Every platform but Workday stores the corpus slug verbatim. Workday packs
 * `tenant/wdN/site` because its slug alone cannot address a board — see
 * `workdayTokenFromUrl`. A row whose URL will not parse yields null and is
 * DROPPED by the join rather than written with a slug that would 404 on every
 * sweep forever: a dead token is worse than a missing one, because it reports as
 * a failing board rather than an absent company.
 */
export function tokenForCorpusRow(ats: FreeAts, row: AtsCorpusRow): string | null {
  if (ats !== "workday") return row.slug;
  return workdayTokenFromUrl(row.url);
}

/**
 * Build the register lookup. First entry wins a key collision, matching
 * `buildSponsorIndex`'s own rule so the two indexes never disagree about which
 * registered name is canonical for a given key.
 */
export function buildBoardMatchIndex(sponsorNames: readonly string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const name of sponsorNames) {
    const key = boardMatchKey(name);
    if (key.length > 0 && !index.has(key)) index.set(key, name);
  }
  return index;
}

/**
 * Intersect the register with one platform's corpus.
 *
 * Excludes anything already in the registry — the import is additive and must
 * never restate a hand-curated row, because curated data is trusted over an
 * auto-derived guess (the same precedence `getFreeBoards` applies).
 */
export function joinSponsorBoards(
  sponsorNames: readonly string[],
  corpora: ReadonlyMap<FreeAts, readonly AtsCorpusRow[]>,
  existing: readonly FreeBoard[],
): CandidateBoard[] {
  const index = buildBoardMatchIndex(sponsorNames);
  const seen = new Set(existing.map((b) => `${b.ats}:${b.token.toLowerCase()}`));
  const candidates: CandidateBoard[] = [];

  for (const [ats, rows] of corpora) {
    for (const row of rows) {
      const matchedSponsor = index.get(boardMatchKey(row.name));
      if (matchedSponsor === undefined) continue;

      const token = tokenForCorpusRow(ats, row);
      if (token === null) continue;

      const key = `${ats}:${token.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push({ name: row.name, ats, token, matchedSponsor });
    }
  }

  return candidates;
}

/**
 * Parse the curated employer list (`name,sector`, `#` comments allowed).
 *
 * Mirrors `parseSponsorCsv`'s tolerance rather than `parseAtsCorpus`'s blind
 * `slice(1)`: this file is hand-edited, so it carries a provenance comment block
 * above its header and must not lose its first employer to it.
 */
export function parseEmployerList(csv: string): EmployerBrand[] {
  const lines = csv
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0 && !l.startsWith("#"));
  const body = lines[0]?.startsWith("name,") === true ? lines.slice(1) : lines;

  const brands: EmployerBrand[] = [];
  for (const line of body) {
    const [name, sector] = parseCsvLine(line);
    const trimmed = (name ?? "").trim();
    if (trimmed.length === 0) continue;
    brands.push({ name: trimmed, sector: (sector ?? "").trim() || "unknown" });
  }
  return brands;
}

/**
 * Board tokens a brand match must not claim.
 *
 * `boardMatchKey` compares NAMES, and several tenants publish one name across
 * several country sites: the Workday corpus carries `Pwc` three times, for
 * `global_campus_careers`, `global_experienced_careers` and
 * `us_experienced_careers`. Nothing in the name distinguishes them, so the token
 * is the only place left to read the country from.
 *
 * Matched on path SEGMENTS and underscore/hyphen-delimited words, never as a bare
 * substring — `us` would otherwise reject `industries` and `aus` would reject
 * `causeway`. This is a cost filter, not a correctness one: a US board is live and
 * its postings would be discarded downstream on location anyway. It exists so a
 * sweep built to widen the DUTCH market does not spend a third of its requests
 * fetching Ohio.
 */
const OFF_MARKET_TOKEN_WORDS = new Set([
  ...["us", "usa", "uk", "ie", "ca", "au", "aus", "nz", "za", "in", "sg", "jp", "cn"],
  ...["america", "americas", "canada", "australia", "newzealand", "brasil", "brazil"],
  ...["india", "china", "japan", "singapore", "malaysia", "philippines", "africa"],
  ...["deutschland", "germany", "france", "espana", "italia", "polska", "nordic"],
]);

/**
 * Drop the trailing `(Site Name)` the Workday corpus appends to disambiguate one
 * tenant's several career sites.
 *
 * A tenant with two boards appears twice under the SAME brand, so the corpus
 * labels the second: `Nn Group` and `Nn Group (Wdexternal)`. That parenthetical
 * is a site slug, not part of the company's name, and keying on it cost the
 * registry NN Group's real Dutch board — verified live 2026-09-07:
 * `nngroup/wd3/external` answers with zero postings, while
 * `nngroup/wd3/wdexternal` answers with The Hague and Rotterdam, "Senior
 * Financial Control Specialist" first. The unlabelled row was the dead one.
 *
 * Applied to `joinEmployerBoards` ONLY. `joinSponsorBoards` has 858 boards of
 * measured history behind its current key, and widening that key is a different
 * change with its own numbers to produce — not a free rider on this one.
 */
export function stripSiteSuffix(name: string): string {
  const stripped = name.replace(/\s*\([^()]*\)\s*$/, "").trim();
  return stripped.length > 0 ? stripped : name;
}

export function isOffMarketToken(token: string): boolean {
  return token
    .toLowerCase()
    .split(/[/_\-.]+/)
    .some((word) => OFF_MARKET_TOKEN_WORDS.has(word));
}

/**
 * Intersect the curated employer list with the published ATS corpora.
 *
 * Exact `boardMatchKey` equality, deliberately — NOT the prefix or substring
 * match that would look more generous here. `boardMatchKey` already strips
 * `netherlands`/`nederland`/`holland`, so `Deloitte Netherlands` reduces to
 * `deloitte` and matches the brand exactly, while `Deloitte NZ` reduces to
 * `deloitte nz` and does not. A prefix match would take both, and quietly fill a
 * registry built to widen the Dutch market with New Zealand.
 *
 * Everything `joinSponsorBoards` guarantees still holds: `name` carries the
 * CORPUS's company name so no sponsorship verdict is manufactured, tokens already
 * in the registry are skipped, and a Workday row whose URL will not parse is
 * dropped rather than written dead.
 */
export function joinEmployerBoards(
  brands: readonly EmployerBrand[],
  corpora: ReadonlyMap<FreeAts, readonly AtsCorpusRow[]>,
  existing: readonly FreeBoard[],
): CandidateBoard[] {
  const index = new Map<string, string>();
  for (const brand of brands) {
    const key = boardMatchKey(brand.name);
    if (key.length > 0 && !index.has(key)) index.set(key, brand.name);
  }

  const seen = new Set(existing.map((b) => `${b.ats}:${b.token.toLowerCase()}`));
  const candidates: CandidateBoard[] = [];

  for (const [ats, rows] of corpora) {
    for (const row of rows) {
      const matchedBrand = index.get(boardMatchKey(stripSiteSuffix(row.name)));
      if (matchedBrand === undefined) continue;

      const token = tokenForCorpusRow(ats, row);
      if (token === null || isOffMarketToken(token)) continue;

      const key = `${ats}:${token.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push({ name: row.name, ats, token, matchedSponsor: matchedBrand });
    }
  }

  return candidates;
}

/** Quote a CSV field only when it needs it — matches parseCsvLine's contract. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Render candidates as registry rows.
 *
 * `markets` records where a board was SOURCED FROM, never where its postings are.
 * Defaults to NL. The country of a posting is still decided from the posting's
 * own location string.
 */
export function toBoardCsvRows(
  boards: readonly CandidateBoard[],
  market: BoardMarket = "NL",
): string[] {
  return boards.map((b) => `${csvField(b.name)},${b.ats},${csvField(b.token)},${market}`);
}
