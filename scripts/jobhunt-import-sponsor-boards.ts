/**
 * Import IND-sponsor job boards from published ATS corpora
 * =========================================================
 * Grows the free lane's board registry by JOINING the recognised-sponsor register
 * to open-source company→token mappings, instead of guessing slugs and probing
 * four ATS domains with them (`scripts/probe-sponsor-boards.ts`, superseded).
 *
 * MEASURED 2026-08-20, live, against the 12,883-row register:
 *   probing gh/lever/ashby   → 0.36% hit rate, ~46 boards, never reached prod
 *   joining the same corpora → 202 boards on those same three platforms
 *   with Recruitee           → 318 candidates, 311 live when polled (97.8%)
 *   those 311 boards carried 10,361 live postings, 3,204 engineering-titled
 *
 * The join key is deliberately loose (see `boardMatchKey`), and that is only safe
 * because the `name` column written here is the ATS CORPUS's company name, never
 * the IND registered one. `free-ats-mappers.ts` screens postings under that name,
 * so writing the registered name would manufacture a `sponsor` verdict for every
 * posting on the board. Sponsorship stays a per-posting decision made downstream.
 *
 * Every candidate is VERIFIED LIVE before it is written. A token that 404s is
 * reported by name and dropped — a registry full of dead tokens degrades into the
 * same ambiguity the whole lane is built to avoid, where a broken poller and a
 * quiet market read identically.
 *
 *   pnpm jobhunt:import-boards --dry-run
 *   pnpm jobhunt:import-boards
 *
 * `--env-file=.env` is required (it is baked into the pnpm script) only because
 * verification reuses `fetchBoard`, which pulls in the logger and therefore the
 * Zod env schema. Nothing here touches the database or Telegram.
 *
 * Re-running IS the monthly refresh: it re-reads the register, re-joins, re-verifies
 * and appends only what is new. Tokens that have since died are reported, never
 * auto-removed — a transient outage must not silently shrink the registry.
 */

import { readFileSync, appendFileSync } from "node:fs";

import { mapWithConcurrencyLimit } from "../src/core/concurrency.js";
import {
  joinSponsorBoards,
  parseAtsCorpus,
  toBoardCsvRows,
  type AtsCorpusRow,
  type CandidateBoard,
} from "../src/tools/jobhunt/board-import.js";
import {
  boardsPathFrom,
  parseBoardRegistry,
  FREE_ATS_PLATFORMS,
  type FreeAts,
} from "../src/tools/jobhunt/free-boards.js";
import { fetchBoard, BOARD_CONCURRENCY } from "../src/tools/jobhunt/free-ats-source.js";
import { parseSponsorCsv, registerPathFrom } from "../src/tools/jobhunt/sponsor-registry.js";

const CORPUS_BASE =
  "https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies";

/**
 * The floor below which an upstream corpus is treated as broken rather than small.
 *
 * A truncated third-party file and a market with no sponsors on that platform
 * produce the same number of candidates at the far end, and that ambiguity is the
 * exact failure `MIN_EXPECTED_BOARDS` already guards against on our own registry.
 * Set at roughly 70% of the row counts observed on 2026-08-20 (greenhouse 6,032 ·
 * lever 2,403 · ashby 3,449 · recruitee 1,165), so ordinary upstream churn passes
 * and a fetch that silently returned a fragment does not.
 */
const CORPUS_FLOORS: Readonly<Record<FreeAts, number>> = {
  greenhouse: 4000,
  lever: 1600,
  ashby: 2400,
  recruitee: 800,
};

const FETCH_TIMEOUT_MS = 30_000;

async function fetchCorpus(ats: FreeAts): Promise<AtsCorpusRow[]> {
  const url = `${CORPUS_BASE}/${ats}.csv`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let csv: string;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    csv = await response.text();
  } catch (err) {
    throw new Error(`Could not fetch the ${ats} corpus from ${url}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const rows = parseAtsCorpus(csv);
  const floor = CORPUS_FLOORS[ats];
  if (rows.length < floor) {
    throw new Error(
      `The ${ats} corpus parsed only ${rows.length} rows (expected at least ${floor}). ` +
        `A truncated corpus and a platform with no sponsors on it look identical — ` +
        `refusing to import from it.`,
    );
  }

  console.log(`  ${ats.padEnd(12)} ${String(rows.length).padStart(5)} companies`);
  return rows;
}

interface Verified {
  readonly board: CandidateBoard;
  readonly live: boolean;
  readonly error: string | null;
}

/**
 * How a rate-limited candidate is retried.
 *
 * Recruitee answers 429 to a burst of eight, and 28 real boards — RTL, LOGEX,
 * LessonUp, Zara — came back "dead" on the first pass purely because of it. A 429
 * is the host asking us to slow down; treating it as proof the board does not
 * exist would drop a live employer from the registry permanently, which is the
 * silent-shrink failure this import is otherwise built to avoid. Only an answer
 * that survives a slow, patient retry counts as dead.
 */
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_CONCURRENCY = 2;
const RATE_LIMIT_BACKOFF_MS = 10_000;

const isRateLimited = (error: string): boolean => error.includes("429");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pollOnce(board: CandidateBoard): Promise<Verified> {
  const result = await fetchBoard({
    name: board.name,
    ats: board.ats,
    token: board.token,
    markets: ["NL"],
  });
  return result.ok
    ? { board, live: true, error: null }
    : { board, live: false, error: result.error };
}

/**
 * Poll each candidate, at the same concurrency the sweep itself uses.
 *
 * Reuses `fetchBoard` rather than re-deriving the URL shapes, so a candidate is
 * verified by exactly the request the free lane will make of it every 30 minutes.
 * A board that verifies here but 404s there would mean the two disagreed, which is
 * the one thing this step exists to rule out.
 */
async function verifyLive(candidates: readonly CandidateBoard[]): Promise<Verified[]> {
  const results = new Map<string, Verified>();
  let pending = [...candidates];
  let limit = BOARD_CONCURRENCY;

  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES && pending.length > 0; attempt++) {
    if (attempt > 0) {
      console.log(
        `  ${pending.length} rate-limited — retrying in ${RATE_LIMIT_BACKOFF_MS / 1000}s ` +
          `at concurrency ${limit}`,
      );
      await sleep(RATE_LIMIT_BACKOFF_MS);
    }

    for (const verified of await mapWithConcurrencyLimit(pending, limit, pollOnce)) {
      results.set(`${verified.board.ats}:${verified.board.token}`, verified);
    }

    pending = pending.filter((b) => {
      const v = results.get(`${b.ats}:${b.token}`);
      return v !== undefined && !v.live && isRateLimited(v.error ?? "");
    });
    limit = RATE_LIMIT_CONCURRENCY;
  }

  return [...results.values()];
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const registerPath = registerPathFrom();
  const sponsors = parseSponsorCsv(readFileSync(registerPath, "utf8"));
  if (sponsors.length === 0) {
    throw new Error(
      `The sponsor register at ${registerPath} parsed to zero entries. ` +
        `Joining against an empty register would import nothing and look like an empty market.`,
    );
  }
  console.log(`Register: ${sponsors.length} recognised sponsors (${registerPath})`);

  const registryPath = boardsPathFrom();
  const existing = parseBoardRegistry(readFileSync(registryPath, "utf8"));
  console.log(`Registry: ${existing.length} boards already polled (${registryPath})\n`);

  console.log("Fetching upstream ATS corpora:");
  const corpora = new Map<FreeAts, readonly AtsCorpusRow[]>();
  for (const ats of FREE_ATS_PLATFORMS) {
    corpora.set(ats, await fetchCorpus(ats));
  }

  const candidates = joinSponsorBoards(sponsors, corpora, existing);
  console.log(`\nJoin: ${candidates.length} new candidate boards`);
  for (const ats of FREE_ATS_PLATFORMS) {
    const n = candidates.filter((c) => c.ats === ats).length;
    if (n > 0) console.log(`  ${ats.padEnd(12)} ${String(n).padStart(4)}`);
  }

  if (candidates.length === 0) {
    console.log("\nNothing new to import. The registry already covers every joinable sponsor.");
    return;
  }

  console.log(`\nVerifying all ${candidates.length} live (concurrency ${BOARD_CONCURRENCY})…`);
  const verified = await verifyLive(candidates);
  const live = verified.filter((v) => v.live).map((v) => v.board);
  const dead = verified.filter((v) => !v.live);

  console.log(`  live: ${live.length}   dead: ${dead.length}`);
  for (const d of dead) {
    console.log(`    dead  ${d.board.ats}/${d.board.token}  (${d.board.name}) — ${d.error}`);
  }

  const rows = toBoardCsvRows(live);
  if (dryRun) {
    console.log(`\n--dry-run: would append ${rows.length} rows to ${registryPath}`);
    console.log(`           registry would become ${existing.length + rows.length} boards`);
    for (const row of rows.slice(0, 10)) console.log(`           ${row}`);
    if (rows.length > 10) console.log(`           … ${rows.length - 10} more`);
    return;
  }

  appendFileSync(registryPath, `${rows.join("\n")}\n`, "utf8");
  const after = parseBoardRegistry(readFileSync(registryPath, "utf8"));
  console.log(`\n✓ Appended ${rows.length} boards → ${registryPath}`);
  console.log(`  Registry: ${existing.length} → ${after.length} boards`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
