/**
 * Import job boards from published ATS corpora
 * =============================================
 * Grows the free lane's board registry by JOINING a list of real employers to
 * open-source company→token mappings, instead of guessing slugs and probing
 * four ATS domains with them (`scripts/probe-sponsor-boards.ts`, superseded).
 *
 * TWO employer lists, one join, one verification path:
 *
 *   default        the IND recognised-sponsor register (12.9k legal entities)
 *   --employers    docs/strategy/data/nl-finance-employers.csv (curated brands)
 *
 * The second exists because the first cannot see Dutch finance. Measured
 * 2026-09-07: of 4,511 postings sampled across 120 registered boards, 177 were
 * located in the Netherlands at all and Tashi Goyal's FP&A/audit/KYC classifier
 * matched 73 — five of them in-market. The registry is overwhelmingly tech
 * companies on Greenhouse/Lever/Ashby, and a tech company in NL posts roughly one
 * junior finance role per fifty engineering ones. The employers who DO hire FP&A
 * and KYC at 0-4 years are registered under names the register writes and no board
 * ever does — `Coöperatieve Rabobank U.A.` versus a Workday corpus row reading
 * `Rabobank`; `Deloitte Accountants` versus `Deloitte Netherlands`. Both of those
 * boards were sitting unmatched in a corpus this script already downloads.
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
 *   pnpm jobhunt:import-boards --employers --dry-run
 *   pnpm jobhunt:import-boards --employers
 *
 * `--env-file=.env` is required (it is baked into the pnpm script) only because
 * verification reuses `fetchBoard`, which pulls in the logger and therefore the
 * Zod env schema. Nothing here touches the database or Telegram.
 *
 * Re-running IS the monthly refresh: it re-reads the register, re-joins, re-verifies
 * and appends only what is new. Tokens that have since died are reported, never
 * auto-removed — a transient outage must not silently shrink the registry.
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { mapWithConcurrencyLimit } from "../src/core/concurrency.js";
import {
  boardMatchKey,
  joinEmployerBoards,
  joinSponsorBoards,
  parseAtsCorpus,
  parseEmployerList,
  stripSiteSuffix,
  toBoardCsvRows,
  type AtsCorpusRow,
  type CandidateBoard,
} from "../src/tools/jobhunt/board-import.js";
import {
  boardsPathFrom,
  parseBoardRegistry,
  FREE_ATS_PLATFORMS,
  type BoardMarket,
  type FreeAts,
  type FreeBoard,
} from "../src/tools/jobhunt/free-boards.js";
import { countryFromLocation } from "../src/tools/jobhunt/country.js";
import { fetchBoard, BOARD_CONCURRENCY } from "../src/tools/jobhunt/free-ats-source.js";
import { WIFE_FINANCE_PROFILE } from "../src/tools/jobhunt/profiles/wife-nl-finance.js";
import {
  parseSponsorCsv,
  registerPathFrom,
  REPO_ROOT,
} from "../src/tools/jobhunt/sponsor-registry.js";

const NL_FINANCE_EMPLOYERS_PATH = resolve(
  REPO_ROOT,
  "docs/strategy/data/nl-finance-employers.csv",
);
const IN_TECH_EMPLOYERS_PATH = resolve(
  REPO_ROOT,
  "docs/strategy/data/in-tech-employers.csv",
);
const DE_TECH_EMPLOYERS_PATH = resolve(
  REPO_ROOT,
  "docs/strategy/data/de-tech-employers.csv",
);
const UK_SPONSOR_REGISTER_PATH = resolve(
  REPO_ROOT,
  "docs/strategy/data/uk-sponsors-work.csv",
);
const UK_FALLBACK_PATH = "/tmp/uk-sponsors-work.csv";

/**
 * The profile whose country vocabulary decides what "in the Netherlands" means
 * here. Borrowed rather than re-derived: it is the only NL-ONLY profile in the
 * repo, and `countryFromLocation` reads its city list — so this check answers the
 * question with exactly the strings the free lane will screen these boards under,
 * not with a second hand-written list of Dutch place names that could drift.
 */
const NL_ONLY_PROFILE = WIFE_FINANCE_PROFILE;

const CORPUS_BASE =
  "https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies";

/**
 * The floor below which an upstream corpus is treated as broken rather than small.
 *
 * A truncated third-party file and a market with no sponsors on that platform
 * produce the same number of candidates at the far end, and that ambiguity is the
 * exact failure `MIN_EXPECTED_BOARDS` already guards against on our own registry.
 * Set at roughly 70% of the row counts observed on 2026-08-20 (greenhouse 6,032 ·
 * lever 2,403 · ashby 3,449 · recruitee 1,165), 2026-08-21 (smartrecruiters
 * 2,747 · workable 4,268) and 2026-08-22 (personio 2,463), so ordinary upstream
 * churn passes and a fetch that silently returned a fragment does not.
 */
const CORPUS_FLOORS: Readonly<Record<FreeAts, number>> = {
  greenhouse: 4000,
  lever: 1600,
  ashby: 2400,
  recruitee: 800,
  smartrecruiters: 1900,
  workable: 2900,
  personio: 1700,
  // Added 2026-08-24 at ~70% of the rows observed that day: workday 3,530 ·
  // teamtailor 1,464 · bamboohr 5,632.
  workday: 2400,
  teamtailor: 1000,
  bamboohr: 3900,
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
  /** How many of the postings this board returned are located in the Netherlands. */
  readonly nlPostings: number;
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

async function pollOnce(board: CandidateBoard, market: BoardMarket = "NL"): Promise<Verified> {
  const result = await fetchBoard({
    name: board.name,
    ats: board.ats,
    token: board.token,
    markets: [market],
  });
  if (!result.ok) return { board, live: false, error: result.error, nlPostings: 0 };

  const nlPostings = result.candidates.filter(
    (c) => countryFromLocation(c.location, NL_ONLY_PROFILE) === "NL",
  ).length;
  return { board, live: true, error: null, nlPostings };
}

/**
 * Poll each candidate, at the same concurrency the sweep itself uses.
 *
 * Reuses `fetchBoard` rather than re-deriving the URL shapes, so a candidate is
 * verified by exactly the request the free lane will make of it every 30 minutes.
 * A board that verifies here but 404s there would mean the two disagreed, which is
 * the one thing this step exists to rule out.
 */
async function verifyLive(
  candidates: readonly CandidateBoard[],
  market: BoardMarket = "NL",
): Promise<Verified[]> {
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

    for (const verified of await mapWithConcurrencyLimit(pending, limit, (b) => pollOnce(b, market))) {
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

/**
 * Load whichever employer list this run joins against, and say how big it is.
 *
 * Both branches refuse an empty list for the same reason: joining against nothing
 * imports nothing and reads, from the far end, exactly like a market with no
 * employers left to add.
 */
interface JoinSource {
  readonly describe: string;
  readonly market: BoardMarket;
  readonly isEmployerMode: boolean;
  readonly join: (
    existing: readonly FreeBoard[],
    corpora: ReadonlyMap<FreeAts, readonly AtsCorpusRow[]>,
  ) => CandidateBoard[];
  /**
   * The names worth reporting as UNMATCHED afterwards. Populated for the curated
   * list only: hand-written brands that found no board is the single most
   * useful thing this run can tell whoever maintains that file, while 12.9k
   * unmatched legal entities is the register's normal state and says nothing.
   */
  readonly reportUnmatched: readonly string[];
}

function loadJoin(args: readonly string[]): JoinSource {
  if (args.includes("--in-tech")) {
    const brands = parseEmployerList(readFileSync(IN_TECH_EMPLOYERS_PATH, "utf8"));
    if (brands.length === 0) {
      throw new Error(`The employer list at ${IN_TECH_EMPLOYERS_PATH} parsed to zero entries.`);
    }
    return {
      describe: `Employers: ${brands.length} curated Indian tech employers (${IN_TECH_EMPLOYERS_PATH})`,
      market: "IN",
      isEmployerMode: true,
      join: (existing, corpora) => joinEmployerBoards(brands, corpora, existing),
      reportUnmatched: brands.map((b) => b.name),
    };
  }

  if (args.includes("--de-tech")) {
    const brands = parseEmployerList(readFileSync(DE_TECH_EMPLOYERS_PATH, "utf8"));
    if (brands.length === 0) {
      throw new Error(`The employer list at ${DE_TECH_EMPLOYERS_PATH} parsed to zero entries.`);
    }
    return {
      describe: `Employers: ${brands.length} curated German tech employers (${DE_TECH_EMPLOYERS_PATH})`,
      market: "DE",
      isEmployerMode: true,
      join: (existing, corpora) => joinEmployerBoards(brands, corpora, existing),
      reportUnmatched: brands.map((b) => b.name),
    };
  }

  if (args.includes("--uk")) {
    const filePath = existsSync(UK_SPONSOR_REGISTER_PATH)
      ? UK_SPONSOR_REGISTER_PATH
      : UK_FALLBACK_PATH;
    if (!existsSync(filePath)) {
      throw new Error(
        `UK sponsor register not found at ${filePath}. ` +
          `Download it with: curl -sL "https://assets.publishing.service.gov.uk/media/6a9ea0529a177a1decf97ed8/SP_-_Worker_and_Temporary_Worker_Web_Register_-_2026-09-07.csv" -o ${UK_FALLBACK_PATH}`,
      );
    }
    const sponsors = parseSponsorCsv(readFileSync(filePath, "utf8"));
    if (sponsors.length === 0) {
      throw new Error(`The UK sponsor register at ${filePath} parsed to zero entries.`);
    }
    return {
      describe: `Register: ${sponsors.length} UK Home Office licensed sponsors (${filePath})`,
      market: "UK",
      isEmployerMode: false,
      join: (existing, corpora) => joinSponsorBoards(sponsors, corpora, existing),
      reportUnmatched: [],
    };
  }

  const employersPathIndex = args.indexOf("--employers-path");
  if (employersPathIndex !== -1 && args[employersPathIndex + 1]) {
    const filePath = resolve(process.cwd(), args[employersPathIndex + 1]!);
    const brands = parseEmployerList(readFileSync(filePath, "utf8"));
    if (brands.length === 0) {
      throw new Error(`The employer list at ${filePath} parsed to zero entries.`);
    }
    const marketIndex = args.indexOf("--market");
    const market = (marketIndex !== -1 ? args[marketIndex + 1] : "NL") as BoardMarket;
    return {
      describe: `Employers: ${brands.length} brands (${filePath})`,
      market,
      isEmployerMode: true,
      join: (existing, corpora) => joinEmployerBoards(brands, corpora, existing),
      reportUnmatched: brands.map((b) => b.name),
    };
  }

  if (args.includes("--employers")) {
    const brands = parseEmployerList(readFileSync(NL_FINANCE_EMPLOYERS_PATH, "utf8"));
    if (brands.length === 0) {
      throw new Error(
        `The employer list at ${NL_FINANCE_EMPLOYERS_PATH} parsed to zero entries. ` +
          `Joining against an empty list would import nothing and look like a covered market.`,
      );
    }
    return {
      describe: `Employers: ${brands.length} curated NL finance brands (${NL_FINANCE_EMPLOYERS_PATH})`,
      market: "NL",
      isEmployerMode: true,
      join: (existing, corpora) => joinEmployerBoards(brands, corpora, existing),
      reportUnmatched: brands.map((b) => b.name),
    };
  }

  const registerPath = registerPathFrom();
  const sponsors = parseSponsorCsv(readFileSync(registerPath, "utf8"));
  if (sponsors.length === 0) {
    throw new Error(
      `The sponsor register at ${registerPath} parsed to zero entries. ` +
        `Joining against an empty register would import nothing and look like an empty market.`,
    );
  }
  return {
    describe: `Register: ${sponsors.length} recognised sponsors (${registerPath})`,
    market: "NL",
    isEmployerMode: false,
    join: (existing, corpora) => joinSponsorBoards(sponsors, corpora, existing),
    reportUnmatched: [],
  };
}

/**
 * Say what happened to every brand that produced no NEW candidate — and split
 * the two reasons apart, because they ask for opposite work.
 *
 * `already polled` means the list is doing its job and the registry got there
 * first; nothing to do. `NO CORPUS ROW` means the employer is unreachable by this
 * mechanism at all — it is on an ATS whose company→token corpus we do not
 * download (SuccessFactors, Taleo, a bespoke careers site), and no amount of
 * editing this list will find it. Collapsing the two into one "unmatched" count
 * is how a wall gets mistaken for a typo: the founder's rule is that a label
 * nobody defined is not information.
 *
 * Printed IN FULL. A truncated list sorted by collection order reports the least
 * interesting entries by construction.
 */
function reportBrandCoverage(
  brands: readonly string[],
  candidates: readonly CandidateBoard[],
  corpora: ReadonlyMap<FreeAts, readonly AtsCorpusRow[]>,
): void {
  const corpusKeys = new Set<string>();
  for (const rows of corpora.values()) {
    for (const row of rows) corpusKeys.add(boardMatchKey(stripSiteSuffix(row.name)));
  }

  const matched = new Set(candidates.map((c) => c.matchedSponsor));
  const rest = brands.filter((name) => !matched.has(name));
  const absent = rest.filter((name) => !corpusKeys.has(boardMatchKey(name)));
  const covered = rest.filter((name) => corpusKeys.has(boardMatchKey(name)));

  console.log(
    `\nBrand coverage: ${matched.size} produced a new candidate · ` +
      `${covered.length} already polled · ${absent.length} have NO CORPUS ROW`,
  );
  console.log(`\n  No corpus row on any of the ${corpora.size} platforms — unreachable without a new adapter:`);
  for (const name of absent) console.log(`    ${name}`);
  console.log(`\n  Already in the registry:`);
  for (const name of covered) console.log(`    ${name}`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const args = process.argv.slice(2);

  const source = loadJoin(args);
  console.log(source.describe);

  const registryPath = boardsPathFrom();
  const existing = parseBoardRegistry(readFileSync(registryPath, "utf8"));
  console.log(`Registry: ${existing.length} boards already polled (${registryPath})\n`);

  console.log("Fetching upstream ATS corpora:");
  const corpora = new Map<FreeAts, readonly AtsCorpusRow[]>();
  for (const ats of FREE_ATS_PLATFORMS) {
    corpora.set(ats, await fetchCorpus(ats));
  }

  const candidates = source.join(existing, corpora);
  console.log(`\nJoin: ${candidates.length} new candidate boards`);
  for (const ats of FREE_ATS_PLATFORMS) {
    const n = candidates.filter((c) => c.ats === ats).length;
    if (n > 0) console.log(`  ${ats.padEnd(12)} ${String(n).padStart(4)}`);
  }
  for (const c of candidates) {
    console.log(`    ${c.ats}/${c.token}  (${c.name})  ← ${c.matchedSponsor}`);
  }

  if (source.reportUnmatched.length > 0) {
    reportBrandCoverage(source.reportUnmatched, candidates, corpora);
  }

  if (candidates.length === 0) {
    console.log("\nNothing new to import. The registry already covers every joinable sponsor.");
    return;
  }

  console.log(`\nVerifying all ${candidates.length} live (concurrency ${BOARD_CONCURRENCY})…`);
  const verified = await verifyLive(candidates, source.market);
  const dead = verified.filter((v) => !v.live);

  console.log(`  live: ${verified.length - dead.length}   dead: ${dead.length}`);
  for (const d of dead) {
    console.log(`    dead  ${d.board.ats}/${d.board.token}  (${d.board.name}) — ${d.error}`);
  }

  // In employer mode the join key is a BRAND, and a brand is not a country. It
  // cannot tell `Deloitte Netherlands` from `Deloitte Nordic`, `Deloitte AT` or
  // the `Deloitte` on SmartRecruiters that turns out to be Australia — all four
  // reduce to the same key, and all four are live. The postings themselves can:
  // a board that answered with work in the target market is the right entity's
  // board, and one that answered with none is another country's. Scoped to NL
  // employer mode specifically: the IN/DE/UK employer lists key on national
  // corpora (in-tech, de-tech, UK sponsor register) that don't share this
  // cross-region brand collision the same way, and the sponsor-register mode
  // does not apply this filter at all — its rows are legal entities in the
  // target country by construction.
  //
  // Reported by name, never silently dropped, and NOT permanent — this import is
  // re-runnable, so a genuinely in-market employer that happened to be between
  // vacancies today is picked up by the next run rather than blacklisted.
  const offMarket = source.isEmployerMode && source.market === "NL"
    ? verified.filter((v) => v.live && v.nlPostings === 0)
    : [];
  const live = verified
    .filter((v) => v.live && (!source.isEmployerMode || source.market !== "NL" || v.nlPostings > 0))
    .map((v) => v.board);

  if (source.isEmployerMode && source.market === "NL") {
    console.log(`  with NL postings: ${live.length}   live but no NL postings: ${offMarket.length}`);
    for (const v of verified.filter((x) => x.live && x.nlPostings > 0)) {
      console.log(`    keep  ${v.board.ats}/${v.board.token}  (${v.board.name}) — ${v.nlPostings} NL`);
    }
    for (const v of offMarket) {
      console.log(`    skip  ${v.board.ats}/${v.board.token}  (${v.board.name}) — 0 NL postings`);
    }
  }

  const rows = toBoardCsvRows(live, source.market);
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
