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
 * KNOWN SKEW, stated because a silent one would be worse. The original 285 rows
 * were extracted from a public dataset that leaned heavily toward gaming
 * companies, so that slice is not a neutral sample of either market, and the
 * yield figures above were measured against it and carry the skew.
 *
 * 338 rows were added on 2026-08-20 by `scripts/jobhunt-import-sponsor-boards.ts`,
 * which JOINS the IND recognised-sponsor register to published ATS company→token
 * corpora rather than guessing slugs and probing for them. Every one of those is
 * an IND-recognised sponsor, verified live before it was written. Their `name`
 * column deliberately carries the ATS corpus's company name, NOT the registered
 * one — see the warning in board-import.ts, because this column is what
 * free-ats-mappers.ts screens postings under.
 *
 * The file is DATA, not code, so adding a company is an edit to a CSV rather than
 * a deploy. `scripts/verify-runtime-assets.ts` proves it still resolves from the
 * BUILT output on every `pnpm gate`.
 */

import { readFileSync, existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { REPO_ROOT, parseCsvLine } from "./sponsor-registry.js";

// NO LOGGER HERE, deliberately. `scripts/verify-runtime-assets.ts` dynamic-
// imports this module straight out of `dist/` with no guarantee of a full
// `.env` (DATABASE_URL, TELEGRAM_*) — that's the whole point of the check
// (2026-08-02: a resolution bug in a sibling data-file module broke prod for
// four days while every other gate stayed green). `infra/logger.js` pulls in
// the full Zod-validated env schema, so importing it here would fail that
// check outside a fully-configured environment. Callers (board-harvest.ts)
// log the outcomes of registerDiscoveredBoard/getFreeBoards instead.

/**
 * The four platforms with a public, unauthenticated board endpoint.
 *
 * Recruitee added 2026-08-20: measured against the 12,884-row IND sponsor
 * register, Greenhouse+Lever+Ashby matched 0.36% of companies (they are
 * overwhelmingly US-centric platforms; the register is overwhelmingly Dutch
 * SMEs). Recruitee+Personio+Homerun — what Dutch firms actually use — matched
 * 2.50%, all verified exact hits (`recruitee/dalsem` = Dalsem B.V.,
 * `recruitee/netconomy` = Netconomy Netherlands B.V., `recruitee/ravo` = Ravo
 * Holding B.V.).
 *
 * SmartRecruiters and Workable added 2026-08-21, both public JSON APIs. Joining
 * the 12,883-row register against their published corpora measured 145 and 86
 * IND-sponsor boards respectively.
 *
 * PERSONIO added 2026-08-22, and the objection recorded here before it is worth
 * keeping because every fact in it was right and the conclusion still did not
 * hold. `search.json` does carry no description, no URL and no date (re-verified,
 * 318 postings), so `/xml` is the only complete source, and it is ~2.26 MB per
 * board — 156 MB per sweep across 78 boards, which is what kept it out.
 *
 * That figure assumed every sweep re-downloads every board. Personio serves an
 * `ETag` and answers `If-None-Match` with a 0-byte 304 (verified live), and a
 * board changes maybe once a day, so the steady-state cost is a few hundred
 * bytes per unchanged board. The blocker was never the feed size; it was fetching
 * unconditionally. See free-ats-cache.ts.
 *
 * HOMERUN REMAINS EXCLUDED, now for a stated reason rather than an unprobed one
 * (2026-08-22). It has no public JSON API — developers.homerun.co requires Bearer
 * auth — and no `homerun.csv` exists in the ATS corpus every other platform's
 * tokens come from (404). Every `<token>.homerun.co` probed redirects to
 * `404.homerun.co/working_at/<token>`, so there is no way to tell a real board
 * from a typo. Adding it would mean guessing slugs, which is exactly what
 * probe-sponsor-boards.ts forbids: a wrong board is worse than no board. It
 * unblocks the moment a token corpus exists, or a sponsor's posting URL is seen
 * in the wild and harvested.
 */
export type FreeAts =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "recruitee"
  | "smartrecruiters"
  | "workable"
  | "personio";

export const FREE_ATS_PLATFORMS: readonly FreeAts[] = [
  "greenhouse",
  "lever",
  "ashby",
  "recruitee",
  "smartrecruiters",
  "workable",
  "personio",
];

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

/**
 * The floor below which a parsed registry is treated as broken rather than small.
 *
 * A registry that loads but yields a handful of rows is the 2026-08-02 sponsor
 * outage wearing a different mask: the lane would run, report success, and poll
 * almost nothing — and a thin registry and a quiet market produce the same number
 * at the far end. The real file holds 858 boards; anything under 700 means the
 * parse or the file is wrong, and it must fail loudly at the gate.
 *
 * Raised 200 → 500 on 2026-08-20 alongside the sponsor-board import, then
 * 500 → 700 on 2026-08-21 when SmartRecruiters and Workable took the registry
 * from 623 to 858. A floor that is not moved with the file stops being a floor:
 * left at 200 it would have gone on passing while two thirds of the registry
 * silently failed to parse, which is precisely the reading it exists to deny.
 */
export const MIN_EXPECTED_BOARDS = 700;

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
 * The registry: curated boards plus whatever the paid sweep has discovered,
 * read once per process.
 *
 * Throws when the CURATED file is missing or parses thin. This is
 * deliberately NOT fail-open: a lane that silently polls zero boards reports
 * "no new roles today" in exactly the same words as a lane that polled 238
 * and found none, and that ambiguity has already cost this pipeline weeks.
 *
 * The DISCOVERED file has no such floor and is read best-effort — it starts
 * empty and grows from nothing, so treating "missing" as fatal would make the
 * registry unable to ever start compounding. Curated wins a token collision:
 * hand-verified data is trusted over an auto-harvested guess.
 */
export function getFreeBoards(): readonly FreeBoard[] {
  if (cache !== null) return cache;

  const path = boardsPathFrom();
  const curated = parseBoardRegistry(readFileSync(path, "utf8"));

  if (curated.length < MIN_EXPECTED_BOARDS) {
    throw new Error(
      `Free board registry at ${path} parsed only ${curated.length} boards ` +
        `(expected at least ${MIN_EXPECTED_BOARDS}). Polling a thin registry ` +
        `looks identical to an empty market — refusing to run on it.`,
    );
  }

  const discoveredPath = discoveredBoardsPathFrom();
  let discovered: FreeBoard[] = [];
  try {
    if (existsSync(discoveredPath)) {
      discovered = parseBoardRegistry(readFileSync(discoveredPath, "utf8"));
    }
  } catch {
    // allow-failopen: a broken discovery file must not take down the curated
    // 285-board sweep that has always run without it. Not logged HERE (this
    // module stays logger-free, see the header) — board-harvest.ts logs the
    // outcome of the harvest path that writes this file.
  }

  const seen = new Set(curated.map((b) => `${b.ats}:${b.token}`));
  const newlyDiscovered = discovered.filter((b) => !seen.has(`${b.ats}:${b.token}`));

  cache = [...curated, ...newlyDiscovered];
  return cache;
}

/** Drop the memoised registry. Tests only. */
export function resetFreeBoardsCache(): void {
  cache = null;
}
