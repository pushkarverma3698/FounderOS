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
 *
 * Network lives in one function. Everything else here is pure and unit-tested.
 */

import { childLogger } from "../../infra/logger.js";
import { runActorSync } from "../apify.js";

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

/** Bound a stored posting body. Long enough for every real posting. */
const DESCRIPTION_MAX = 20_000;

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
}

export type AtsFetch =
  | { readonly ok: true; readonly postings: readonly RawPosting[] }
  | { readonly ok: false; readonly error: string };

// ── Defaults: the campaign's actual target profile ───────────────────────────

/**
 * The three tracks Pushkar applies for (founder direction, 2026-07-31).
 *
 * Frontend is the deepest track on his CV — three years of production React and
 * Next.js — and until now it was not searched at all, so the pipeline could not
 * have surfaced the roles he is most obviously qualified for.
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
 * Priority order. This is NOT cosmetic: the sweep fetches roughly 10 postings a
 * day, so whichever titles the feed matches first spend the budget. AI leads
 * because it is the stated priority; frontend trails because those roles are the
 * easiest to find by hand if the budget runs out.
 */
export const TRACK_PRIORITY: readonly RoleTrack[] = ["ai", "backend", "frontend"];

/** Titles for the given tracks, in priority order, de-duplicated. */
export function titlesForTracks(tracks: readonly RoleTrack[]): string[] {
  const ordered = TRACK_PRIORITY.filter((t) => tracks.includes(t));
  return [...new Set(ordered.flatMap((t) => TRACK_TITLES[t]))];
}

export const DEFAULT_TITLES: readonly string[] = titlesForTracks(TRACK_PRIORITY);

export const DEFAULT_LOCATIONS: readonly string[] = ["Netherlands"];

/**
 * 0-2 through 5-10. `10+` stays out: a posting at that level screening as PASS
 * is a role he would not be shortlisted for, which wastes the day's budget.
 *
 * `5-10` was previously excluded on the grounds that the permit's under-30
 * salary band is the cheaper hire. That is HSM reasoning, and it only binds
 * under HSM. Under a partner permit or a remote contract there is no band to
 * stay under and a senior role simply pays more — so the old default capped the
 * ceiling for two of the three live bases.
 */
export const DEFAULT_EXPERIENCE: readonly string[] = ["0-2", "2-5", "5-10"];

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
export type SourcePool = "nl-onsite" | "nl-remote" | "eu-remote-global";

export const POOL_QUERIES: Record<SourcePool, AtsQuery> = {
  /** On-site and hybrid roles in NL — the classic sponsored relocation. */
  "nl-onsite": { workArrangements: ["On-site", "Hybrid"] },
  /** Remote roles at employers with a Dutch office — lawful under HSM or a partner permit. */
  "nl-remote": { workArrangements: ["Remote OK"] },
  /**
   * Office-less remote roles, location filter deliberately dropped (see
   * `omitLocation`). Scoped to EU employers downstream, not here: a US company
   * hiring a contractor in India is income, not a step toward the Netherlands.
   */
  "eu-remote-global": { workArrangements: ["Remote Solely"], omitLocation: true },
};

export const POOL_ORDER: readonly SourcePool[] = ["nl-onsite", "nl-remote", "eu-remote-global"];

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

// ── Pure mappers ──────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** First non-empty string among the candidates, else "". */
function firstString(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "";
}

/** First non-empty entry of a string array field, else "". */
function firstOfArray(value: unknown): string {
  if (!Array.isArray(value)) return "";
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) return entry.trim();
    const asObj = asRecord(entry);
    const nested = firstString(asObj["name"], asObj["locality"], asObj["region"], asObj["country"]);
    if (nested.length > 0) return nested;
  }
  return "";
}

/** Already carries a zone: trailing Z, or ±HH:MM / ±HHMM after the time part. */
const HAS_TIMEZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse a feed timestamp as UTC.
 *
 * The feed emits "2026-07-29T05:08:47" with no zone, and the actor's own docs
 * state the posted date/time is UTC. `new Date(...)` on a bare datetime uses the
 * HOST's timezone, so the developer machine (UTC+5:30) and the production VPS
 * (UTC) would store different `posted_at` values for the identical posting —
 * a discrepancy that only ever shows up as an unexplained off-by-one day.
 */
function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const raw = value.trim();
  const normalised = HAS_TIMEZONE.test(raw) ? raw : `${raw}Z`;
  const d = new Date(normalised);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Strip a trailing location suffix from a job title.
 *
 * Observed on the live feed (2026-07-29): Speechify posted ONE role as four
 * items — "…Data Infrastructure & Acquisition - Utrecht, Netherlands",
 * "… - Rotterdam, Netherlands", "… - The Hague, Netherlands", and so on.
 *
 * The dedupe key is company + normalised title, so those read as four distinct
 * roles. The soft key doesn't catch them either, because the city tokens differ.
 * Left alone, a 10-posting daily budget gets spent screening the same job
 * repeatedly and the tracker reports a pipeline that does not exist.
 *
 * Only a suffix that actually matches the posting's own derived location is
 * removed — "Engineer - Payments" keeps its suffix, because "Payments" is not
 * where the job is.
 */
export function stripLocationSuffix(title: string, location: string): string {
  const locationTokens = new Set(
    location
      .toLowerCase()
      .split(/[,/]/)
      .map((p) => p.trim())
      .filter((p) => p.length > 1),
  );
  if (locationTokens.size === 0) return title.trim();

  const match = title.match(/^(.*?)[\s]*[-–—(]\s*([^-–—()]+)\)?\s*$/);
  const head = match?.[1]?.trim();
  const tail = match?.[2]?.trim().toLowerCase();
  if (!head || !tail || head.length === 0) return title.trim();

  // Every comma-separated part of the suffix must be part of this job's location.
  const tailParts = tail.split(",").map((p) => p.trim()).filter((p) => p.length > 1);
  if (tailParts.length === 0) return title.trim();
  const isLocationSuffix = tailParts.every((p) => locationTokens.has(p));

  return isLocationSuffix ? head : title.trim();
}

/**
 * An upstream failure reported INSIDE a successful run, if there is one.
 *
 * This is not hypothetical. On 2026-07-29 the actor exited 0 after 216s having
 * written a single item: `{ error: "Failed to fetch data after 5 attempts: API
 * request failed with status 521" }`. The run succeeded; the feed was down.
 *
 * Without this check that item maps to zero postings and the sweep reports "0
 * postings — a narrow market, not a fault", which is a confident, wrong finding
 * about the Dutch job market derived from a Cloudflare error. An outage must
 * read as an outage.
 */
export function detectFeedError(items: readonly unknown[]): string | null {
  for (const raw of items) {
    const err = asRecord(raw)["error"];
    if (typeof err === "string" && err.trim().length > 0) return err.trim();
  }
  return null;
}

/**
 * Map dataset items → RawPosting[]. Defensive about field names on purpose:
 * the feed spans ~50 ATS platforms and the aggregator's own enrichment fields
 * come and go between builds.
 *
 * A posting with no description is DROPPED, not passed through. The gates parse
 * the body; screening an empty body would produce a verdict from no evidence,
 * which is the one failure mode this pipeline exists to prevent.
 */
export function mapAtsItems(items: readonly unknown[]): RawPosting[] {
  const postings: RawPosting[] = [];
  for (const raw of items) {
    const item = asRecord(raw);
    const org = asRecord(item["organization"]);

    const company = firstString(
      item["organization"],
      org["name"],
      item["organization_name"],
      item["company"],
      item["employer_name"],
    );
    const title = firstString(item["title"], item["job_title"], item["name"]);
    const description = firstString(
      item["description_text"],
      item["description"],
      item["job_description"],
    ).slice(0, DESCRIPTION_MAX);

    if (company.length === 0 || title.length === 0 || description.length === 0) continue;

    const location = firstString(
      firstOfArray(item["locations_derived"]),
      firstOfArray(item["locations_raw"]),
      item["location"],
      firstOfArray(item["cities_derived"]),
      firstOfArray(item["countries_derived"]),
    );

    postings.push({
      company,
      title: stripLocationSuffix(title, location),
      url: firstString(item["url"], item["job_url"], item["apply_url"], item["source_url"]),
      description,
      location,
      postedAt: parseDate(item["date_posted"] ?? item["datePosted"] ?? item["date_created"]),
    });
  }
  return postings;
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
