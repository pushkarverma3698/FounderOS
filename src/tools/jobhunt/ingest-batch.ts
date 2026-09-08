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
  /**
   * When the EMPLOYER published it, or null when the source stated no date.
   *
   * Carried since 2026-09-08 because `isNew` above is a fact about our tracker
   * and the 🆕 alert was firing on it. Those two agree on a steady day and
   * diverge the moment a board is added to the registry: every posting on a new
   * board is `isNew`, including ones published a month ago. The alert splits on
   * THIS field now — see splitByPublishFreshness (sweep-heartbeat.ts).
   */
  readonly postedAt?: Date | null;
  /** The posting's link, so an alert can carry the action instead of a name. */
  readonly url?: string | null;
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
    // Off the POSTING, not off the screening outcome. The employer's date and
    // the apply link are facts the fetch already established; asking
    // `screenPosting` to hand them back would widen ScreenOutcome for data it
    // only ever passes through. Present on every branch below — including the
    // error one — because a row that failed to screen is still a row whose age
    // and link we know.
    const provenance = { postedAt: posting.postedAt ?? null, url: posting.url ?? null };
    try {
      const outcome = await screenPosting({
        company: posting.company,
        title: posting.title,
        description: posting.description,
        ...(posting.url ? { url: posting.url } : {}),
        ...(posting.postedAt ? { postedAt: posting.postedAt } : {}),
        // WHERE THE JOB IS, carried from the fetch. This is the value that used
        // to be dropped here: the feed knew the country, the screener then
        // re-guessed it from the ad's prose, and "hybrid" in an Indian posting
        // became a claim about a Dutch office.
        ...(posting.country ? { country: posting.country } : {}),
        ...(posting.location ? { location: posting.location } : {}),
        // The posting's OWN provenance, not this module's. An Indeed row screened
        // through here must not be recorded as an ATS row: liveness verification
        // reads that field to decide which check to run.
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
          ...provenance,
        });
      } else if (outcome.kind === "duplicate") {
        lines.push({
          company: posting.company,
          title: posting.title,
          outcome: "duplicate",
          detail: `already in pipeline at stage "${outcome.stage}"`,
          isNew: false,
          ...provenance,
        });
      } else {
        lines.push({
          company: outcome.company,
          title: outcome.title,
          outcome: outcome.verdict.status,
          detail: outcome.verdict.reasons[0] ?? outcome.route,
          isNew: outcome.isNew,
          ...provenance,
        });
      }
    } catch (err) {
      lines.push({
        company: posting.company,
        title: posting.title,
        outcome: "error",
        detail: (err as Error).message,
        isNew: false,
        ...provenance,
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

