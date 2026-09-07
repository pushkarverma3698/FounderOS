/**
 * FounderOS — polling the free boards
 * ===================================
 * The network half of the free lane. Normalisation lives in free-ats-mappers.ts,
 * so everything here is about asking third-party hosts a question without
 * letting any one of them break the sweep.
 *
 * Rate limiting and pacing are governed per-platform via Bottleneck limiters
 * (free-ats-rate-limiter.ts) bounding both concurrency and requests-per-second.
 * Conditional request validators are persisted in Postgres (ats_board_cache)
 * to survive process restarts without cold-cache thrashing.
 */

import { childLogger } from "../../infra/logger.js";
import { mapWithConcurrencyLimit } from "../../core/concurrency.js";
import type { FreeAts, FreeBoard } from "./free-boards.js";
import { createEtagCache, type EtagCache } from "./free-ats-cache.js";
import { HttpStatusError, fetchJson, fetchPayload } from "./free-ats-transport.js";
import { getAdapter } from "./adapters/index.js";
import { decodeJobBody, type NormalizedJob as FreeCandidate } from "./adapters/types.js";
import {
  ATS_RATE_PROFILES,
  createPlatformLimiters,
  getSharedLimiters,
} from "./free-ats-rate-limiter.js";
import {
  saveBoardCacheEntry,
  touchBoardCacheEntry,
  recordBoardCacheFailure,
  loadBoardCacheEntries,
} from "../../db/ats-cache-queries.js";

// Re-exported so this module's public surface — and every test and caller that
// already imports from it — keeps resolving after the 2026-08-21 split.
export function boardUrl(board: FreeBoard): string {
  const adapter = getAdapter(board.ats);
  if (!adapter) throw new Error(`Unknown adapter: ${board.ats}`);
  return adapter.getBoardUrl(board);
}

export function jobBodyUrl(board: FreeBoard, externalId: string): string | null {
  const adapter = getAdapter(board.ats);
  if (!adapter) throw new Error(`Unknown adapter: ${board.ats}`);
  return adapter.getJobUrl(board, externalId);
}

export function extractBody(ats: FreeAts, payload: Record<string, unknown>): string {
  const adapter = getAdapter(ats);
  if (!adapter) throw new Error(`Unknown adapter: ${ats}`);
  return adapter.extractBody(payload);
}

// Ensure type is exported for backwards compatibility with tests and callers
export type { FreeCandidate };

const log = childLogger({ module: "jobhunt:free-ats" });

/** One board's list endpoint. Whole-board payloads, so more generous than a HEAD. */
export const BOARD_TIMEOUT_MS = 20_000;

/** One Greenhouse posting's body. Small payload, so a tighter bound. */
export const DESCRIPTION_TIMEOUT_MS = 10_000;

/** Legacy fallback default concurrency. */
export const BOARD_CONCURRENCY = 4;

/**
 * Per-platform in-flight limits, matching ATS_RATE_PROFILES maxConcurrent.
 * Exported for backwards compatibility with existing tests and callers.
 */
export const PLATFORM_CONCURRENCY: Readonly<Record<FreeAts, number>> = Object.freeze(
  Object.fromEntries(
    Object.entries(ATS_RATE_PROFILES).map(([ats, cfg]) => [ats, cfg.maxConcurrent]),
  ) as Record<FreeAts, number>,
);

/**
 * How many times one board is asked before it counts as failed.
 */
export const BOARD_ATTEMPTS = 3;

/** Base unit of the backoff. Recruitee's window clears well inside a second. */
const RETRY_BASE_MS = 400;

/** Maximum backoff delay when honoring server Retry-After headers (60 seconds). */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Statuses worth asking again.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/**
 * How long to wait before attempt `attempt + 1`, in ms.
 * Exponential with full jitter.
 */
export function retryDelayMs(attempt: number, random: number): number {
  const ceiling = RETRY_BASE_MS * 2 ** (attempt - 1);
  return Math.round(ceiling * (0.5 + 0.5 * random));
}

/** Injectable dependencies for board fetching. */
export interface FetchBoardDeps {
  readonly sleep: (ms: number) => Promise<void>;
}

export interface SweepDeps extends FetchBoardDeps {
  readonly limiters?: Record<FreeAts, import("bottleneck").default>;
}

const realSleep: FetchBoardDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Shared across the whole process and backed by PostgreSQL persistence.
 */
export const boardCache: EtagCache = createEtagCache({
  onSave: async (entry) => {
    await saveBoardCacheEntry(entry);
  },
  onTouch: async (url, status) => {
    await touchBoardCacheEntry(url, status);
  },
  onFailure: async (url, status) => {
    await recordBoardCacheFailure(url, status);
  },
});

let _cacheWarmed = false;

/** Warm the in-memory board cache from database if not already warmed. */
export async function warmBoardCache(cache: EtagCache = boardCache): Promise<void> {
  if (_cacheWarmed) return;
  const entries = await loadBoardCacheEntries();
  if (entries.length > 0) {
    cache.warmFromEntries(entries);
    log.info({ count: entries.length }, "Warmed ATS board cache from database");
  }
  _cacheWarmed = true;
}

/** Test seam: reset warmed flag so tests can re-warm. */
export function resetBoardCacheWarmed(): void {
  _cacheWarmed = false;
}

export type BoardFetch =
  | { readonly ok: true; readonly board: FreeBoard; readonly candidates: readonly FreeCandidate[] }
  | { readonly ok: false; readonly board: FreeBoard; readonly error: string };

/**
 * Whether asking this host again could plausibly produce a different answer.
 */
function isRetryable(err: unknown): boolean {
  return err instanceof HttpStatusError ? RETRYABLE_STATUSES.has(err.status) : true;
}

/**
 * Fetch and normalise one board, retrying the answers that mean "ask again".
 * Respects Retry-After header on 429 when present.
 */
export async function fetchBoard(
  board: FreeBoard,
  deps: FetchBoardDeps = realSleep,
): Promise<BoardFetch> {
  const adapter = getAdapter(board.ats);
  if (!adapter) {
    return { ok: false, board, error: `Unknown adapter for platform: ${board.ats}` };
  }

  const format = adapter.getWireFormat();
  const paging = adapter.paging;
  const payloads: unknown[] = [];

  try {
    for (let page = 0; page < (paging?.maxPages ?? 1); page++) {
      const offset = page * (paging?.pageSize ?? 0);
      const request = adapter.getBoardRequest?.(board, offset);
      const url = request?.url ?? adapter.getBoardUrl(board);

      let payload: unknown;
      for (let attempt = 1; ; attempt++) {
        try {
          payload = await fetchPayload(url, BOARD_TIMEOUT_MS, format, boardCache, request);
          break;
        } catch (err) {
          if (attempt >= BOARD_ATTEMPTS || !isRetryable(err)) throw err;
          let delayMs = retryDelayMs(attempt, Math.random());
          if (err instanceof HttpStatusError && err.status === 429 && err.retryAfterMs !== null) {
            delayMs = Math.min(Math.max(delayMs, err.retryAfterMs), MAX_RETRY_AFTER_MS);
          }
          await deps.sleep(delayMs);
        }
      }
      payloads.push(payload);

      if (!paging) break;
      const total = adapter.totalFrom?.(payload) ?? null;
      if (total === null || offset + paging.pageSize >= total) break;
    }
  } catch (err) {
    return { ok: false, board, error: (err as Error).message };
  }

  try {
    return { ok: true, board, candidates: payloads.flatMap((p) => adapter.listJobs(p, board)) };
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
 */
export function summariseFailures(failures: readonly string[]): string {
  if (failures.length === 0) return "";

  const counts = new Map<string, number>();
  for (const failure of failures) {
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
 * Poll every board in the registry using per-platform Bottleneck rate limiters.
 */
export async function sweepBoards(
  boards: readonly FreeBoard[],
  deps: SweepDeps = realSleep,
): Promise<BoardSweep> {
  await warmBoardCache(boardCache);

  const byPlatform = new Map<FreeAts, FreeBoard[]>();
  for (const board of boards) {
    const group = byPlatform.get(board.ats);
    if (group) group.push(board);
    else byPlatform.set(board.ats, [board]);
  }

  const limiters =
    deps.limiters ??
    (deps.sleep !== realSleep.sleep
      ? createPlatformLimiters({ zeroDelay: true })
      : getSharedLimiters());

  const results = (
    await Promise.all(
      [...byPlatform].map(([ats, group]) => {
        const limiter = limiters[ats];
        return Promise.all(group.map((board) => limiter.schedule(() => fetchBoard(board, deps))));
      }),
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
 */
export async function hydrateDescriptions(
  candidates: readonly FreeCandidate[],
): Promise<FreeCandidate[]> {
  return mapWithConcurrencyLimit(candidates, BOARD_CONCURRENCY, async (candidate) => {
    if (candidate.description !== null) return candidate;

    const adapter = getAdapter(candidate.board.ats);
    if (!adapter) return candidate;

    const url = adapter.getJobUrl(candidate.board, candidate.externalId);
    if (url === null) return candidate;

    try {
      const payload = (await fetchJson(url, DESCRIPTION_TIMEOUT_MS)) as Record<string, unknown>;
      const postedAt = adapter.postedAtFromDetail?.(payload) ?? candidate.postedAt;
      return { ...candidate, postedAt, description: adapter.extractBody(payload) || null };
    } catch (err) {
      log.warn(
        { board: candidate.board.token, id: candidate.externalId, err: (err as Error).message },
        "Could not fetch posting body",
      );
      return candidate;
    }
  });
}

export { decodeJobBody };
