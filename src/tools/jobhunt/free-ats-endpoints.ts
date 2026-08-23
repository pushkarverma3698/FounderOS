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

import type { FreeAts, FreeBoard } from "./free-boards.js";
import { decodeJobBody } from "./free-ats-mappers.js";
import { extractBoardToken } from "./board-token.js";

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
    case "personio":
      // NOT `search.json`, which looks like the JSON sibling of this and is the
      // trap: it answers 200 with every posting and an empty description on all
      // of them, no date and no URL. See personio-xml.ts.
      return `https://${token}.jobs.personio.com/xml`;
  }
}

/**
 * What a platform's board endpoint returns on the wire.
 *
 * Every platform here speaks JSON today. The distinction exists because the
 * transport has to decide between `response.json()` and `response.text()` before
 * a mapper ever sees the payload, and a platform whose only complete feed is XML
 * is a question of fact about that platform — which is what this file records.
 */
export type WireFormat = "json" | "xml";

export const WIRE_FORMAT: Readonly<Record<FreeAts, WireFormat>> = {
  greenhouse: "json",
  lever: "json",
  ashby: "json",
  recruitee: "json",
  smartrecruiters: "json",
  workable: "json",
  personio: "xml",
};

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
    // Personio inlines every description in the board feed itself — that is the
    // whole reason the feed is 2.26 MB and the whole reason it is worth caching.
    case "personio":
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

/**
 * How each platform gets from "read the ad" to "fill the form".
 *
 * Every one of these is one hop, and every one of them is a hop the founder
 * currently makes by hand: open the posting, scroll, find the button. A
 * `/draft` that delivers a tailored CV and then asks him to go hunting for the
 * form has done the hard 95% and left the part that decides whether an
 * application exists.
 */
const APPLY_PATH: Readonly<Record<FreeAts, string>> = {
  // The form is rendered on the posting page behind an anchor, not a route.
  greenhouse: "#app",
  lever: "/apply",
  ashby: "/application",
  recruitee: "/c/new",
  // SmartRecruiters serves the form inline on the posting itself — there is no
  // second URL, and inventing one would 404.
  smartrecruiters: "",
  workable: "/apply",
  // Personio serves the form on the posting page itself; there is no second URL.
  personio: "",
};

/**
 * The URL that opens the application FORM for a posting, or null.
 *
 * Null is a real answer and the caller must handle it: a company's own careers
 * page, an aggregator, a white-labelled Recruitee domain, or a Greenhouse board
 * fronted behind `?gh_jid=` on the employer's own host all reach us as posting
 * URLs we cannot map. Appending "/apply" to those produces a link that LOOKS
 * authoritative and 404s — worse than no button, because the founder taps it
 * once, finds nothing, and stops trusting the row. Fall back to the posting URL
 * at the call site, where that decision is visible.
 *
 * Pure and total, because it runs once per row of every brief and one malformed
 * URL must not cost the other rows their button.
 */
export function applyUrlFor(postingUrl: string): string | null {
  if (typeof postingUrl !== "string" || postingUrl.trim().length === 0) return null;

  const board = extractBoardToken(postingUrl);
  if (board === null) return null;

  const suffix = APPLY_PATH[board.ats];
  const url = postingUrl.replace(/\/+$/, "");
  if (suffix.length === 0) return url;
  // Idempotent: a URL that already ends in the apply path is returned as-is
  // rather than growing a second copy of it. Postings reach us from the feed
  // and from `/draft` re-runs, and doubling the suffix breaks the link.
  return url.endsWith(suffix) ? url : `${url}${suffix}`;
}

