/**
 * FounderOS — one candidate's half of the free sweep
 * ==================================================
 * `runFreeSweep` (sweep-runner.ts) polls the 3,223-board registry ONCE and hands
 * the same result to every registered profile. This file is what each profile
 * then does with it: screen, rank, publish, alert, record.
 *
 * Split out of sweep-runner.ts on 2026-09-08, when guarding the alert send —
 * the fix for a Telegram failure on the first profile silently skipping the
 * second — pushed that file past the 400-line CI budget
 * (`scripts/verify-architecture.ts`, loc-budget). Same precedent as the move
 * that created sweep-runner itself. A pure lift: no behaviour changed with the
 * file boundary.
 *
 * THE SEAM IS "SHARED vs PER-CANDIDATE". Everything upstream of here is one poll
 * that says nothing about who is looking; everything here is about one person —
 * their filters, their tracker, their verdicts, their ranking, their alert.
 *
 * TWO FAILURE RULES, both about not lying at the far end:
 *
 *   1. A LANE THAT SPOKE AND A LANE THAT FAILED TO SPEAK ARE DIFFERENT STATES.
 *      The heartbeat is written only after a send actually succeeds, because
 *      `afterSpokenSweep` resets the alive-ping clock — recording it on a failed
 *      send buys three more hours of silence on a message nobody received.
 *   2. ONE CANDIDATE'S FAILURE IS NOT ANOTHER'S. The caller wraps every call
 *      here in its own try/catch; nothing in this file may assume it is the only
 *      profile in the loop.
 */

import { childLogger } from "../../infra/logger.js";
import { sendToChat } from "../../infra/telegram-send.js";
import { esc } from "./telegram-format.js";
import { DEFAULT_PROFILE_ID, type JobSearchProfile } from "./profile-config.js";
import {
  afterQuietSweep,
  afterSpokenSweep,
  formatNewRowsAlert,
  initialHeartbeat,
  type HeartbeatState,
} from "./sweep-heartbeat.js";
import { loadLaneHeartbeat, saveLaneHeartbeat } from "../../db/job-heartbeat-queries.js";

const log = childLogger({ module: "scheduler" });

/**
 * Per-profile heartbeat state, persisted in `agents.job_lane_heartbeats` so it
 * survives restarts. See schema.ts for the migration history (2026-09-07).
 */
async function heartbeatFor(profileId: string): Promise<HeartbeatState> {
  const existing = await loadLaneHeartbeat(profileId);
  return existing ?? initialHeartbeat(new Date());
}

/**
 * Rebuild the Sheet and report either its link or why there isn't one.
 *
 * SENDS NOTHING. It returns one line for the caller to append to whatever
 * message it was already sending, because the two non-success paths coincide
 * exactly with the moments the founder is being messaged anyway — and an export
 * problem delivered as its own ⚠ would mean two notifications per sweep, every
 * sweep, until he set the spreadsheet up. Two messages for one event is how a
 * channel becomes noise.
 *
 * The two failures stay distinct in wording because they need opposite actions:
 * "not set up" is a step he has not taken, "could not be updated" is an outage.
 * Neither is ever silent — a lane that quietly stopped publishing looks exactly
 * like a market with no jobs in it.
 */
export async function publishSheet(): Promise<{ link: string | null; notice: string | null }> {
  const { exportJobSheet } = await import("./sheet-export.js");
  const { sheetLine } = await import("./sweep-heartbeat.js");

  const exported = await exportJobSheet();
  if (exported.ok) return { link: sheetLine(exported.url), notice: null };

  return {
    link: null,
    notice: esc(
      exported.skipped
        ? `⚠ The job sheet is not set up yet (${exported.reason}) — results are recorded, ask for the job brief to read them.`
        : `⚠ The job sheet could not be updated: ${exported.reason}`,
    ),
  };
}


export async function runFreeSweepForProfile(
  profile: JobSearchProfile,
  sweep: Awaited<ReturnType<typeof import("./free-ats-source.js").sweepBoards>>,
): Promise<void> {
  const { runFreeIngest } = await import("./free-ingest.js");

  let result: Awaited<ReturnType<typeof runFreeIngest>>;
  try {
    result = await runFreeIngest({ profile, sweep });
  } catch (err) {
    // Called by the cron (which wraps every sweep in its own `.catch()`, same
    // as the rest of startScheduler) AND directly by callers/tests. Either way
    // this runs unattended 48 times a day, so a crash must be loud in the logs
    // and must not reject — the founder's next signal is the next tick, not a
    // Node "unhandled rejection" nobody is watching for.
    log.error(
      { err: (err as Error).message, profile: profile.id },
      "Free board sweep crashed before it could screen anything",
    );
    return;
  }

  log.info(
    {
      profile: profile.id,
      boardsPolled: result.boardsPolled,
      seen: result.seen,
      screened: result.screened,
      failures: result.failures.length,
    },
    "Free board sweep complete",
  );

  if (result.failures.length > 0 && result.seen === 0) {
    // Same guard as runJobIngestSweep's, one layer down: a sweep that fetched
    // NOTHING while boards were failing must not read like a market with no jobs
    // in it. The predicate is `seen`, not `screened`, because a single dead board
    // among healthy ones still yields postings — one 404 next to 20,551 fetched
    // rows fired this alert every 30 minutes until it was the noise, not the
    // signal. `seen === 0` is the only state where the failures are the reason
    // there is nothing to report.
    log.warn(
      { failures: result.failures, profile: profile.id },
      "Free board sweep fetched nothing while boards were failing",
    );
    // Counts per (platform, reason) rather than the first three names: on a total
    // outage the three that happen to sort first say nothing about the cause, and
    // "recruitee HTTP 429 ×36" says all of it in five words.
    const { summariseFailures } = await import("./free-ats-source.js");
    await sendToChat(
      esc(
        `⚠ Free job lane failed for ${profile.candidateName} — nothing was fetched this sweep.\n` +
          summariseFailures(result.failures),
      ),
    );
    return;
  }

  // PASS **AND** FLAG, since 2026-09-08 (founder: "alerted every time we pass
  // them, whenever we find new roles"). A flagged row is a real role with one
  // open question, and for the NL-finance lane it is most of them — filtering to
  // `pass` meant her lane could rank roles into her brief and stay silent.
  // `reject` stays out: those are legally void, not pending.
  const newRoles = result.lines.filter(
    (line) => line.isNew && (line.outcome === "pass" || line.outcome === "flag"),
  );
  const now = new Date();

  // A sweep that found nothing does not touch the Sheet. Rewriting identical
  // rows 48 times a day spends API quota to produce no change, and it would
  // overwrite the `Applied` column between a founder's click and his next sync.
  if (newRoles.length === 0) {
    const { next, ping } = afterQuietSweep(
      await heartbeatFor(profile.id),
      result.boardsPolled,
      result.funnel,
      now,
      lastSheetLink,
      profile
    );
    await saveLaneHeartbeat(profile.id, next);
    if (ping !== null) await sendToChat(ping);
    return;
  }

  // Ranked BEFORE exported. `buildDailyBrief` is what writes `brief_section`
  // and `brief_rank`, and the Sheet's `#` column and the apply queue both read
  // those — exporting first would publish the new rows unranked and unnumbered.
  const { buildDailyBrief } = await import("./daily-brief.js");
  try {
    await buildDailyBrief({ screened: result.screened, failures: result.failures, notes: [], profile });
  } catch (err) {
    // The rows are screened and stored. An unranked Sheet is still worth
    // publishing — it just carries blank `#` cells, which is visibly wrong
    // rather than quietly wrong.
    log.error({ err: (err as Error).message }, "Ranking failed before free-lane export");
  }

  // The Sheet is a single document and belongs to the default profile. A second
  // candidate's rows reach the founder through her own brief alert and `/jobs
  // <profile>`, not by being interleaved into a spreadsheet whose `Applied`
  // column he clicks on Pushkar's behalf.
  const { link, notice } =
    profile.id === DEFAULT_PROFILE_ID ? await publishSheet() : { link: lastSheetLink, notice: null };
  if (profile.id === DEFAULT_PROFILE_ID) lastSheetLink = link;

  // SEND FIRST, RECORD ONLY ON SUCCESS. `afterSpokenSweep` resets the alive-ping
  // clock, so writing it after a send that threw would claim a message the
  // founder never received and buy another three hours of silence — the "quiet
  // lane and broken lane look identical" failure this heartbeat exists to
  // prevent. Leaving it unspoken is honest: the next quiet roll-up still pings.
  try {
    await sendToChat(formatNewRowsAlert(newRoles, link ?? notice, profile.candidateName));
  } catch (err) {
    log.error(
      { err: (err as Error).message, profile: profile.id, newRoles: newRoles.length },
      "New-roles alert could not be delivered — heartbeat deliberately left unspoken",
    );
    return;
  }
  await saveLaneHeartbeat(profile.id, afterSpokenSweep(now));
}


/**
 * The Sheet link, remembered between sweeps.
 *
 * The alive-ping wants to carry it, and a quiet sweep never calls the export —
 * so without this the ping would either have to run an export purely to learn
 * a URL that has not changed since the spreadsheet was created, or go out
 * without the link the founder needs to act on it.
 *
 * Module-local with a setter rather than exported directly, because the metered
 * sweep in sweep-runner.ts also refreshes it and an exported `let` is not
 * assignable across an ES module boundary.
 */
let lastSheetLink: string | null = null;

/** Remember the link the metered sweep just published. */
export function setLastSheetLink(link: string | null): void {
  lastSheetLink = link;
}
