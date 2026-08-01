/**
 * FounderOS — ATS response mapping
 * ===============================
 * Turning the aggregator's dataset items into `RawPosting`s. Split out of
 * ats-source.ts so that module is about ASKING the feed a question and this one
 * is about believing the answer — two jobs with genuinely different failure
 * modes, and a file budget that says so.
 *
 * Everything here is pure, which is what lets the odd real-world shapes below
 * (a 521 wrapped in a successful run, one job posted four times under four city
 * suffixes) be regression-tested without a network call.
 */

import type { RawPosting } from "./ats-source.js";

/** Bound a stored posting body. Long enough for every real posting. */
const DESCRIPTION_MAX = 20_000;

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
