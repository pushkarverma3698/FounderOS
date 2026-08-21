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
 * Decode an HTML job body (Greenhouse's per-posting fetch, Recruitee's
 * `description`/`requirements`) into prose the gates can read.
 *
 * The gates read prose — years of experience, language requirements, salary — so
 * tags become whitespace rather than being deleted: stripping `</p><p>` without a
 * separator glues the last word of one paragraph to the first of the next, and
 * "5 years" arriving as "experience5 years" is invisible to the years regex.
 */
export function decodeJobBody(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // `&amp;` last, or "&amp;lt;" would decode twice into a real tag.
    .replace(/&amp;/g, "&")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

/** A numeric timestamp at/above this is epoch milliseconds (Sept 2001 in ms). */
const EPOCH_MS_FLOOR = 1e12;
/** …between this and EPOCH_MS_FLOOR it can only be epoch SECONDS (Sept 2001 in s). */
const EPOCH_SECONDS_FLOOR = 1e9;

export function parsePostedAt(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Both bounds are September 2001. At or above EPOCH_MS_FLOOR the number can
    // only be milliseconds; between the two it can only be SECONDS (as ms it
    // would date the posting to the early 1970s, and a 1970 date is worse than
    // null — the freshness filter would count it "stale" when the truth is we
    // never knew its age); below EPOCH_SECONDS_FLOOR it is neither, and undated
    // is the honest answer.
    if (value >= EPOCH_MS_FLOOR) return new Date(value);
    if (value >= EPOCH_SECONDS_FLOOR) return new Date(value * 1000);
    return null;
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

/**
 * Recruitee: `/api/offers/` — `{ offers: [...] }`, body included, split across
 * `description` and `requirements`. Verified live against a real board
 * 2026-08-20 (`dalsem.recruitee.com`): `careers_url` is the human posting
 * page (often the company's own white-labelled domain, e.g.
 * `werkenbijdalsem.nl/o/...`), distinct from `careers_apply_url`, which skips
 * straight to the application form.
 */
export function mapRecruiteeOffers(payload: unknown, board: FreeBoard): FreeCandidate[] {
  const root = asRecord(payload);
  const offers = Array.isArray(root?.["offers"]) ? (root["offers"] as unknown[]) : [];

  return offers.flatMap((raw) => {
    const offer = asRecord(raw);
    if (offer === null) return [];
    // The endpoint is public and unauthenticated, so drafts should never
    // appear — filtered anyway, matching Ashby's isListed guard, because a
    // wrong assumption about a third party's API costs nothing to check here.
    if (offer["status"] !== undefined && offer["status"] !== "published") return [];

    const externalId = asId(offer["id"]);
    const title = asText(offer["title"]);
    const url = asText(offer["careers_url"]) || asText(offer["careers_apply_url"]);
    if (externalId.length === 0 || title.length === 0 || url.length === 0) return [];

    // Both sections are employer-authored HTML and either can carry the
    // gates read (years, salary, language, sponsor mentions) — concatenated
    // so nothing is silently dropped, decoded the same way Greenhouse's
    // hydrated body is.
    const body = [decodeJobBody(asText(offer["description"])), decodeJobBody(asText(offer["requirements"]))]
      .filter((s) => s.length > 0)
      .join("\n\n");

    return [
      {
        board,
        externalId,
        title,
        url,
        location: asText(offer["location"]),
        postedAt: parsePostedAt(offer["published_at"]),
        description: body || null,
      },
    ];
  });
}

/**
 * SmartRecruiters: `/v1/companies/{token}/postings` — `{ content: [...] }`.
 *
 * Verified live 2026-08-21 against `1huddle`. Two things are unlike the other
 * platforms and both are handled here rather than downstream:
 *
 * · THE LIST CARRIES NO BODY, exactly like Greenhouse, so `description` is left
 *   null and `hydrateDescriptions` fetches it from the per-posting endpoint.
 * · THE LIST CARRIES NO URL. Only the per-posting response has `postingUrl`,
 *   and a candidate with no URL is dropped by the mapper contract — so the
 *   public form is built here. `jobs.smartrecruiters.com/{token}/{id}` resolves
 *   200 without the title slug that `postingUrl` appends (checked live).
 */
export function mapSmartRecruitersPostings(payload: unknown, board: FreeBoard): FreeCandidate[] {
  const root = asRecord(payload);
  const postings = Array.isArray(root?.["content"]) ? (root["content"] as unknown[]) : [];

  return postings.flatMap((raw) => {
    const posting = asRecord(raw);
    if (posting === null) return [];

    const externalId = asId(posting["id"]);
    const title = asText(posting["name"]);
    if (externalId.length === 0 || title.length === 0) return [];

    // `fullLocation` is the one field the country gate can read as prose
    // ("Amsterdam, Netherlands"); city/region alone would leave the country to
    // be guessed, which this pipeline refuses to do.
    const location = asRecord(posting["location"]);
    return [
      {
        board,
        externalId,
        title,
        url: `https://jobs.smartrecruiters.com/${board.token}/${externalId}`,
        location: asText(location?.["fullLocation"]) || asText(location?.["city"]),
        postedAt: parsePostedAt(posting["releasedDate"]),
        description: null,
      },
    ];
  });
}

/**
 * Workable: `/api/v1/widget/accounts/{token}?details=true` — `{ jobs: [...] }`.
 *
 * Verified live 2026-08-21 against `1000heads`. The whole posting arrives in one
 * response, body included, so Workable needs no hydration round trip at all.
 *
 * The payload's TOP-LEVEL `description` is the company blurb, not a posting.
 * Only `jobs[]` is read — mistaking the two would put one fake row on every
 * Workable board in the registry.
 */
export function mapWorkableJobs(payload: unknown, board: FreeBoard): FreeCandidate[] {
  const root = asRecord(payload);
  const jobs = Array.isArray(root?.["jobs"]) ? (root["jobs"] as unknown[]) : [];

  return jobs.flatMap((raw) => {
    const job = asRecord(raw);
    if (job === null) return [];

    const externalId = asId(job["shortcode"]);
    const title = asText(job["title"]);
    // `url` is the public posting; `application_url` skips to the form. Either
    // is somewhere the founder can apply, so a missing first is not a lost row.
    const url = asText(job["url"]) || asText(job["application_url"]);
    if (externalId.length === 0 || title.length === 0 || url.length === 0) return [];

    // No single location field. Assembled from the parts, empties dropped, so a
    // remote role with no city does not render as ", , United States".
    const location = [asText(job["city"]), asText(job["state"]), asText(job["country"])]
      .filter((part) => part.length > 0)
      .join(", ");

    return [
      {
        board,
        externalId,
        title,
        url,
        location,
        postedAt: parsePostedAt(job["published_on"]),
        description: decodeJobBody(asText(job["description"])) || null,
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
  recruitee: mapRecruiteeOffers,
  smartrecruiters: mapSmartRecruitersPostings,
  workable: mapWorkableJobs,
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
