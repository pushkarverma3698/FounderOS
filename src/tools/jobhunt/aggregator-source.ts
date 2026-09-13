/**
 * FounderOS — aggregator sweep orchestrator
 * ===========================================
 * Poll every registered aggregator API and convert their jobs into the same
 * `FreeCandidate` shape the ATS board sweep produces, so the entire downstream
 * pipeline (filtering, dedup, screening, alerting) works unchanged.
 *
 * BOARD TOKEN HARVESTING. Every aggregator job carries a URL pointing back to
 * the original posting, often on a known ATS platform (Greenhouse, Lever, etc.).
 * `extractBoardToken` from board-token.ts harvests those URLs into board tokens
 * that get appended to the discovered registry — so one aggregator sweep
 * discovers boards that every future ATS sweep polls directly, forever.
 *
 * WHY SEQUENTIAL. Each aggregator has its own rate limit policy. Arbeitnow is
 * polite-use, Remotive is 2 req/min, Himalayas returns 429 on bursts. Running
 * them one after another is both simpler and safer than concurrent requests
 * against hosts with very different tolerance thresholds.
 */

import { childLogger } from "../../infra/logger.js";
import type { NormalizedJob as FreeCandidate } from "./adapters/types.js";
import type { FreeBoard, FreeAts } from "./free-boards.js";
import { extractBoardToken, type ExtractedBoardToken } from "./board-token.js";
import { getAllAggregatorSources, type AggregatorJob } from "./aggregators/index.js";

const log = childLogger({ module: "jobhunt:aggregator" });

/** Known prefixes that mistakenly end up in aggregator company name fields. */
export const GARBAGE_PREFIXES = [
  "job application for ",
  "apply for ",
] as const;

/** Known ATS suffixes that mistakenly end up in aggregator company name fields. */
export const ATS_SUFFIXES = [
  " - greenhouse",
  " - lever",
] as const;

/** Separators that sometimes appear when a job title and company are mashed together. */
export const COMPANY_SEPARATORS = [
  " @ ",
  " at ",
] as const;

/** Words that indicate a string is likely a job title rather than a company name. */
export const TITLE_SENIORITY_WORDS = [
  "senior", "staff", "lead", "manager", "director", "head", "principal", "vp"
] as const;

export const TITLE_ROLE_WORDS = [
  "engineer", "developer", "designer", "architect", "analyst", "specialist", 
  "coordinator", "consultant", "communications", "product", "system", "full-stack"
] as const;

/**
 * Attempts to extract a clean company name from a garbled aggregator string.
 * Strips ATS suffixes, known job application prefixes, and extracts the text
 * after a separator like ' @ ' or ' at '.
 */
export function sanitiseCompanyName(raw: string): string {
  let cleaned = raw.trim();
  if (!cleaned) return "";

  // 1. Strip known prefixes
  const lowerCleaned = cleaned.toLowerCase();
  for (const prefix of GARBAGE_PREFIXES) {
    if (lowerCleaned.startsWith(prefix)) {
      cleaned = cleaned.slice(prefix.length).trim();
      break;
    }
  }

  // 2. Extract after @ or at
  for (const sep of COMPANY_SEPARATORS) {
    const idx = cleaned.toLowerCase().lastIndexOf(sep);
    if (idx !== -1) {
      cleaned = cleaned.slice(idx + sep.length).trim();
      break; // Only extract from the last one
    }
  }

  // 3. Strip ATS suffixes
  for (const suffix of ATS_SUFFIXES) {
    if (cleaned.toLowerCase().endsWith(suffix)) {
      cleaned = cleaned.slice(0, cleaned.length - suffix.length).trim();
      break;
    }
  }

  return cleaned;
}

/**
 * Detects if a company name field is likely garbled with a job title or ATS noise.
 * Used for logging and alerting, not for blocking.
 */
export function isLikelyGarbledCompanyName(name: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();

  // If it contains obvious separators or ATS suffixes, it's garbled
  if (ATS_SUFFIXES.some(s => lower.includes(s))) return true;
  if (COMPANY_SEPARATORS.some(s => lower.includes(s))) return true;
  if (GARBAGE_PREFIXES.some(s => lower.startsWith(s))) return true;

  // Check if it looks like a job title
  const tokens = lower.split(/[^a-z0-9\-]+/);
  
  let hasSeniority = false;
  let hasRole = false;

  for (const token of tokens) {
    if ((TITLE_SENIORITY_WORDS as readonly string[]).includes(token)) hasSeniority = true;
    if ((TITLE_ROLE_WORDS as readonly string[]).includes(token)) hasRole = true;
    if (token === "engineer") {
      hasSeniority = true;
      hasRole = true;
    }
  }

  return hasSeniority && hasRole;
}

/** Marks a board that exists only to carry an aggregator job's company name. */
export const AGGREGATOR_TOKEN_PREFIX = "aggregator-";

/**
 * A synthetic FreeBoard for aggregator-sourced jobs.
 *
 * The downstream pipeline uses `board.name` as the company name and `board.ats`
 * to route adapter calls. Aggregator jobs have no board, so `ats` is a
 * placeholder — and the comment here used to justify it with "aggregator
 * candidates ALREADY carry their full description, they never need body
 * hydration", which the code does not guarantee: `toFreeCandidate` below sets
 * `description: null` whenever the aggregator returned an empty body, and
 * `hydrateDescriptions` would then build
 * `boards-api.greenhouse.io/v1/boards/aggregator-<source>/jobs/<id>` and fetch
 * it — a 404 at a third party, and a `bodyless` drop labelled with a platform
 * that had nothing to do with it.
 *
 * The token prefix is what makes the claim enforceable: `isSyntheticBoard` skips
 * hydration for these, so an empty aggregator body stays an empty body instead of
 * becoming someone else's 404.
 */
function syntheticBoard(company: string, source: string): FreeBoard {
  return {
    name: sanitiseCompanyName(company),
    ats: "greenhouse" as FreeAts, // placeholder — never used for fetching
    token: `${AGGREGATOR_TOKEN_PREFIX}${source}`,
    markets: [],
  };
}

/** Convert one aggregator job to the FreeCandidate shape. */
function toFreeCandidate(job: AggregatorJob): FreeCandidate {
  return {
    board: syntheticBoard(job.company, job.source),
    externalId: `${job.source}:${job.url}`,
    title: job.title,
    url: job.url,
    location: job.location,
    postedAt: job.postedAt,
    description: job.description.length > 0 ? job.description : null,
  };
}

export interface AggregatorSweepResult {
  /** Candidates in the same shape as ATS board sweep results. */
  readonly candidates: readonly FreeCandidate[];
  /** Board tokens harvested from aggregator job URLs. */
  readonly harvestedTokens: readonly ExtractedBoardToken[];
  /** Per-source job counts, for logging. */
  readonly sourceCounts: ReadonlyMap<string, number>;
  /** Sources that failed (returned 0 jobs due to errors). */
  readonly failures: readonly string[];
}

/**
 * Poll all aggregator APIs, convert to FreeCandidate[], and harvest board
 * tokens from their URLs.
 *
 * Never throws. Each source is independent: one failing does not block the
 * others. A source that returns zero jobs is not treated as a failure — an
 * aggregator with no EU jobs today is not broken, just quiet.
 */
export async function sweepAggregators(): Promise<AggregatorSweepResult> {
  const sources = getAllAggregatorSources();
  const allCandidates: FreeCandidate[] = [];
  const allTokens: ExtractedBoardToken[] = [];
  const sourceCounts = new Map<string, number>();
  const failures: string[] = [];
  const seenTokens = new Set<string>();

  for (const source of sources) {
    let jobs: readonly AggregatorJob[];
    try {
      jobs = await source.fetchJobs();
    } catch (err) {
      // allow-failopen: each aggregator is independent
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ source: source.name, err: msg }, "Aggregator source failed");
      failures.push(`${source.name}: ${msg}`);
      continue;
    }

    sourceCounts.set(source.name, jobs.length);

    for (const job of jobs) {
      allCandidates.push(toFreeCandidate(job));

      // Harvest board tokens from the job URL.
      const token = extractBoardToken(job.url);
      if (token !== null) {
        const key = `${token.ats}:${token.token}`;
        if (!seenTokens.has(key)) {
          seenTokens.add(key);
          allTokens.push(token);
        }
      }
    }
  }

  log.info(
    {
      sources: sources.length,
      candidates: allCandidates.length,
      tokens: allTokens.length,
      counts: Object.fromEntries(sourceCounts),
    },
    "Aggregator sweep complete",
  );

  return {
    candidates: allCandidates,
    harvestedTokens: allTokens,
    sourceCounts,
    failures,
  };
}
