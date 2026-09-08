/**
 * FounderOS — the discovered half of the free-board registry
 * ===========================================================
 * `free-boards.ts` READS the curated registry; this file WRITES the one the
 * pipeline grows for itself. Split out of it on 2026-09-08 for the 400-line CI
 * budget (`scripts/verify-architecture.ts`, loc-budget) — a pure lift, and a
 * seam that was already implicit: one file is a data file the repo ships, the
 * other is state the running system accumulates.
 *
 * NO LOGGER HERE either, for the same reason free-boards.ts has none — see that
 * file's header. Callers log the outcome.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { BoardMarket, FreeAts } from "./free-boards.js";
import { resetFreeBoardsCache } from "./free-boards.js";

/**
 * Where boards the paid sweep discovers along the way get written.
 *
 * Deliberately NOT the curated CSV. That file lives inside the deploy's git
 * tree, and a discovery appended to it on prod would conflict with or get
 * silently wiped by the next `git pull` — the exact same class of defect as
 * writing prod secrets into a tracked file. Default matches the per-track CV
 * convention (`/opt/founderos-data/...`): real data, outside the repo.
 */
export const FREE_ATS_DISCOVERED_PATH = "/opt/founderos-data/free-ats-discovered.csv";

export function discoveredBoardsPathFrom(
  env: Record<string, string | undefined> = process.env,
): string {
  return env["FREE_ATS_DISCOVERED_PATH"] ?? FREE_ATS_DISCOVERED_PATH;
}

const DISCOVERED_HEADER = "name,ats,board_token,markets\n";

/**
 * Append one board the paid sweep found to the discovered registry.
 *
 * Fire-and-forget from the caller's perspective is wrong here on purpose:
 * the caller (ingest.ts) awaits this and logs a failure, because a harvest
 * that silently stops writing is indistinguishable from a market that
 * stopped producing new companies — the same ambiguity this whole registry
 * exists to avoid. What it must NEVER do is throw into a screening run: a
 * filesystem error harvesting tokens must not turn a successful screen into
 * `outcome: "error"` for the posting that happened to name it.
 */
export async function registerDiscoveredBoard(board: {
  readonly name: string;
  readonly ats: FreeAts;
  readonly token: string;
  readonly markets: readonly BoardMarket[];
}): Promise<void> {
  const path = discoveredBoardsPathFrom();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const needsHeader = !existsSync(path);
  const row =
    `${csvField(board.name)},${board.ats},${csvField(board.token)},` +
    `${csvField(board.markets.join("|"))}\n`;

  await appendFile(path, needsHeader ? DISCOVERED_HEADER + row : row, "utf8");
  resetFreeBoardsCache();
}

/** Quote a CSV field only when it needs it — matches parseCsvLine's own contract. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
