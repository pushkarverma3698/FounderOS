/**
 * Company careers pages that embed a Greenhouse board (`?gh_jid=<id>`) carry no form of their own: the employer's page
 * loads Greenhouse's iframe, so the form runner saw "no fillable form fields". The hosted board serves the same form at
 * `job-boards.greenhouse.io/embed/job_app?for=<token>&token=<id>`.
 *
 * The board token is not in the embedded URL. It is known when the company is a Greenhouse board in the free registry,
 * the same registry the sweep polls (the row's `company` is that board's `name`, see free-ingest `toRawPosting`).
 * Reading the token off the page's embed script would need a fetch on this pure path, so a company outside the registry
 * keeps its URL.
 */
import { getFreeBoards } from "./free-boards.js";
import { extractBoardToken } from "./board-token.js";

const normalise = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The single Greenhouse token registered under this company name; null when none or when two boards disagree. */
function greenhouseTokenFor(company: string): string | null {
  const key = normalise(company);
  if (key.length === 0) return null;
  let boards: ReturnType<typeof getFreeBoards>;
  try {
    boards = getFreeBoards();
  } catch {
    // allow-failopen: a missing or thin registry only means no rewrite; the caller keeps the original URL.
    return null;
  }
  const tokens = new Set(
    boards.filter((b) => b.ats === "greenhouse" && normalise(b.name) === key).map((b) => b.token),
  );
  return tokens.size === 1 ? ([...tokens][0] ?? null) : null;
}

/** The hosted Greenhouse form for an embedded `?gh_jid=` posting, or null when the URL should stay as it is. */
export function greenhouseHostedUrl(url: string, company: string): string | null {
  if (extractBoardToken(url)?.ats === "greenhouse") return null;
  let jid: string | null;
  try {
    jid = new URL(url).searchParams.get("gh_jid");
  } catch {
    return null;
  }
  if (jid === null || !/^\d+$/.test(jid)) return null;
  const token = greenhouseTokenFor(company);
  if (token === null) return null;
  // The embed form URL, not /<token>/jobs/<id>: that page redirects back to the company site when the
  // company set its own careers URL (checked 2026-11-23 on Schuberg Philis and Stripe).
  return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(token)}&token=${jid}`;
}
