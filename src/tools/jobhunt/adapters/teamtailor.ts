/**
 * Teamtailor — a JSON Feed, so nothing here has to be clever
 * ==========================================================
 * 23 IND-sponsor boards. The smallest of the three platforms added on
 * 2026-08-24 and by some distance the least risky: `/jobs.json` is a standard
 * JSON Feed that inlines the description (`content_html`) AND a real ISO 8601
 * `date_published`, so this adapter needs no detail fetch and no date guessing.
 *
 * Location comes from the embedded schema.org JobPosting (`_jobposting`), which
 * is the only place the feed states it.
 */

import { AtsAdapter, NormalizedJob, decodeJobBody, parsePostedAt } from "./types.js";
import { FreeBoard } from "../free-boards.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * "Lormont, FR" from the schema.org address.
 *
 * Locality and country are joined because `countryFromLocation` upstream reads a
 * country out of the string, and a bare city name would leave every Dutch board's
 * postings looking country-less. Absent parts are simply omitted rather than
 * padded, so a remote posting yields "" and is treated as unknown, not as a place.
 */
export function teamtailorLocation(jobPosting: unknown): string {
  const locations = asRecord(jobPosting)?.["jobLocation"];
  const first = Array.isArray(locations) ? locations[0] : locations;
  const address = asRecord(asRecord(first)?.["address"]);
  if (address === null) return "";

  const parts = [
    asText(address["addressLocality"]),
    asText(address["addressRegion"]),
    asText(address["addressCountry"]),
  ].filter((p) => p.length > 0);

  return parts.join(", ");
}

export const teamtailorAdapter: AtsAdapter = {
  platformName: "teamtailor",

  getBoardUrl(board: FreeBoard): string {
    const token = encodeURIComponent(board.token);
    return `https://${token}.teamtailor.com/jobs.json`;
  },

  getWireFormat(): "json" {
    return "json";
  },

  listJobs(payload: unknown, board: FreeBoard): NormalizedJob[] {
    const root = asRecord(payload);
    const items = Array.isArray(root?.["items"]) ? (root["items"] as unknown[]) : [];

    return items.flatMap((raw) => {
      const item = asRecord(raw);
      if (item === null) return [];

      const externalId = asText(item["id"]);
      const title = asText(item["title"]);
      const url = asText(item["url"]);
      if (externalId.length === 0 || title.length === 0 || url.length === 0) return [];

      const body = decodeJobBody(asText(item["content_html"]));

      return [
        {
          board,
          externalId,
          title,
          url,
          location: teamtailorLocation(item["_jobposting"]),
          postedAt: parsePostedAt(item["date_published"]),
          description: body.length > 0 ? body : null,
        },
      ];
    });
  },

  // The feed inlines every body, so there is nothing left to fetch. Null here
  // means "this posting genuinely has no description", not "we failed to get it".
  getJobUrl(_board: FreeBoard, _externalId: string): string | null {
    return null;
  },

  extractBody(_payload: Record<string, unknown>): string {
    return "";
  },

  applyUrlFor(postingUrl: string, _board: FreeBoard): string | null {
    if (typeof postingUrl !== "string" || postingUrl.trim().length === 0) return null;
    const url = postingUrl.replace(/\/+$/, "");
    return url.endsWith("/applications/new") ? url : `${url}/applications/new`;
  },
};
