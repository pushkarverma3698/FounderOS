/**
 * FounderOS — which billed pools a candidate's sweep queries
 * ==========================================================
 * The metered lane fans out one billed actor run per (pool × track). Which pools
 * are worth paying for is a fact about the CANDIDATE — their markets and their
 * right to work — so it is derived here from the profile rather than read off a
 * module constant that encodes one person's situation.
 *
 * Split out of ingest.ts on 2026-09-04 to keep that file inside the 400-line CI
 * budget (scripts/verify-architecture.ts, loc-budget).
 */

import { POOL_COUNTRY, POOL_ORDER, type SourcePool } from "./ats-source.js";
import type { IndeedCountry } from "./indeed-source.js";
import type { JobSearchProfile } from "./profile-config.js";

/**
 * Which billed pools to query for a candidate.
 *
 * Derived from the profile's own target countries so a Netherlands-only
 * candidate is never billed for an India pool. `eu-remote-global` is included
 * only for a profile that can actually take a remote contract — it deliberately
 * omits any location filter, so for a candidate whose right to work is tied to
 * one country its rows are mostly unusable and always billed.
 */
export function poolsForProfile(profile: JobSearchProfile): readonly SourcePool[] {
  const codes = new Set(profile.targetCountries.map((c) => c.code));
  const wantsRemote = profile.permitBases.includes("remote-contract");
  return POOL_ORDER.filter((pool) => {
    if (pool === "eu-remote-global") return wantsRemote;
    const country = POOL_COUNTRY[pool];
    return country === "unknown" ? false : codes.has(country);
  });
}
import { dedupePostings, screenBatch, INGEST_SOURCE, type IngestLine } from "./ingest-batch.js";
import { recordQueryCost } from "./ingest-ledger.js";
import { ATS_PRICING, INDEED_PRICING, estimateQueryCost } from "./cost.js";
import { startBoardHarvest, collectBoardTokens, flushBoardHarvest, type DiscoveredBoard } from "./board-harvest.js";
import { checkSweepBudget } from "./spend-gate.js";

/**
 * NL for the remote-with-a-Dutch-office pool; IN for the remote-contract pool.
 *
 * Deliberately not US or global: a US company hiring a contractor in India is
 * income, not a step toward the Netherlands (founder decision, 2026-07-31), and
 * mixing the two would blur what the campaign is actually measuring.
 */
export const INDEED_COUNTRIES: readonly IndeedCountry[] = ["NL", "IN"];

/**
 * Whether each country's Indeed query is restricted to remote roles.
 *
 * NL stays remote-only: a Dutch on-site role is already covered by the ATS
 * `netherlands` pool, and what Indeed adds there is the remote-contract channel.
 *
 * IN IS DELIBERATELY UNRESTRICTED, and this is a correction. Until 2026-08-01
 * both countries were pinned to `remote: "remote"`, so every on-site and hybrid
 * role in Bangalore, Hyderabad, Pune, NCR and Mumbai was unreachable — not
 * rejected, never asked for. He LIVES in India; on-site there is not a
 * compromise, it is most of the market. An unasked market and an empty one
 * produce the same zero, which is the failure direction this codebase treats as
 * the expensive one.
 */
export const INDEED_REMOTE: Record<IndeedCountry, "remote" | undefined> = {
  NL: "remote",
  IN: undefined,
};

/** The actor cannot apply `fromDays` alongside its remote filter, so we cut here. */
export const INDEED_MAX_AGE_DAYS = 3;
