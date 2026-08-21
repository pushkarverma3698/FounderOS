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
 *
 * A FOURTH, ADDED 2026-08-21: a board that rate-limited us is asked again, not
 * written off. Recruitee limits the CALLER rather than the board, so 36 of 113
 * boards failed on every single sweep from the VPS and lowering the in-flight
 * limit to 1 only moved that to 15 — a third of the Dutch registry permanently
 * unreachable, and invisible, because the ledger only ever stored the first
 * three failure strings and those were always the same harmless 404s.
 */

import { childLogger } from "../../infra/logger.js";
import { mapWithConcurrencyLimit } from "../../core/concurrency.js";
import type { FreeAts, FreeBoard } from "./free-boards.js";
import { FREE_MAPPERS, decodeJobBody, type FreeCandidate } from "./free-ats-mappers.js";

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

/**
 * Per-platform in-flight limits, because the platforms do not tolerate the same
 * rate.
 *
 * MEASURED 2026-08-20, on the first full sweep after the sponsor-board import took
 * the registry from 285 to 623: 40 boards failed, and 34 of those were Recruitee
 * answering HTTP 429. Recruitee serves each customer from its own subdomain but
 * rate-limits the caller, so eight in flight is a burst it refuses — the same 26
 * boards came back healthy at two during the import's retry pass.
 *
 * Groups run in parallel, so the ceiling is the sum (26) rather than 8. That is
 * MORE total traffic and LESS per origin: before this, all eight in-flight slots
 * could land on boards-api.greenhouse.io at once. Each platform is now bounded on
 * its own terms.
 */
export const PLATFORM_CONCURRENCY: Readonly<Record<FreeAts, number>> = {
  greenhouse: BOARD_CONCURRENCY,
  lever: BOARD_CONCURRENCY,
  ashby: BOARD_CONCURRENCY,
  recruitee: 2,
};

/**
 * How many times one board is asked before it counts as failed.
 *
 * Three, not more. The sweep polls 623 boards inside a 30-minute window, and the
 * failure this bounds is a rate limit that clears in a second or two — a fourth
 * attempt buys almost nothing and costs every board in the queue behind it.
 */
export const BOARD_ATTEMPTS = 3;

/** Base unit of the backoff. Recruitee's window clears well inside a second. */
const RETRY_BASE_MS = 400;

/**
 * Statuses worth asking again.
 *
 * 429 is the one that matters and the reason this exists. The 5xx family is
 * included because a host that is briefly down is not a dead board, and the
 * alternative reading — treating it as one — is how a healthy company silently
 * leaves the registry. EVERYTHING ELSE IS NOT RETRIED, and 404 is the case that
 * proves the rule: a rotated token 404s forever, so retrying it is pure delay
 * charged to every board still queued behind it.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** Carries the HTTP status so the retry decision is made on the code, not on a string. */
class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

/**
 * How long to wait before attempt `attempt + 1`, in ms.
 *
 * Exponential with FULL JITTER, and the jitter is not cosmetic: `PLATFORM_
 * CONCURRENCY.recruitee` sends boards at the limiter in a steady stream, so a
 * fixed backoff would retry them in lockstep and reproduce the same burst that
 * earned the 429. `random` is a parameter rather than a call to Math.random so
 * the growth and the ceiling are assertable without a flaky test.
 */
export function retryDelayMs(attempt: number, random: number): number {
  const ceiling = RETRY_BASE_MS * 2 ** (attempt - 1);
  return Math.round(ceiling * (0.5 + 0.5 * random));
}

/** Injectable wait, so the retry tests do not spend real seconds proving a delay. */
export interface FetchBoardDeps {
  readonly sleep: (ms: number) => Promise<void>;
}

const realSleep: FetchBoardDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

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
    case "recruitee":
      return `https://${token}.recruitee.com/api/offers/`;
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
      throw new HttpStatusError(response.status);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether asking this host again could plausibly produce a different answer.
 *
 * A non-HTTP throw is a transport failure or our own abort — a socket reset or a
 * host that took longer than BOARD_TIMEOUT_MS — and those are transient by
 * nature, so they retry. Only a definite HTTP answer outside RETRYABLE_STATUSES
 * is taken as final.
 */
function isRetryable(err: unknown): boolean {
  return err instanceof HttpStatusError ? RETRYABLE_STATUSES.has(err.status) : true;
}

/**
 * Fetch and normalise one board, retrying the answers that mean "ask again".
 *
 * Returns a typed failure rather than throwing, because the caller's job is to
 * COUNT failures, not to be interrupted by them.
 *
 * THE MAPPER RUNS OUTSIDE THE RETRY. Normalisation is pure and deterministic, so
 * a mapper that throws will throw identically three times — retrying it would
 * turn one of our own bugs into three times the traffic at a third party.
 */
export async function fetchBoard(
  board: FreeBoard,
  deps: FetchBoardDeps = realSleep,
): Promise<BoardFetch> {
  let payload: unknown;

  for (let attempt = 1; ; attempt++) {
    try {
      payload = await fetchJson(boardUrl(board), BOARD_TIMEOUT_MS);
      break;
    } catch (err) {
      if (attempt >= BOARD_ATTEMPTS || !isRetryable(err)) {
        return { ok: false, board, error: (err as Error).message };
      }
      await deps.sleep(retryDelayMs(attempt, Math.random()));
    }
  }

  try {
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

/** Patterns beyond this are folded into a "+N more" tail rather than dropped. */
const SUMMARY_PATTERN_CAP = 6;

/**
 * Every failure in the sweep, as counts per (platform, reason).
 *
 * REPLACES `failures.slice(0, 3)`, which was the reporting half of the bug this
 * module's fourth failure rule describes: the ledger stored three strings, and
 * because the sweep polls Greenhouse first those three were always the same
 * harmless 404s. Thirty-six Recruitee rate limits per sweep never once appeared
 * anywhere the founder looks.
 *
 * Counts rather than names, because the founder's question is "is a platform
 * broken", not "which of 623 tokens". The names are still in the logs, and
 * `failures` itself is untouched for the callers that want them. Bounded on
 * purpose: a total outage must write a readable line to the ledger, not 623 of
 * them.
 */
export function summariseFailures(failures: readonly string[]): string {
  if (failures.length === 0) return "";

  const counts = new Map<string, number>();
  for (const failure of failures) {
    // Our own format, produced in sweepBoards: "<ats>/<token>: <error>".
    const match = /^([^/]+)\/[^:]*:\s*(.*)$/.exec(failure);
    const key = match ? `${match[1]} ${match[2]}` : failure;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = ranked.slice(0, SUMMARY_PATTERN_CAP).map(([key, n]) => `${key} ×${n}`);
  const hidden = ranked.length - shown.length;
  if (hidden > 0) shown.push(`+${hidden} other pattern(s)`);

  return `${failures.length} board(s) failed: ${shown.join("; ")}`;
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
  // Grouped by platform so each is bounded at its own rate (PLATFORM_CONCURRENCY).
  // Groups run concurrently, so a slow platform never serialises behind another.
  const byPlatform = new Map<FreeAts, FreeBoard[]>();
  for (const board of boards) {
    const group = byPlatform.get(board.ats);
    if (group) group.push(board);
    else byPlatform.set(board.ats, [board]);
  }

  const results = (
    await Promise.all(
      [...byPlatform].map(([ats, group]) =>
        mapWithConcurrencyLimit(group, PLATFORM_CONCURRENCY[ats], fetchBoard),
      ),
    )
  ).flat();

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

// decodeJobBody moved to free-ats-mappers.ts (2026-08-20) — Recruitee's
// mapper needs the same tag-to-space HTML decode this Greenhouse hydration
// step does, and mappers has no network dependency this file could import
// back from. Re-exported (imported above) so this module's existing public
// surface, and its tests, keep resolving unchanged.
export { decodeJobBody };
