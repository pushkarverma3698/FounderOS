/**
 * FounderOS — the paid sweep's token-harvest orchestration
 * ==========================================================
 * Stateful glue around the pure logic in board-token.ts: load what the free
 * lane already knows once per sweep, collect discoveries across every
 * pool/track query, write the new ones once at the end.
 *
 * Split out of ingest.ts (2026-08-20) purely to stay under the 400-line CI
 * budget (`scripts/verify-architecture.ts`, loc-budget) — the orchestration
 * itself is a straight lift, not a redesign.
 */

import { childLogger } from "../../infra/logger.js";
import { getFreeBoards, registerDiscoveredBoard } from "./free-boards.js";
import { harvestNewBoardTokens, type DiscoveredBoard, type HarvestableSighting } from "./board-token.js";

// Part of this module's own public surface (BoardHarvestState, flushBoardHarvest
// return it) — re-exported so a caller needs one import site, not two.
export type { DiscoveredBoard };

const log = childLogger({ module: "jobhunt:board-harvest" });

export interface BoardHarvestState {
  knownKeys: Set<string>;
  discovered: Map<string, DiscoveredBoard>;
}

/**
 * Snapshot what the free lane already knows, once, before the pool loop
 * starts. A broken or thin free-board registry must never take down a
 * metered sweep that has run fine without this feature for months — caught
 * here, not thrown into the caller.
 */
export function startBoardHarvest(sweepId: string): BoardHarvestState {
  try {
    return {
      knownKeys: new Set(getFreeBoards().map((b) => `${b.ats}:${b.token}`)),
      discovered: new Map(),
    };
  } catch (err) {
    log.warn(
      { sweepId, err: (err as Error).message },
      "Free board registry unreadable — skipping token harvest this sweep",
    );
    return { knownKeys: new Set(), discovered: new Map() };
  }
}

/**
 * Harvest one pool/track query's postings into the running state.
 *
 * Called BEFORE dedupe or screening — a rejected posting still proves its
 * company's board is worth polling forever (founder direction, 2026-08-20:
 * harvest at the fetch boundary, not after screening). `knownKeys` grows as
 * boards are found so the same company seen across two queries in one sweep
 * is only ever counted once.
 */
export function collectBoardTokens(
  state: BoardHarvestState,
  postings: readonly HarvestableSighting[],
): void {
  for (const board of harvestNewBoardTokens(postings, state.knownKeys)) {
    const key = `${board.ats}:${board.token}`;
    state.knownKeys.add(key);
    state.discovered.set(key, board);
  }
}

/**
 * Write every discovery once, after the whole sweep finishes — not
 * per-posting inside the pool loop, which would re-parse the registry on
 * every single discovery.
 *
 * A write failure is logged and skipped, never thrown: the posting itself
 * already went through `screenBatch`/`recordQueryCost` by this point, and a
 * filesystem error growing the free lane's registry is not the same class
 * of problem as the sweep itself failing.
 */
export async function flushBoardHarvest(
  state: BoardHarvestState,
  sweepId: string,
): Promise<readonly DiscoveredBoard[]> {
  const written: DiscoveredBoard[] = [];
  for (const board of state.discovered.values()) {
    try {
      await registerDiscoveredBoard(board);
      written.push(board);
    } catch (err) {
      log.warn(
        { sweepId, ats: board.ats, err: (err as Error).message },
        "Could not write a discovered board — the posting itself is still screened and stored",
      );
    }
  }
  if (written.length > 0) {
    log.info(
      { sweepId, boards: written.map((b) => `${b.ats}/${b.token}`) },
      "New free boards discovered — the free lane can now poll these forever",
    );
  }
  return written;
}
