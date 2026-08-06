/**
 * FounderOS — normalising the three free board feeds
 * ==================================================
 * Pure translation from each platform's JSON into one shape. No network here, so
 * the entire format contract is unit-testable against captured fixtures — which
 * matters more for these feeds than for the metered one, because nobody is
 * invoicing us when a schema quietly changes.
 *
 * THE THREE FEEDS ARE NOT THE SAME SHAPE, and one difference drives the design:
 *
 *   · Lever  — one call returns everything, including `descriptionPlain`.
 *   · Ashby  — one call returns everything, including `descriptionPlain`.
 *   · Greenhouse — the cheap list endpoint carries NO body. Asking for it
 *     (`?content=true`) returned 742 KB for a single 52-job board on 2026-08-06,
 *     which is not a payload to pull from 142 boards every half hour.
 *
 * So a Greenhouse posting arrives with `description: null` and is hydrated by a
 * second, per-posting request LATER — only for the few that survive the freshness
 * and relevance filters. That is the whole reason `FreeCandidate` exists as a
 * separate type from `RawPosting`: a candidate may not have a body yet, and the
 * type system should say so rather than let an empty string masquerade as one.
 * An empty description reaching the gates reads as "this employer stated no
 * requirements", which is a confident wrong answer.
 */

import type { RawPosting } from "./ats-source.js";
import { countryFromLocation } from "./country.js";
import type { FreeBoard } from "./free-boards.js";

/** Provenance stamped on every row this lane creates. */
export const FREE_INGEST_SOURCE = "free-ats-ingest";

/**
 * A posting seen on a board, before we know whether it is worth a body.
 *
 * `description: null` means "not fetched yet", never "the posting has none".
 */
export interface FreeCandidate {
  readonly board: FreeBoard;
  readonly externalId: string;
  readonly title: string;
  readonly url: string;
  readonly location: string;
  /** From the platform's own publication field. Null when it stated none. */
  readonly postedAt: Date | null;
  readonly description: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Ids arrive as numbers on Greenhouse and strings elsewhere. */
function asId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * Parse a publication timestamp from whatever the platform used.
 *
 * ISO strings with an offset (Greenhouse: `2025-04-23T04:30:41-04:00`) and epoch
 * milliseconds (Lever: `1779392148604`) both appear. An unparseable value returns
 * null rather than `new Date(NaN)` or a silent `Date.now()` — an undated posting
 * is of UNKNOWN age, and treating unknown as fresh is how a three-year-old
 * listing reaches the top of a brief that promised the founder new roles.
 */
export function parsePostedAt(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const fromEpoch = new Date(value);
    return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value.trim());
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** Greenhouse: `/v1/boards/{token}/jobs` — no body on this endpoint. */
export function mapGreenhouseJobs(payload: unknown, board: FreeBoard): FreeCandidate[] {
  const root = asRecord(payload);
  const jobs = Array.isArray(root?.["jobs"]) ? (root["jobs"] as unknown[]) : [];

  return jobs.flatMap((raw) => {
    const job = asRecord(raw);
    if (job === null) return [];

    const externalId = asId(job["id"]);
    const title = asText(job["title"]);
    const url = asText(job["absolute_url"]);
    if (externalId.length === 0 || title.length === 0 || url.length === 0) return [];

    return [
      {
        board,
        externalId,
        title,
        url,
        location: asText(asRecord(job["location"])?.["name"]),
        // `first_published` is when the employer put it up; `updated_at` moves
        // every time anyone edits a field, so using it would re-date an old
        // posting as new on every typo fix.
        postedAt: parsePostedAt(job["first_published"]),
        description: null,
      },
    ];
  });
}

/** Lever: `/v0/postings/{token}?mode=json` — a bare array, body included. */
export function mapLeverPostings(payload: unknown, board: FreeBoard): FreeCandidate[] {
  const postings = Array.isArray(payload) ? payload : [];

  return postings.flatMap((raw) => {
    const job = asRecord(raw);
    if (job === null) return [];

    const externalId = asId(job["id"]);
    // Lever calls the title `text`.
    const title = asText(job["text"]);
    const url = asText(job["hostedUrl"]) || asText(job["applyUrl"]);
    if (externalId.length === 0 || title.length === 0 || url.length === 0) return [];

    const categories = asRecord(job["categories"]);

    return [
      {
        board,
        externalId,
        title,
        url,
        location: asText(categories?.["location"]),
        postedAt: parsePostedAt(job["createdAt"]),
        description: asText(job["descriptionPlain"]) || null,
      },
    ];
  });
}

/** Ashby: `/posting-api/job-board/{token}` — body included. */
export function mapAshbyJobs(payload: unknown, board: FreeBoard): FreeCandidate[] {
  const root = asRecord(payload);
  const jobs = Array.isArray(root?.["jobs"]) ? (root["jobs"] as unknown[]) : [];

  return jobs.flatMap((raw) => {
    const job = asRecord(raw);
    if (job === null) return [];

    // Ashby keeps unlisted drafts in the same payload. They are not applyable and
    // must never reach the brief.
    if (job["isListed"] === false) return [];

    const externalId = asId(job["id"]);
    const title = asText(job["title"]);
    const url = asText(job["jobUrl"]) || asText(job["applyUrl"]);
    if (externalId.length === 0 || title.length === 0 || url.length === 0) return [];

    return [
      {
        board,
        externalId,
        title,
        url,
        location: asText(job["location"]),
        postedAt: parsePostedAt(job["publishedAt"]),
        description: asText(job["descriptionPlain"]) || null,
      },
    ];
  });
}

export const FREE_MAPPERS: Record<
  FreeBoard["ats"],
  (payload: unknown, board: FreeBoard) => FreeCandidate[]
> = {
  greenhouse: mapGreenhouseJobs,
  lever: mapLeverPostings,
  ashby: mapAshbyJobs,
};

/**
 * Turn a hydrated candidate into the shape the screener already understands.
 *
 * The country comes from the posting's OWN location string, never from the
 * board's `markets` column: a board is a company, and a company hires wherever it
 * likes. `countryFromLocation` returning `unknown` is an honest answer and is
 * carried through as one — the gates handle an unknown location explicitly, and
 * inventing "NL" here because the board came from the Dutch list would be a
 * confident wrong answer the screener has no way to detect.
 */
export function toRawPosting(candidate: FreeCandidate, description: string): RawPosting {
  return {
    company: candidate.board.name,
    title: candidate.title,
    url: candidate.url,
    description,
    location: candidate.location,
    postedAt: candidate.postedAt,
    source: FREE_INGEST_SOURCE,
    externalId: candidate.externalId,
    country: countryFromLocation(candidate.location),
  };
}
