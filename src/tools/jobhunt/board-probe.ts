/**
 * FounderOS — is this 200 actually a board?
 * =========================================
 * One question, asked of a raw ATS list-endpoint body. Lives in `src/` rather
 * than in the discovery script because it is a claim about third-party API
 * behaviour, and claims about the world need regression tests
 * (tests/unit/tools/funding-grow-postings.test.ts) rather than a comment in a
 * cron job.
 */

/** Array-valued fields the ATS list endpoints put their postings under. */
const POSTING_ARRAY_KEYS = ["content", "jobs", "data", "results", "result", "elements", "postings", "items"];

/** A rendered web page, not a board feed — see `countPostings`. */
const LOOKS_LIKE_HTML = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

/**
 * How many postings a 200 response actually contains, or `null` when the shape
 * is not one we recognise.
 *
 * WHY A 200 IS NOT A BOARD. Two platforms answer 200 for a tenant that does not
 * exist, measured 2026-09-08 against the slug "totallynotarealcompanyxyz123":
 *
 *   SmartRecruiters → 200 `{"totalFound":0,"content":[]}`
 *   BambooHR        → 200, 43 KB of its own marketing homepage
 *
 * The probe only checked `res.ok`, so both were hits for every candidate. The
 * sweep's own summary read "boards discovered 12 (100.00% hit rate)" from twelve
 * headline-derived slugs. Nothing had caught it because the sweep was crashing
 * before it could write anything — so fixing only the crash would have switched
 * on a channel that writes a dozen junk boards a night into the registry the
 * 30-minute poll reads, which is worse than the dead channel it replaced.
 *
 * HTML counts as ZERO, not as unknown: a rendered marketing page genuinely
 * contains no postings, and it is the shape BambooHR uses to say "no such
 * tenant". Non-HTML shapes we cannot parse return `null` and are treated as
 * evidence PRESENT by the caller — Personio serves a real board as XML
 * (`<workzag-jobs>`), so a blanket "not JSON ⇒ not a board" would delete a
 * working platform to fix a different one.
 */
export function countPostings(body: string): number | null {
  if (LOOKS_LIKE_HTML.test(body)) return 0;

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (Array.isArray(payload)) return payload.length;
  if (payload === null || typeof payload !== "object") return null;

  const obj = payload as Record<string, unknown>;
  for (const key of POSTING_ARRAY_KEYS) {
    if (Array.isArray(obj[key])) return (obj[key] as unknown[]).length;
  }
  for (const key of ["totalFound", "total", "count"]) {
    if (typeof obj[key] === "number") return obj[key] as number;
  }
  return null;
}
