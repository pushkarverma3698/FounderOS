/**
 * FounderOS — polling the free boards
 * ===================================
 * The network half of the free lane. Normalisation lives in free-ats-mappers.ts,
 * so everything here is about asking 238 third-party hosts a question without
 * letting any one of them break the sweep.
 *
 * WHY THIS LANE EXISTS. The metered feed is billed per job returned, which forces
 * it to ask narrow questions on a three-day cadence — and its median lag from a
 * posting going live to us seeing it was 19.6 hours (n=22, measured 2026-08-06).
 * These endpoints are unauthenticated and free, so this lane can ask for the
 * whole board every half hour and close that gap to minutes. That head start is
 * the entire product: the founder applies before the posting reaches the
 * aggregators everyone else is refreshing.
 *
 * THREE FAILURE RULES, all of them about not lying at the far end:
 *
 *   1. A board that fails is COUNTED, never skipped silently. A rotated token
 *      404s forever, and a registry quietly polling 230 of 238 boards produces
 *      the same "no new roles" as a quiet market.
 *   2. One board's failure never aborts the sweep. Losing 237 boards because one
 *      host is down is the pipeline failing at the moment it is unattended.
 *   3. A request that hangs is bounded. No timeout means one slow host stalls a
 *      sweep that is supposed to finish inside its 30-minute window.
 */

import { childLogger } from "../../infra/logger.js";
import { mapWithConcurrencyLimit } from "../../core/concurrency.js";
import type { FreeBoard } from "./free-boards.js";
import { FREE_MAPPERS, type FreeCandidate } from "./free-ats-mappers.js";

const log = childLogger({ module: "jobhunt:free-ats" });

/** One board's list endpoint. Whole-board payloads, so more generous than a HEAD. */
export const BOARD_TIMEOUT_MS = 20_000;

/** One Greenhouse posting's body. Small payload, so a tighter bound. */
export const DESCRIPTION_TIMEOUT_MS = 10_000;

/**
 * How many boards to poll at once.
 *
 * Bounded because the registry is not 238 independent hosts — it is three. All
 * 142 Greenhouse boards resolve to `boards-api.greenhouse.io`, so an unbounded
 * sweep would be a 142-request burst at a single origin every thirty minutes,
 * which is indistinguishable from a scraper. Eight keeps a full sweep inside a
 * couple of minutes while staying an unremarkable amount of traffic for a public
 * JSON API to serve.
 */
export const BOARD_CONCURRENCY = 8;

export type BoardFetch =
  | { readonly ok: true; readonly board: FreeBoard; readonly candidates: readonly FreeCandidate[] }
  | { readonly ok: false; readonly board: FreeBoard; readonly error: string };

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
  }
}

/**
 * Where one Greenhouse posting's body lives.
 *
 * Only Greenhouse needs this. Its list endpoint carries no body, and asking for
 * bodies inline (`?content=true`) returned 742 KB for one 52-job board — a
 * payload that does not belong in a half-hourly sweep across 142 boards. So the
 * body is fetched per posting, and only for the few that already survived the
 * freshness and relevance filters.
 */
export function greenhouseJobUrl(board: FreeBoard, externalId: string): string {
  return (
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}` +
    `/jobs/${encodeURIComponent(externalId)}`
  );
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      // Read the status before discarding the body, then discard it: an
      // unconsumed body holds the socket open under undici until GC.
      void response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and normalise one board.
 *
 * Returns a typed failure rather than throwing, because the caller's job is to
 * COUNT failures, not to be interrupted by them.
 */
export async function fetchBoard(board: FreeBoard): Promise<BoardFetch> {
  try {
    const payload = await fetchJson(boardUrl(board), BOARD_TIMEOUT_MS);
    return { ok: true, board, candidates: FREE_MAPPERS[board.ats](payload, board) };
  } catch (err) {
    return { ok: false, board, error: (err as Error).message };
  }
}

export interface BoardSweep {
  readonly candidates: readonly FreeCandidate[];
  /** One entry per board that failed, named so a rotated token is findable. */
  readonly failures: readonly string[];
  readonly boardsPolled: number;
}

/**
 * Poll every board in the registry.
 *
 * Failures are collected and reported, never thrown. A sweep in which every
 * single board failed still returns normally with 238 failures — and that is the
 * point: the caller can then say "the lane is broken" instead of "the market is
 * quiet", which are the two readings this pipeline has historically confused.
 */
export async function sweepBoards(boards: readonly FreeBoard[]): Promise<BoardSweep> {
  const results = await mapWithConcurrencyLimit(boards, BOARD_CONCURRENCY, fetchBoard);

  const candidates: FreeCandidate[] = [];
  const failures: string[] = [];

  for (const result of results) {
    if (result.ok) {
      candidates.push(...result.candidates);
    } else {
      failures.push(`${result.board.ats}/${result.board.token}: ${result.error}`);
    }
  }

  log.info(
    { boards: boards.length, failed: failures.length, candidates: candidates.length },
    "Free board sweep complete",
  );

  return { candidates, failures, boardsPolled: boards.length };
}

/**
 * Fill in the bodies Greenhouse withheld.
 *
 * Candidates that already have a description (Lever, Ashby) pass through
 * untouched and cost nothing. A body that cannot be fetched leaves the candidate
 * with `description: null`, and the caller drops it with a reason — screening a
 * posting on an empty body would read as "this employer stated no requirements",
 * which every gate would then wave through.
 */
export async function hydrateDescriptions(
  candidates: readonly FreeCandidate[],
): Promise<FreeCandidate[]> {
  return mapWithConcurrencyLimit(candidates, BOARD_CONCURRENCY, async (candidate) => {
    if (candidate.description !== null) return candidate;

    try {
      const payload = (await fetchJson(
        greenhouseJobUrl(candidate.board, candidate.externalId),
        DESCRIPTION_TIMEOUT_MS,
      )) as Record<string, unknown>;
      const content = typeof payload["content"] === "string" ? payload["content"] : "";
      return { ...candidate, description: decodeJobBody(content) || null };
    } catch (err) {
      log.warn(
        { board: candidate.board.token, id: candidate.externalId, err: (err as Error).message },
        "Could not fetch posting body",
      );
      return candidate;
    }
  });
}

/**
 * Greenhouse returns the body as HTML with entity-encoded markup.
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
