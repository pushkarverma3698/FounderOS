/**
 * FounderOS — Indeed job source
 * =============================
 * The BREADTH source. The ATS feed reads ~175k company career sites directly and
 * is the higher-trust supply; Indeed is an aggregator, so it sees roles that
 * never reach an ATS the feed covers — but it also carries agency reposts,
 * duplicates of ATS jobs, and ghost postings that were filled weeks ago.
 *
 * The two are therefore NOT merged into one undifferentiated stream. Every row
 * records which feed produced it, and an Indeed-only row does not reach the
 * brief's DO TODAY list without passing liveness verification (liveness.ts).
 *
 * Actor: `kaix/indeed-scraper`, $0.00005/job ($0.06 per 1,000) across 54
 * countries including NL and IN. At 30/day it costs ~$0.05/month, so cost played
 * no part in this choice — coverage did.
 *
 * TWO CONSTRAINTS THE ACTOR IMPOSES, both load-bearing:
 *   · `fromDays` cannot be combined with the `remote` filter. Remote queries
 *     therefore sort by date and bound recency on our side.
 *   · `basic` search mode returns less body text than `detailed`. The salary and
 *     language gates parse the body, so a truncated description does not degrade
 *     them — it makes them confidently wrong about evidence that was never
 *     fetched. We request `detailed` and DROP anything still too short.
 */

import { childLogger } from "../../infra/logger.js";
import { runActorSync } from "../apify.js";
import type { RawPosting } from "./ats-source.js";
import { TRACK_PRIORITY, TRACK_TITLES, type RoleTrack } from "./tracks.js";

const log = childLogger({ module: "jobhunt:indeed-source" });

/** Apify uses `~` instead of `/` in REST paths. */
export const INDEED_ACTOR = "kaix~indeed-scraper";

/** Well under Apify's 300s sync ceiling, which returns HTTP 408 beyond it. */
const INDEED_TIMEOUT_MS = 280_000;

/** Bound a stored posting body, matching the ATS source. */
const DESCRIPTION_MAX = 20_000;

/**
 * A body shorter than this is a search snippet, not a posting.
 *
 * The gates read the body for salary figures and Dutch-language requirements.
 * Neither appears in a 200-character teaser, so screening one produces "no
 * salary stated" and "language unstated" — two flags derived from text that was
 * never retrieved. Dropping is the honest outcome; the count is reported.
 */
export const MIN_DESCRIPTION_CHARS = 400;

/** Indeed country codes the campaign uses. NL for pool B, IN for pool C. */
export type IndeedCountry = "NL" | "IN";

export interface IndeedQuery {
  readonly country: IndeedCountry;
  readonly tracks?: readonly RoleTrack[];
  readonly limit?: number;
  /** "remote" | "hybrid" — cannot be combined with `fromDays` (actor constraint). */
  readonly remote?: "remote" | "hybrid";
  /** Drop postings older than this. Applied by us, not by the actor. */
  readonly maxAgeDays?: number;
  readonly location?: string;
}

export interface IndeedPosting extends RawPosting {
  /** Indeed's own job key — the handle the liveness lookup needs. */
  readonly jobKey: string;
}

export type IndeedFetch =
  | {
      readonly ok: true;
      readonly postings: readonly IndeedPosting[];
      /** Rows dropped for an unusably short body — reported, never hidden. */
      readonly droppedThin: number;
      /** Rows whose shape we could not read — the schema-drift alarm. */
      readonly droppedUnmappable: number;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Build Indeed's advanced-search string from the campaign's track titles.
 *
 * `title:("A" or "B")` restricts matching to the TITLE. Indeed's plain keyword
 * search is broad by design and would return "Sales Engineer" for "AI Engineer",
 * which then spends the day's budget on postings no gate can salvage.
 */
export function buildKeywordQuery(tracks: readonly RoleTrack[] = TRACK_PRIORITY): string {
  const ordered = TRACK_PRIORITY.filter((t) => tracks.includes(t));
  const phrases = [
    ...new Set(ordered.flatMap((t) => TRACK_TITLES[t].map((p) => p.replace(/:\*$/, "")))),
  ];
  if (phrases.length === 0) return "";
  const titles = phrases.map((p) => `"${p}"`).join(" or ");
  // Internships cannot carry any of the three permit bases, so excluding them at
  // source is not a preference — it is removing rows that are void by definition.
  return `title:(${titles}) -intern -internship -stage`;
}

/**
 * Build the actor input. Pure, so the daily sweep, a manual run and the tests
 * all produce byte-identical input for the same query.
 */
export function buildIndeedInput(query: IndeedQuery): Record<string, unknown> {
  return {
    keyword: buildKeywordQuery(query.tracks),
    country: query.country,
    ...(query.location ? { location: query.location } : {}),
    maxItems: query.limit ?? 20,
    // `detailed` over `basic`: the gates need the body, not a teaser.
    searchMode: "detailed",
    // Date order is not cosmetic here. `fromDays` is unavailable whenever the
    // remote filter is set, so recency has to come from the sort plus a
    // client-side age cut — otherwise a remote query returns 2024 postings.
    sort: "date",
    ...(query.remote ? { remote: query.remote } : {}),
    proxyConfig: { useApifyProxy: true },
  };
}

/** Look up specific postings by job key — the liveness path, not a search. */
export function buildJobKeyInput(jobKeys: readonly string[]): Record<string, unknown> {
  return {
    jobKeys: [...jobKeys],
    country: "NL",
    searchMode: "basic",
    proxyConfig: { useApifyProxy: true },
  };
}

// ── Pure mappers ──────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function firstString(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "";
}

function parseDate(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Indeed emits epoch milliseconds on some fields and seconds on others.
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface MappedIndeed {
  readonly postings: readonly IndeedPosting[];
  readonly droppedThin: number;
  /**
   * Rows we could not read at all — no title, company or job key anywhere.
   *
   * Distinct from `droppedThin` on purpose. A thin row is a real posting we
   * refuse to screen; an unmappable row means the actor's shape is not the shape
   * we parse, and the correct response is to fix the mapper, not to conclude the
   * market is empty. Keeping them in one counter hides a schema change behind a
   * plausible-looking number.
   */
  readonly droppedUnmappable: number;
}

/**
 * Map dataset items → IndeedPosting[].
 *
 * The actor nests almost everything (`title.text`, `company.name`,
 * `description.text`, `urls.indeed`, `dates.posted`, `signals.isExpired`) and
 * publishes no output schema. The nested reads come FIRST and the flat names
 * remain as fallbacks: on 2026-07-31 this mapper was flat-only and returned 0
 * usable rows from 20 — silently, because an empty list is indistinguishable
 * from a quiet market.
 *
 * A malformed row is skipped, never thrown on. Every skip is counted.
 */
export function mapIndeedItems(
  items: readonly unknown[],
  opts: { maxAgeDays?: number; now?: Date } = {},
): MappedIndeed {
  const postings: IndeedPosting[] = [];
  const now = opts.now ?? new Date();
  let droppedThin = 0;
  let droppedUnmappable = 0;

  for (const raw of items) {
    const item = asRecord(raw);
    const signals = asRecord(item["signals"]);

    // An expired posting is not supply. Screening it spends the day's budget on
    // a role nobody can apply to.
    if (signals["isExpired"] === true || item["expired"] === true) continue;

    const company = firstString(
      asRecord(item["company"])["name"],
      item["company"],
      item["companyName"],
      item["company_name"],
      item["employer"],
    );
    const title = firstString(
      asRecord(item["title"])["text"],
      item["title"],
      item["jobTitle"],
      item["job_title"],
      item["name"],
    );
    // `snippet` is a ~200-char teaser and sits LAST: preferring it would push
    // every row under MIN_DESCRIPTION_CHARS and report the market as thin.
    const description = firstString(
      asRecord(item["description"])["text"],
      item["description"],
      item["descriptionText"],
      item["description_text"],
      item["jobDescription"],
      item["snippet"],
    ).slice(0, DESCRIPTION_MAX);
    const jobKey = firstString(item["jobKey"], item["job_key"], item["id"], item["jobId"]);

    if (company.length === 0 || title.length === 0 || jobKey.length === 0) {
      droppedUnmappable += 1;
      continue;
    }

    if (description.length < MIN_DESCRIPTION_CHARS) {
      droppedThin += 1;
      continue;
    }

    const postedAt = parseDate(
      asRecord(item["dates"])["posted"] ??
        item["datePublished"] ??
        item["date"] ??
        item["postedAt"] ??
        item["pubDate"],
    );

    // The actor cannot apply `fromDays` alongside the remote filter, so the age
    // cut lands here. A posting with no date survives: an unknown date is not
    // evidence of an old one, and dropping it would be the silent direction.
    if (opts.maxAgeDays !== undefined && postedAt) {
      const ageDays = (now.getTime() - postedAt.getTime()) / 86_400_000;
      if (ageDays > opts.maxAgeDays) continue;
    }

    postings.push({
      company,
      title,
      url: firstString(
        asRecord(item["urls"])["indeed"],
        asRecord(item["urls"])["external"],
        item["url"],
        item["jobUrl"],
        item["applyUrl"],
        item["link"],
      ),
      description,
      location: firstString(
        asRecord(item["location"])["formatted"],
        asRecord(item["location"])["formattedShort"],
        item["location"],
        item["formattedLocation"],
        item["jobLocationCity"],
        item["city"],
      ),
      postedAt,
      source: INDEED_SOURCE,
      externalId: jobKey,
      jobKey,
    });
  }

  return { postings, droppedThin, droppedUnmappable };
}

/** Provenance stamped on every row this source produces. */
export const INDEED_SOURCE = "indeed-ingest";

// ── Network ───────────────────────────────────────────────────────────────────

/** Run the search and map its dataset. Never throws. */
export async function fetchIndeedPostings(query: IndeedQuery): Promise<IndeedFetch> {
  const input = buildIndeedInput(query);
  const run = await runActorSync(INDEED_ACTOR, input, INDEED_TIMEOUT_MS);
  if (!run.ok) {
    log.warn({ error: run.error, country: query.country }, "Indeed fetch failed");
    return { ok: false, error: run.error };
  }

  const mapped = mapIndeedItems(run.items, {
    ...(query.maxAgeDays !== undefined ? { maxAgeDays: query.maxAgeDays } : {}),
  });
  log.info(
    {
      country: query.country,
      returned: run.items.length,
      usable: mapped.postings.length,
      droppedThin: mapped.droppedThin,
      droppedUnmappable: mapped.droppedUnmappable,
    },
    "Indeed fetch complete",
  );
  return {
    ok: true,
    postings: mapped.postings,
    droppedThin: mapped.droppedThin,
    droppedUnmappable: mapped.droppedUnmappable,
  };
}

export type JobKeyStatus = "live" | "expired" | "unverifiable";

/**
 * Look up job keys and read back each one's `expired` flag.
 *
 * A key the lookup does not return at all is `unverifiable`, NOT `expired`.
 * Indeed omitting a row and Indeed saying the job is closed look identical from
 * here, and only one of those readings is safe to act on: marking a live role
 * dead removes it from the brief and emits no signal that it did.
 */
export async function lookupJobKeys(
  jobKeys: readonly string[],
): Promise<Map<string, JobKeyStatus>> {
  const result = new Map<string, JobKeyStatus>();
  if (jobKeys.length === 0) return result;

  const run = await runActorSync(INDEED_ACTOR, buildJobKeyInput(jobKeys), INDEED_TIMEOUT_MS);
  if (!run.ok) {
    log.warn({ error: run.error, count: jobKeys.length }, "Indeed liveness lookup failed");
    for (const key of jobKeys) result.set(key, "unverifiable");
    return result;
  }

  for (const [key, status] of readJobKeyStatuses(run.items)) result.set(key, status);
  for (const key of jobKeys) {
    if (!result.has(key)) result.set(key, "unverifiable");
  }
  return result;
}

/** Pure half of the lookup: dataset items → per-key status. */
export function readJobKeyStatuses(items: readonly unknown[]): Map<string, JobKeyStatus> {
  const statuses = new Map<string, JobKeyStatus>();
  for (const raw of items) {
    const item = asRecord(raw);
    const key = firstString(item["jobKey"], item["job_key"], item["id"], item["jobId"]);
    if (key.length === 0) continue;

    // Only an explicit boolean is trusted. A missing `expired` field means the
    // actor did not report on it, which is not the same as reporting "open".
    const expired = item["expired"];
    if (expired === true) statuses.set(key, "expired");
    else if (expired === false) statuses.set(key, "live");
    else statuses.set(key, "unverifiable");
  }
  return statuses;
}
