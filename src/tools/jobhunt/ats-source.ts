/**
 * FounderOS — ATS job source
 * ==========================
 * Supply for the screening gates. Until this existed, every posting that reached
 * `screen_job` was pasted in by hand, which made the gates a calculator rather
 * than a pipeline.
 *
 * Source: `fantastic-jobs/career-site-job-listing-api` on Apify — an aggregator
 * over ~50 ATS platforms (Greenhouse, Lever, Workday, Personio, Recruitee…).
 * Chosen over every LinkedIn scraper for one decisive reason: `descriptionType:
 * "text"` returns the FULL posting body. The salary and language gates parse
 * that body, so a truncated description doesn't degrade them — it makes them
 * confidently wrong about evidence that was never there.
 *
 * WHAT IS DELIBERATELY *NOT* FILTERED AT SOURCE:
 *   · `aiVisaSponsorshipFilter` — an AI text heuristic over the posting. Our own
 *     sponsor gate reads the IND recognised-sponsor register (12,882 entries,
 *     authoritative). Most Dutch sponsors never write the word "visa" in a
 *     posting, so the heuristic would silently discard employers the register
 *     confirms. A weaker filter must never run ahead of a stronger one.
 *   · `hasSalary` — Dutch postings routinely omit salary. Requiring it at source
 *     would shrink supply to near zero; the salary gate already FLAGS a missing
 *     figure for a human, which is the loud direction.
 *   · `liOrganizationSizeFilter` — the feed CAN restrict to LinkedIn headcount
 *     buckets ("1", "2-10", … "10001+") and we deliberately send none of them,
 *     so every size from a two-person startup to a 10,000-seat enterprise is in
 *     scope. `FORBIDDEN_INPUT_KEYS` holds that open in CI — see the note on it
 *     for why a size filter is the wrong instrument here.
 *
 * WHAT *IS* FILTERED AT SOURCE (added 2026-08-01):
 *   · `titleExclusionSearch` — unambiguous early-career terms. The feed bills per
 *     job returned, and on 2026-08-01 a quarter of the day's budget was spent
 *     fetching an internship and a graduate scheme only to discard both. Only
 *     terms that are safe as a SUBSTRING go upstream; see
 *     SOURCE_EXCLUDED_TITLE_TERMS.
 *
 * Network lives in one function. Everything else here is pure and unit-tested.
 */

import { childLogger } from "../../infra/logger.js";
import { runActorSync } from "../apify.js";
import { SOURCE_EXCLUDED_TITLE_TERMS } from "./seniority.js";
import { detectFeedError, mapAtsItems } from "./ats-mappers.js";
import { titlesForTracks, TRACK_PRIORITY } from "./tracks.js";

const log = childLogger({ module: "jobhunt:ats-source" });

/** Apify uses `~` instead of `/` in REST paths. */
export const ATS_ACTOR = "fantastic-jobs~career-site-job-listing-api";

/**
 * Just under Apify's 300s sync ceiling (it returns HTTP 408 beyond that).
 * Measured: a 10-job run took 216s on 2026-07-29, so 180s was too tight and
 * would have looked exactly like an empty market.
 */
const ATS_TIMEOUT_MS = 290_000;

/** The actor rejects a limit below 10, so 10 is the floor as well as our budget. */
export const MIN_ATS_LIMIT = 10;

export interface AtsQuery {
  /** 1h | 24h | 7d | 6m. The daily sweep uses 24h so runs don't overlap. */
  readonly timeRange?: "1h" | "24h" | "7d" | "6m";
  readonly limit?: number;
  /** Exact "City, Region, Country" phrases, or a bare country. */
  readonly locations?: readonly string[];
  /** Title phrases; `:*` is the actor's prefix wildcard. */
  readonly titles?: readonly string[];
  readonly experienceLevels?: readonly string[];
  /** Restrict to specific employers — how the IND register becomes a target list. */
  readonly organizations?: readonly string[];
  /** Which work arrangements to accept. Omit for all. */
  readonly workArrangements?: readonly WorkArrangement[];
  /**
   * Drop `locationSearch` from the request entirely.
   *
   * Not the same as passing no locations, which falls back to the default. The
   * feed documents that jobs with a null `locations_derived` exist and that
   * combining them with a location search "would always return zero rows" — so a
   * globally-remote posting with no city is UNREACHABLE while any location
   * filter is set. Pool C exists to find exactly those.
   */
  readonly omitLocation?: boolean;
}

/** The feed's own vocabulary. "Remote OK" has an office; "Remote Solely" has none. */
export type WorkArrangement = "On-site" | "Hybrid" | "Remote OK" | "Remote Solely";

export interface RawPosting {
  readonly company: string;
  readonly title: string;
  readonly url: string;
  readonly description: string;
  readonly location: string;
  readonly postedAt: Date | null;
  /**
   * Which feed produced it. Recorded rather than inferred, because the two
   * sources do not deserve equal trust: an aggregator row can be a repost, an
   * agency listing, or a job filled a month ago.
   */
  readonly source?: string;
  /** Source-native id. Indeed's job key is what the liveness lookup needs. */
  readonly externalId?: string;
}

export type AtsFetch =
  | { readonly ok: true; readonly postings: readonly RawPosting[] }
  | { readonly ok: false; readonly error: string };

// ── Defaults: the campaign's actual target profile ───────────────────────────

export const DEFAULT_TITLES: readonly string[] = titlesForTracks(TRACK_PRIORITY);

export const DEFAULT_LOCATIONS: readonly string[] = ["Netherlands"];

/**
 * 0-2 and 2-5. `5-10` and `10+` stay out.
 *
 * `5-10` was added on 2026-07-31 on the argument that the permit's under-30
 * salary band is HSM reasoning which does not bind on a partner permit or a
 * remote contract. That argument was about the PERMIT and ignored the hiring
 * manager: on 2026-08-01 the founder's verdict on seeing a "Senior Platform
 * Engineer" in his brief was "no one will give a job to a 3 year or 4 year of
 * experience while applying for platform engineer". He is right — the permit
 * allowing a role does not mean a shortlist would.
 *
 * This is a COST filter, not the guarantee. The feed's band is an AI-inferred
 * label and it is wrong often enough that some 5+ year roles still arrive; the
 * `Experience` gate (experience.ts) is what actually rejects them, on the years
 * the employer wrote down, and every one of those rejects is stored and shown.
 */
export const DEFAULT_EXPERIENCE: readonly string[] = ["0-2", "2-5"];

// ── Source pools ──────────────────────────────────────────────────────────────

/**
 * Three permit bases reach three different markets, and one query only ever
 * served the first.
 *
 * The split uses the feed's own work-arrangement vocabulary rather than an
 * approximation of it: "Remote OK" means remote WITH an office (so the employer
 * has a Dutch presence, and an NL permit is in play), while "Remote Solely"
 * means no office at all (so there is nothing to relocate to, and only a remote
 * contract applies).
 */
export type SourcePool = "netherlands" | "eu-remote-global";

export const POOL_QUERIES: Record<SourcePool, AtsQuery> = {
  /**
   * Every Netherlands role, whatever the desk arrangement.
   *
   * Was TWO queries until 2026-08-01 — `nl-onsite` (On-site + Hybrid) and
   * `nl-remote` (Remote OK) — which differed in exactly one field:
   * `aiWorkArrangementFilter`. Both carried `locationSearch: ["Netherlands"]`,
   * both ran once per track, and both were billed a separate actor start every
   * day. Four wasted starts a day buying a distinction we can make for free
   * from the work-arrangement field the feed already returns on every posting.
   *
   * Merging them is the founder's own instruction ("Do not waste the costs and
   * credits") applied to the cheapest available saving: 12 ATS runs per sweep
   * become 8, with identical coverage.
   */
  netherlands: { workArrangements: ["On-site", "Hybrid", "Remote OK"] },
  /**
   * Office-less remote roles, location filter deliberately dropped (see
   * `omitLocation`). Scoped to EU employers downstream, not here: a US company
   * hiring a contractor in India is income, not a step toward the Netherlands.
   *
   * CANNOT be merged into the pool above, and the reason is not stylistic: it
   * omits `locationSearch` entirely. A posting with a null `locations_derived`
   * is unreachable while ANY location filter is set, per the feed's own docs, so
   * folding this into the Netherlands query would silently return zero of them.
   */
  "eu-remote-global": { workArrangements: ["Remote Solely"], omitLocation: true },
};

export const POOL_ORDER: readonly SourcePool[] = ["netherlands", "eu-remote-global"];

/**
 * Feed parameters that must NEVER appear in a request, and why.
 *
 * The founder's instruction on 2026-08-01 was to open the pool to mid-sized
 * companies and startups. The honest finding is that nothing was closing it —
 * no size filter was ever sent — so the fix belongs in the title vocabulary
 * (see TRACK_TITLES), not here.
 *
 * This list exists to keep it that way. A headcount filter is a tempting knob
 * and the wrong instrument in both directions: capping size to "find startups"
 * would discard the recognised sponsors that make the HSM basis work, and
 * flooring it to "find sponsors" would discard exactly the scale-ups most likely
 * to hire remotely and interview fast. Company size is not what makes a role
 * reachable — the permit basis is, and that is already screened per posting.
 *
 * Asserted in tests/unit/jobhunt/source-pools.test.ts so a future edit that adds
 * one has to delete this note first.
 */
export const FORBIDDEN_INPUT_KEYS: readonly string[] = [
  "liOrganizationSizeFilter",
  "liOrganizationEmployeesLte",
  "liOrganizationEmployeesGte",
];

/**
 * Build the actor input. Pure — the daily sweep, a manual run and the tests all
 * produce byte-identical input for the same query, which is what makes a
 * surprising result attributable to the market rather than to the request.
 */
export function buildAtsInput(query: AtsQuery = {}): Record<string, unknown> {
  return {
    timeRange: query.timeRange ?? "24h",
    limit: Math.max(MIN_ATS_LIMIT, query.limit ?? MIN_ATS_LIMIT),
    descriptionType: "text",
    // Omitted entirely for pool C — a null-location posting is unreachable while
    // any location filter is set, per the feed's own `hasNoLocation` docs.
    ...(query.omitLocation
      ? {}
      : { locationSearch: [...(query.locations ?? DEFAULT_LOCATIONS)] }),
    titleSearch: [...(query.titles ?? DEFAULT_TITLES)],
    // Costs nothing to send and saves a job's price for every intern or graduate
    // scheme the broad title phrases would otherwise vacuum in. Only the terms
    // that are unambiguous as a substring — the rest are caught client-side by
    // `excludeEarlyCareer`, where a drop is word-boundary matched and counted.
    titleExclusionSearch: [...SOURCE_EXCLUDED_TITLE_TERMS],
    aiExperienceLevelFilter: [...(query.experienceLevels ?? DEFAULT_EXPERIENCE)],
    ...(query.workArrangements && query.workArrangements.length > 0
      ? { aiWorkArrangementFilter: [...query.workArrangements] }
      : {}),
    ...(query.organizations && query.organizations.length > 0
      ? { organizationSearch: [...query.organizations] }
      : {}),
    // Agencies re-post other companies' roles under their own name, which
    // defeats both the dedupe key and the sponsor gate (the agency is not the
    // sponsoring employer).
    removeAgency: true,
    includeCompanyDetails: true,
  };
}

// ── Network ───────────────────────────────────────────────────────────────────

/**
 * Run the actor and map its dataset. Never throws.
 *
 * There is deliberately NO fallback to web search. A search snippet through the
 * salary gate is worse than no posting at all: it looks like supply and produces
 * verdicts from evidence that was never fetched. Zero postings with a stated
 * reason is the honest outcome.
 */
export async function fetchAtsPostings(query: AtsQuery = {}): Promise<AtsFetch> {
  const input = buildAtsInput(query);
  const run = await runActorSync(ATS_ACTOR, input, ATS_TIMEOUT_MS);
  if (!run.ok) {
    log.warn({ error: run.error }, "ATS fetch failed");
    return { ok: false, error: run.error };
  }
  const postings = mapAtsItems(run.items);

  // An in-band upstream error only counts as a failure when it produced no
  // usable postings — a partial run that still returned jobs is worth screening.
  const feedError = detectFeedError(run.items);
  if (feedError && postings.length === 0) {
    log.warn({ feedError }, "ATS feed reported an upstream error");
    return { ok: false, error: `ATS feed upstream error: ${feedError}` };
  }

  log.info({ returned: run.items.length, usable: postings.length }, "ATS fetch complete");
  return { ok: true, postings };
}
