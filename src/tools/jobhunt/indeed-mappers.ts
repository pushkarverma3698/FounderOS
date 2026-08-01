/**
 * FounderOS — Indeed response mapping
 * ===================================
 * Turning the actor's dataset items into `IndeedPosting`s. Split out of
 * indeed-source.ts on 2026-08-01, mirroring the ats-source / ats-mappers split
 * and for the same reason: that module is about ASKING the feed a question, and
 * this one is about believing the answer. Two jobs with genuinely different
 * failure modes — a query that times out is an outage, a row whose shape we
 * cannot read is our bug — and a file budget that says so.
 *
 * Everything here is pure, which is what lets the actor's real nested shapes be
 * regression-tested without a network call.
 */

import type { PostingCountry } from "./country.js";
import type { RawPosting } from "./ats-source.js";

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

/** Provenance stamped on every row this source produces. */
export const INDEED_SOURCE = "indeed-ingest";

export interface IndeedPosting extends RawPosting {
  /** Indeed's own job key — the handle the liveness lookup needs. */
  readonly jobKey: string;
}

export type JobKeyStatus = "live" | "expired" | "unverifiable";

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
  /**
   * Rows the actor itself marked closed.
   *
   * COUNTED, because until 2026-08-01 they left through a bare `continue` and
   * vanished. The live NL sweep logged `returned 10, usable 2, droppedThin 0,
   * droppedUnmappable 0` — eight rows unaccounted for, which made "the market is
   * thin", "eight of these are stale listings" and "the mapper is broken" three
   * indistinguishable readings of the same log line. Filtering expired postings
   * is right; doing it invisibly is the failure this module's own docstring
   * exists to prevent.
   */
  readonly droppedExpired: number;
  /** Rows older than the caller's age cut. Also a legitimate filter, also counted. */
  readonly droppedStale: number;
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
  opts: { maxAgeDays?: number; now?: Date; country?: PostingCountry } = {},
): MappedIndeed {
  const postings: IndeedPosting[] = [];
  const now = opts.now ?? new Date();
  let droppedThin = 0;
  let droppedUnmappable = 0;
  let droppedExpired = 0;
  let droppedStale = 0;

  for (const raw of items) {
    const item = asRecord(raw);
    const signals = asRecord(item["signals"]);

    // An expired posting is not supply. Screening it spends the day's budget on
    // a role nobody can apply to.
    if (signals["isExpired"] === true || item["expired"] === true) {
      droppedExpired += 1;
      continue;
    }

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
      if (ageDays > opts.maxAgeDays) {
        droppedStale += 1;
        continue;
      }
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
      // The query asked Indeed for one specific country, so this is a fact about
      // the row and not a reading of it. Nine Indian postings were stored under a
      // Dutch permit basis because this value existed at fetch time and was
      // dropped before the screener could use it.
      ...(opts.country ? { country: opts.country } : {}),
    });
  }

  return { postings, droppedThin, droppedUnmappable, droppedExpired, droppedStale };
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
