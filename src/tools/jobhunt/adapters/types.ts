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
 * Standard interface for all ATS platforms.
 */
export interface AtsAdapter {
  readonly platformName: string;

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
