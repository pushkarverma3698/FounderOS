/**
 * FounderOS — ATS Adapter Framework
 * =================================
 * The unified interface for the Job Intelligence Engine.
 */

import { FreeBoard } from "../free-boards.js";

/**
 * Normalised representation of a job candidate fetched from ANY ATS adapter.
 * Description may be null if the ATS list endpoint does not supply it and
 * requires a separate fetch (e.g. Greenhouse).
 */
export interface NormalizedJob {
  readonly board: FreeBoard;
  readonly externalId: string;
  readonly title: string;
  readonly url: string;
  readonly location: string;
  readonly postedAt: Date | null;
  readonly description: string | null;
}

/**
 * One HTTP request for a board's list endpoint.
 *
 * Exists because Workday is the first platform whose list endpoint is a POST with
 * a JSON body rather than a GET. Everything else still describes itself with
 * `getBoardUrl` alone and never constructs one of these.
 */
export interface BoardRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  /** JSON body, POST only. */
  readonly body?: string;
}

/**
 * How a platform pages its board endpoint.
 *
 * `maxPages` is a HARD stop, not a target. Workday caps `limit` at 20 (measured:
 * 50 and 100 both return zero postings) and orders newest-first (measured: 21 →
 * 24 → 27 → 30+ days), so N pages is "the freshest N × pageSize postings" — which
 * is the half of a board this lane is built to care about. Without a cap, one
 * employer with 4,000 open roles would spend the whole sweep window by itself.
 */
export interface BoardPaging {
  readonly pageSize: number;
  readonly maxPages: number;
}

/**
 * Standard interface for all ATS platforms.
 */
export interface AtsAdapter {
  readonly platformName: string;

  /**
   * How to request one page of the board, when a plain GET of `getBoardUrl()`
   * will not do. `offset` is 0 for the first page.
   *
   * Optional: absent means one GET of `getBoardUrl()`, which is every platform
   * except Workday.
   */
  getBoardRequest?(board: FreeBoard, offset: number): BoardRequest;

  /** Present only when the platform pages. Absent means one request per board. */
  readonly paging?: BoardPaging;

  /**
   * Total postings the board claims to hold, read from a page payload, so paging
   * stops at the real end instead of always spending `maxPages` requests.
   * Return null when the payload does not say.
   */
  totalFrom?(payload: unknown): number | null;

  /**
   * True when the LIST endpoint carries no publication date and only the DETAIL
   * endpoint does.
   *
   * BambooHR is the only such platform (verified 2026-08-24: its `/careers/list`
   * record has no date field at all, while `/careers/{id}/detail` carries
   * `jobOpening.datePosted`). The ingest filters staleness before it hydrates
   * bodies, so without this flag every posting from such a board is dropped as
   * `undated` and the boards are worth nothing. See free-ingest.ts.
   */
  readonly dateOnlyInDetail?: boolean;

  /**
   * The publication date, read from a DETAIL payload. Required in practice by
   * any adapter setting `dateOnlyInDetail`, and meaningless without it.
   */
  postedAtFromDetail?(payload: Record<string, unknown>): Date | null;

  /**
   * Return the URL to fetch the full list of jobs.
   */
  getBoardUrl(board: FreeBoard): string;

  /**
   * The expected wire format for the board list endpoint.
   */
  getWireFormat(): "json" | "xml";

  /**
   * Map the raw board payload into NormalizedJob candidates.
   */
  listJobs(payload: unknown, board: FreeBoard): NormalizedJob[];

  /**
   * Return the URL for a specific job to fetch its body.
   * Return null if the body is already inlined in listJobs.
   */
  getJobUrl(board: FreeBoard, externalId: string): string | null;
  
  /**
   * Extract the HTML/text body from a specific job detail payload.
   */
  extractBody(payload: Record<string, unknown>): string;

  /**
   * Given the posting URL, return the direct apply URL (e.g. appending /apply).
   */
  applyUrlFor(postingUrl: string, board: FreeBoard): string | null;
}

/**
 * Helper to decode HTML entities from ATS text bodies.
 */
export function decodeJobBody(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a publication timestamp from multiple ATS formats.
 */
const EPOCH_MS_FLOOR = 1e12;
const EPOCH_SECONDS_FLOOR = 1e9;

export function parsePostedAt(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
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
