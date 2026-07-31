/**
 * FounderOS — posting liveness
 * ============================
 * Dedupe answers "have I seen this before". It does not answer "is this real and
 * still open" — and in every view the pipeline renders, a job filled three weeks
 * ago is indistinguishable from one posted this morning.
 *
 * The founder's constraint, verbatim (2026-07-31): *"We need to act upon real
 * and verified data not just deduping it."*
 *
 * THREE OUTCOMES, NOT TWO. `unverifiable` exists because the alternative is to
 * fold network failures into `expired`, and those two errors are not symmetric:
 *   · calling a dead job live  → the founder wastes one application
 *   · calling a live job dead  → the role disappears from the brief, silently,
 *                                and nothing anywhere records that it did
 * The second is the failure that compounds, so ambiguity resolves toward keeping
 * the row and saying so out loud.
 *
 * Verification runs on the RANKED SHORTLIST only, never the whole pipeline. The
 * shortlist is a handful of rows, so it is cheap, and it is the exact place a
 * wrong answer costs the most.
 */

import { childLogger } from "../../infra/logger.js";
import { lookupJobKeys, type JobKeyStatus } from "./indeed-source.js";
import { INDEED_SOURCE } from "./indeed-source.js";

const log = childLogger({ module: "jobhunt:liveness" });

export type Liveness = JobKeyStatus;

/** How long to wait on one posting URL before calling it unverifiable. */
const URL_CHECK_TIMEOUT_MS = 10_000;

export interface LivenessTarget {
  readonly id: string;
  readonly url: string | null;
  readonly source: string;
  /** Indeed's job key, when the row came from Indeed. */
  readonly externalId?: string | null;
}

export interface LivenessResult {
  readonly id: string;
  readonly liveness: Liveness;
  /** Why, in the founder's words — recorded on the row so nothing vanishes unexplained. */
  readonly reason: string;
}

/**
 * Classify an HTTP response into a liveness verdict.
 *
 * Pure, so the whole decision table is unit-testable without a network.
 *
 * 404/410 are the honest "gone" signals. A 3xx is NOT treated as gone: many ATS
 * platforms redirect a live posting to a canonical URL, and reading that as a
 * closure would expire half the pipeline. 5xx and 429 are the site's problem,
 * not the job's.
 */
export function classifyHttpStatus(status: number): Liveness {
  if (status === 404 || status === 410) return "expired";
  if (status >= 200 && status < 400) return "live";
  return "unverifiable";
}

/** Human-readable reason for a verdict, kept next to the verdict that produced it. */
export function livenessReason(liveness: Liveness, detail: string): string {
  if (liveness === "expired") return `Posting is gone: ${detail}`;
  if (liveness === "live") return `Confirmed still open: ${detail}`;
  return `Could not confirm still open (${detail}) — kept on the list; this is NOT evidence it closed.`;
}

/**
 * Check one posting URL.
 *
 * GET rather than HEAD: several ATS platforms answer HEAD with 405 while serving
 * the page fine, which would make a perfectly live posting unverifiable.
 */
async function checkUrl(url: string): Promise<{ liveness: Liveness; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal, redirect: "follow" });
    return { liveness: classifyHttpStatus(response.status), detail: `HTTP ${response.status}` };
  } catch (err) {
    return { liveness: "unverifiable", detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify a shortlist.
 *
 * Indeed rows go through the actor's `jobKeys` lookup, which reports `expired`
 * directly. Everything else is checked by fetching its posting URL. A row with
 * no URL and no job key is `unverifiable` — there is nothing to check, and
 * saying so is better than assuming either answer.
 */
export async function verifyLiveness(
  targets: readonly LivenessTarget[],
): Promise<LivenessResult[]> {
  if (targets.length === 0) return [];

  const indeedTargets = targets.filter(
    (t) => t.source === INDEED_SOURCE && typeof t.externalId === "string" && t.externalId.length > 0,
  );
  const keyStatuses = await lookupJobKeys(indeedTargets.map((t) => t.externalId as string));

  const results: LivenessResult[] = [];
  for (const target of targets) {
    if (target.source === INDEED_SOURCE && target.externalId) {
      const status = keyStatuses.get(target.externalId) ?? "unverifiable";
      results.push({
        id: target.id,
        liveness: status,
        reason: livenessReason(status, `Indeed job key ${target.externalId}`),
      });
      continue;
    }

    if (!target.url || target.url.trim().length === 0) {
      results.push({
        id: target.id,
        liveness: "unverifiable",
        reason: livenessReason("unverifiable", "no posting URL was recorded"),
      });
      continue;
    }

    const { liveness, detail } = await checkUrl(target.url);
    results.push({ id: target.id, liveness, reason: livenessReason(liveness, detail) });
  }

  log.info(
    {
      checked: results.length,
      live: results.filter((r) => r.liveness === "live").length,
      expired: results.filter((r) => r.liveness === "expired").length,
      unverifiable: results.filter((r) => r.liveness === "unverifiable").length,
    },
    "Liveness verification complete",
  );
  return results;
}
