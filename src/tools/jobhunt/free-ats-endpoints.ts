/**
 * FounderOS — where each platform keeps its data
 * ==============================================
 * The per-platform knowledge: which URL lists a board's jobs, which URL carries
 * one posting's body (or none, when the list already did), and how to get the
 * body out of the response.
 *
 * Split out of free-ats-source.ts on 2026-08-21, which the LOC budget caught at
 * 455 lines after SmartRecruiters and Workable were added. The seam is a real
 * one rather than a line count: this file is what we know about six third
 * parties, and free-ats-source.ts is how we poll them politely. The second
 * barely changes; the first changes every time a platform is added.
 */

import type { FreeBoard } from "./free-boards.js";
import { decodeJobBody } from "./free-ats-mappers.js";

/**
 * Where each platform serves a board's postings.
 *
 * Pure, so the URL contract is asserted in tests rather than discovered in
 * production. Tokens are URL-encoded: Ashby slugs contain dots and mixed case
 * (`abstraction.games`), and one containing a slash would otherwise rewrite the
 * path it is supposed to be a segment of.
 */
export function boardUrl(board: FreeBoard): string {
  const token = encodeURIComponent(board.token);
  switch (board.ats) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`;
    case "lever":
      return `https://api.lever.co/v0/postings/${token}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${token}`;
    case "recruitee":
      return `https://${token}.recruitee.com/api/offers/`;
    case "smartrecruiters":
      // `limit=100`, not the default. SmartRecruiters pages at ten, which would
      // silently truncate every board with more than ten openings — precisely
      // the boards worth polling, and a truncation that looks like a small
      // employer rather than a missing page.
      return `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=${SMARTRECRUITERS_PAGE}`;
    case "workable":
      // `details=true` is what makes the body arrive with the list, which is
      // what saves Workable a hydration request per posting.
      return `https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`;
  }
}

/** One SmartRecruiters page. Above any single board's live openings in the registry. */
const SMARTRECRUITERS_PAGE = 100;

/**
 * Where one posting's BODY lives, or null when the list already carried it.
 *
 * Hydration used to call `greenhouseJobUrl` unconditionally, which was correct
 * while every body-less platform was Greenhouse. It stopped being correct the
 * moment SmartRecruiters joined: its postings would have been hydrated from
 * `boards-api.greenhouse.io`, 404ing once per posting, logged as "could not
 * fetch posting body", and every SmartRecruiters row would have reached the
 * funnel body-less and been dropped before screening. 145 boards would have
 * polled cleanly and contributed nothing, which is the exact ambiguity — broken
 * poller versus quiet market — this lane exists to eliminate.
 *
 * Returning null for the platforms that inline their bodies is not an
 * optimisation. Asking Ashby, Recruitee or Workable again would multiply our
 * request count at a third party for a field we already hold.
 */
export function jobBodyUrl(board: FreeBoard, externalId: string): string | null {
  const token = encodeURIComponent(board.token);
  const id = encodeURIComponent(externalId);
  switch (board.ats) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${id}`;
    case "smartrecruiters":
      return `https://api.smartrecruiters.com/v1/companies/${token}/postings/${id}`;
    case "lever":
    case "ashby":
    case "recruitee":
    case "workable":
      return null;
  }
}


/**
 * Pull the body out of one platform's per-posting response.
 *
 * SmartRecruiters splits the ad across named sections — `jobDescription`,
 * `qualifications`, `additionalInformation` — and the gates read all three: the
 * years bar and the language requirement usually live in `qualifications`, not
 * in the description. Reading only the first section would drop the fields the
 * screener exists to check. Sections are joined in the order the ad presents
 * them and decoded the same way every other body is.
 */
export function extractBody(ats: FreeBoard["ats"], payload: Record<string, unknown>): string {
  if (ats === "smartrecruiters") {
    const sections = (payload["jobAd"] as Record<string, unknown> | undefined)?.["sections"];
    if (typeof sections !== "object" || sections === null) return "";
    return Object.values(sections as Record<string, unknown>)
      .map((section) =>
        typeof section === "object" && section !== null
          ? String((section as Record<string, unknown>)["text"] ?? "")
          : "",
      )
      .filter((text) => text.length > 0)
      .map(decodeJobBody)
      .join("\n\n")
      .trim();
  }
  // Greenhouse: a single `content` field of escaped HTML.
  return typeof payload["content"] === "string" ? decodeJobBody(payload["content"]) : "";
}

