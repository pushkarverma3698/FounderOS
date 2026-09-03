/**
 * FounderOS — screening a fetched batch
 * =====================================
 * The half of the ingest that is about BELIEVING what a feed returned, split out
 * of ingest.ts on 2026-08-01 when that file crossed its size budget. ingest.ts is
 * now about asking the feeds questions and paying for the answers; this module is
 * about turning a pile of postings into verdicts without losing any of them.
 *
 * Both jobs fail differently, which is the argument for the split: a broken fetch
 * is an outage, while a posting that blows up mid-screen is one bad row among
 * nine good ones. Neither may be allowed to look like the other.
 */

import { childLogger } from "../../infra/logger.js";
import type { RawPosting } from "./ats-source.js";
import { dedupeKey } from "./filters.js";
import { screenPosting } from "./screen.js";
import type { JobSearchProfile } from "./profile-config.js";

const log = childLogger({ module: "tool:ingest_jobs" });

/** Provenance stamped on every row the ATS sweep creates. */
export const INGEST_SOURCE = "ats-ingest";

export interface IngestLine {
  readonly company: string;
  readonly title: string;
  readonly outcome: "pass" | "flag" | "reject" | "duplicate" | "error";
  readonly detail: string;
  /**
   * Whether this posting had never been stored before.
   *
   * The feed bills per job RETURNED, so the cost of a sweep is fixed by supply
   * and the VALUE of one is fixed by how much of that supply is new. Only an
   * actual screening can answer it: an error never saw the tracker, and a
   * duplicate is by definition not new.
   */
  readonly isNew: boolean;
}

export interface IngestSummary {
  readonly fetched: number;
  readonly lines: readonly IngestLine[];
}

export type IngestResult =
  | { readonly ok: true; readonly summary: IngestSummary }
  | { readonly ok: false; readonly error: string };

/**
 * Screen a batch of already-fetched postings.
 *
 * Split out from the fetch so the batch behaviour is unit-testable without a
 * network call, and so a caller with postings from anywhere else can reuse it.
 *
 * One posting that blows up does NOT abort the batch. Losing nine good
 * screenings because the tenth had a malformed body would be the pipeline
 * failing at exactly the moment it is supposed to be unattended.
 */
export async function screenBatch(
  postings: readonly RawPosting[],
  profile?: JobSearchProfile,
): Promise<IngestLine[]> {
  const lines: IngestLine[] = [];

  for (const posting of postings) {
    try {
      const outcome = await screenPosting({
        company: posting.company,
        title: posting.title,
        description: posting.description,
        ...(posting.url ? { url: posting.url } : {}),
        ...(posting.postedAt ? { postedAt: posting.postedAt } : {}),
        ...(posting.country ? { country: posting.country } : {}),
        ...(posting.location ? { location: posting.location } : {}),
        source: posting.source ?? INGEST_SOURCE,
        ...(posting.externalId ? { externalId: posting.externalId } : {}),
        ...(profile ? { profile } : {}),
      });

      if (outcome.kind === "error") {
        lines.push({
          company: posting.company,
          title: posting.title,
          outcome: "error",
          detail: outcome.message,
          isNew: false,
        });
      } else if (outcome.kind === "duplicate") {
        lines.push({
          company: posting.company,
          title: posting.title,
          outcome: "duplicate",
          detail: `already in pipeline at stage "${outcome.stage}"`,
          isNew: false,
        });
      } else {
        lines.push({
          company: outcome.company,
          title: outcome.title,
          outcome: outcome.verdict.status,
          detail: outcome.verdict.reasons[0] ?? outcome.route,
          isNew: outcome.isNew,
        });
      }
    } catch (err) {
      lines.push({
        company: posting.company,
        title: posting.title,
        outcome: "error",
        detail: (err as Error).message,
        isNew: false,
      });
    }
  }

  return lines;
}

/**
 * Collapse postings the feed returned more than once IN ONE BATCH.
 *
 * The ATS feed repeats itself — AgileEngine came back five times in the
 * 2026-08-01 sweep, OnTheGoSystems twice at four apiece. The database upsert
 * collapses them so the BRIEF was always right, but every copy was screened
 * first: a duplicate re-ran the register lookup, the salary parse and the
 * experience gate, then overwrote the row it had just written. The visible cost
 * was `job_ingest_runs.screened` reporting work that bought nothing, which made
 * the cost-per-useful-posting figure — the whole reason that table exists —
 * quietly wrong.
 *
 * Keyed on `dedupeKey`, the same identity the database uses. A second key here
 * would drift from the one that actually prevents double-applying.
 */
export function dedupePostings(postings: readonly RawPosting[]): {
  unique: RawPosting[];
  collapsed: number;
} {
  const seen = new Set<string>();
  const unique: RawPosting[] = [];
  for (const posting of postings) {
    const key = dedupeKey(posting.company, posting.title);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(posting);
  }
  return { unique, collapsed: postings.length - unique.length };
}

