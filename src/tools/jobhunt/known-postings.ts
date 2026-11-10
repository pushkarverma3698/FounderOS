/**
 * Recognising a posting we already hold when its TITLE changed.
 *
 * The exact-key dedupe is company + title, so a recruiter who edits a title
 * ("Software Engineer, Comms Platform" -> "Software Engineer, Backend, Comms
 * Platform") makes the same live posting look new, and it is surfaced twice. 12
 * postings did exactly that in 30 days. The posting's URL and the board's own id
 * do not change when the title does, so they identify it.
 *
 * Pure: the database read lives in src/db/job-known-queries.ts.
 */

import { normaliseCompanyName } from "./sponsor-match.js";

/** Query parameters that only say where a click came from, never which job. */
const TRACKING_PARAM = /^(utm_.*|gh_src|src|source|ref|referrer|lever-source|lever-origin|trk|fbclid|gclid)$/i;

/** Lower-cased host, no fragment, no tracking params, no trailing slash. Null for a non-URL. */
export function normalizeJobUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null; // allow-failopen: not a URL, so it cannot match one; the title key still dedupes it
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const kept = [...url.searchParams.entries()]
    .filter(([name]) => !TRACKING_PARAM.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = kept.length > 0 ? `?${kept.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.hostname.toLowerCase()}${path}${query}`;
}

/** What a stored row contributes to the check. */
export interface KnownRef {
  readonly company: string;
  readonly url: string | null;
  readonly externalId: string | null;
}

/** What a fresh candidate is compared on. */
export interface CandidateRef {
  readonly company: string;
  readonly url: string;
  readonly externalId: string;
}

export interface KnownIndex {
  readonly urls: ReadonlySet<string>;
  /** `<normalised company>::<external id>`: an id is only unique inside one board. */
  readonly boardIds: ReadonlySet<string>;
}

const boardIdKey = (company: string, externalId: string): string =>
  `${normaliseCompanyName(company)}::${externalId}`;

export function buildKnownIndex(refs: readonly KnownRef[]): KnownIndex {
  const urls = new Set<string>();
  const boardIds = new Set<string>();
  for (const ref of refs) {
    const url = ref.url ? normalizeJobUrl(ref.url) : null;
    if (url) urls.add(url);
    if (ref.externalId) boardIds.add(boardIdKey(ref.company, ref.externalId));
  }
  return { urls, boardIds };
}

export function isKnownPosting(candidate: CandidateRef, index: KnownIndex): boolean {
  const url = normalizeJobUrl(candidate.url);
  if (url && index.urls.has(url)) return true;
  return candidate.externalId.length > 0 && index.boardIds.has(boardIdKey(candidate.company, candidate.externalId));
}
