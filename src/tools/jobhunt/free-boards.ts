/**
 * FounderOS — the free job-board registry
 * =======================================
 * The list of company job boards we can poll DIRECTLY, for nothing.
 *
 * Greenhouse, Lever and Ashby all serve their customers' boards through public,
 * unauthenticated JSON endpoints. There is no key, no quota and no per-job price,
 * which changes what a sweep is allowed to cost and therefore how often it may
 * run. The metered feed is billed per job returned, so it is swept every third
 * day and asks narrow questions; this one is free, so it can ask for the whole
 * board every half hour.
 *
 * WHAT THIS BUYS, measured 2026-08-06. Across these boards there were 16,126 live
 * postings, 1,739 of them published in the previous 24 hours, narrowing to ~137
 * genuinely relevant NL/India/remote engineering roles a day — roughly three per
 * 30-minute sweep. Against the metered feed's median 19.6-hour lag from
 * publication to ingest, polling the board itself closes that gap to minutes.
 *
 * KNOWN SKEW, stated because a silent one would be worse. This list was extracted
 * from a public dataset that leaned heavily toward gaming companies, so the board
 * mix is not a neutral sample of either market. The yield figures above were
 * measured against THIS list and already carry the skew. Growing the registry —
 * probing the IND recognised-sponsor register for board tokens is the obvious
 * next source — is deliberately follow-on work, not smuggled in here.
 *
 * The file is DATA, not code, so adding a company is an edit to a CSV rather than
 * a deploy. `scripts/verify-runtime-assets.ts` proves it still resolves from the
 * BUILT output on every `pnpm gate`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { REPO_ROOT, parseCsvLine } from "./sponsor-registry.js";

/** The three platforms with a public, unauthenticated board endpoint. */
export type FreeAts = "greenhouse" | "lever" | "ashby";

export const FREE_ATS_PLATFORMS: readonly FreeAts[] = ["greenhouse", "lever", "ashby"];

/**
 * Which market a board was sourced FOR — a provenance note, not a claim about
 * where its postings are.
 *
 * A board is a company, and a company posts wherever it hires. The country of a
 * given posting is decided from that posting's own location string, never from
 * this column. Recording it anyway is what makes "we are polling 24 Dutch-sourced
 * boards and 177 India-sourced ones" an answerable question when the yield from
 * one market looks wrong.
 */
export type BoardMarket = "NL" | "IN";

export interface FreeBoard {
  readonly name: string;
  readonly ats: FreeAts;
  /** The board's slug in its platform's URL. Case-sensitive on Ashby. */
  readonly token: string;
  readonly markets: readonly BoardMarket[];
}

export const FREE_BOARDS_PATH = resolve(REPO_ROOT, "docs/strategy/data/free-ats-boards.csv");

/**
 * Where the registry actually lives at runtime.
 *
 * Overridable by environment for the same reason the sponsor register is: an
 * operator who stores the file outside the repo should not have to patch code.
 */
export function boardsPathFrom(env: Record<string, string | undefined> = process.env): string {
  return env["FREE_ATS_BOARDS_PATH"] ?? FREE_BOARDS_PATH;
}

/**
 * The floor below which a parsed registry is treated as broken rather than small.
 *
 * A registry that loads but yields a handful of rows is the 2026-08-02 sponsor
 * outage wearing a different mask: the lane would run, report success, and poll
 * almost nothing — and a thin registry and a quiet market produce the same number
 * at the far end. The real file holds 238 boards; anything under 200 means the
 * parse or the file is wrong, and it must fail loudly at the gate.
 */
export const MIN_EXPECTED_BOARDS = 200;

function toFreeAts(value: string): FreeAts | null {
  const normalised = value.trim().toLowerCase();
  return (FREE_ATS_PLATFORMS as readonly string[]).includes(normalised)
    ? (normalised as FreeAts)
    : null;
}

function toMarkets(value: string): BoardMarket[] {
  return value
    .split("|")
    .map((m) => m.trim().toUpperCase())
    .filter((m): m is BoardMarket => m === "NL" || m === "IN");
}

/**
 * Parse the registry CSV. Pure, so the whole format contract is unit-testable
 * without touching a filesystem.
 *
 * A row naming a platform we cannot poll, or missing a token, is SKIPPED rather
 * than thrown on: one malformed line must not cost the other 237 boards their
 * sweep. Deduplicated on `(ats, token)` because the same company legitimately
 * appears under both market files, and polling a board twice would double every
 * request for nothing.
 */
export function parseBoardRegistry(csv: string): FreeBoard[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const boards: FreeBoard[] = [];
  const seen = new Set<string>();

  // Row 0 is the header (`name,ats,board_token,markets`).
  for (const line of lines.slice(1)) {
    const [name, ats, token, markets] = parseCsvLine(line);
    const platform = toFreeAts(ats ?? "");
    const slug = (token ?? "").trim();
    if (platform === null || slug.length === 0) continue;

    const key = `${platform}:${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);

    boards.push({
      name: (name ?? "").trim() || slug,
      ats: platform,
      token: slug,
      markets: toMarkets(markets ?? ""),
    });
  }

  return boards;
}

let cache: readonly FreeBoard[] | null = null;

/**
 * The registry, read once per process.
 *
 * Throws when the file is missing or parses thin. This is deliberately NOT
 * fail-open: a lane that silently polls zero boards reports "no new roles today"
 * in exactly the same words as a lane that polled 238 and found none, and that
 * ambiguity has already cost this pipeline weeks.
 */
export function getFreeBoards(): readonly FreeBoard[] {
  if (cache !== null) return cache;

  const path = boardsPathFrom();
  const boards = parseBoardRegistry(readFileSync(path, "utf8"));

  if (boards.length < MIN_EXPECTED_BOARDS) {
    throw new Error(
      `Free board registry at ${path} parsed only ${boards.length} boards ` +
        `(expected at least ${MIN_EXPECTED_BOARDS}). Polling a thin registry ` +
        `looks identical to an empty market — refusing to run on it.`,
    );
  }

  cache = boards;
  return cache;
}

/** Drop the memoised registry. Tests only. */
export function resetFreeBoardsCache(): void {
  cache = null;
}
