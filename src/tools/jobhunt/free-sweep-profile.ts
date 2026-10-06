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
 *      The heartbeat is written only after the roles are safely buffered for the next batched message
 *      (alert-digest.ts), because `afterSpokenSweep` resets the alive-ping clock. Since 2026-10-05 this file sends
 *      nothing to the jobs group: lane-health notices go to the founder DM (lane-ops-notice.ts).
 *   2. ONE CANDIDATE'S FAILURE IS NOT ANOTHER'S. The caller wraps every call
 *      here in its own try/catch; nothing in this file may assume it is the only
 *      profile in the loop.
 */

import { childLogger } from "../../infra/logger.js";
import { sendLaneOps } from "./lane-ops-notice.js";
import { bufferAlerts } from "./alert-digest.js";
import { esc } from "./telegram-format.js";
import { DEFAULT_PROFILE_ID, type JobSearchProfile } from "./profile-config.js";
import {
  afterQuietSweep,
  afterSpokenSweep,
  initialHeartbeat,
  splitByPublishFreshness,
  type HeartbeatState,
} from "./sweep-heartbeat.js";
import { loadLaneHeartbeat, saveLaneHeartbeat } from "../../db/job-heartbeat-queries.js";
import { retiredLine } from "./board-failure.js";

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

  if (exported.skipped) {
    log.warn({ reason: exported.reason }, "Job sheet export skipped");
    return { link: null, notice: null };
  }

  return {
    link: null,
    notice: esc(`⚠ The job sheet could not be updated: ${exported.reason}`),
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
    await sendLaneOps(
      esc(
        `⚠ Free job lane failed for ${profile.candidateName} — nothing was fetched this sweep.\n` +
          summariseFailures(result.failures),
      ),
      { repeatKey: `fetched-nothing:${profile.id}` },
    );
    return;
  }

  // PASS **AND** FLAG, since 2026-09-08 (founder: "alerted every time we pass
  // them, whenever we find new roles"). A flagged row is a real role with one
  // open question, and for the NL-finance lane it is most of them — filtering to
  // `pass` meant her lane could rank roles into her brief and stay silent.
  // `reject` stays out: those are legally void, not pending.
  const stored = result.lines.filter(
    (line) => line.isNew && (line.outcome === "pass" || line.outcome === "flag"),
  );
  const now = new Date();

  // SPLIT ON PUBLICATION AGE, not on `isNew` (A5, 2026-09-08). `isNew` is a
  // fact about our tracker; a board joining the registry makes a month of its
  // back catalogue "new" to us, and every one of those rows used to ping as 🆕.
  // `newRoles` is what interrupts; `backfill` is counted and reported, never
  // dropped — see splitByPublishFreshness.
  const { fresh: newRoles, backfill } = splitByPublishFreshness(stored, now);

  // A sweep that found nothing does not touch the Sheet. Rewriting identical
  // rows 48 times a day spends API quota to produce no change, and it would
  // overwrite the `Applied` column between a founder's click and his next sync.
  //
  // THE PREDICATE IS `stored`, NOT `newRoles`. A sweep that stored only
  // backfill has genuinely done work: those rows need ranking or `/draft`
  // cannot address them, and the founder is owed the count. Gating on the fresh
  // half alone would have made a forty-role board import indistinguishable from
  // a dead sweep.
  if (stored.length === 0) {
    const { next, ping } = afterQuietSweep(
      await heartbeatFor(profile.id),
      result.boardsPolled,
      result.funnel,
      now,
      lastSheetLink,
      profile
    );
    await saveLaneHeartbeat(profile.id, next);
    // One line on how many boards are retired and why (#26), so a board gone for good is not silent.
    const retired = retiredLine(result.retired);
    if (ping !== null) await sendLaneOps(retired === "" ? ping : `${ping}\n${esc(retired)}`);
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

  // A SHEET PROBLEM IS AN OPERATOR FACT. It used to be appended to the group alert, so a sweep that found a role
  // also told the candidate that a spreadsheet export had failed. It goes to the founder DM now,
  // and the group message never carries a sheet line at all (the link is on the founder-facing pings).
  if (notice !== null) {
    try {
      await sendLaneOps(notice, { repeatKey: `sheet-notice:${profile.id}` });
    } catch (err) {
      // allow-failopen: the notice is a courtesy about the export; the roles and the heartbeat matter more.
      log.warn({ err: (err as Error).message, profile: profile.id }, "Sheet notice could not be delivered");
    }
  }

  // BUFFER, THEN RECORD. Nothing is sent to the group here: the roles wait in job_digest_state and one batched
  // message goes out at the next of three daily slots (alert-digest.ts, called from runFreeSweep after every
  // profile has run). If the buffer write throws, the sweep is NOT recorded as announced: the heartbeat is left
  // alone, so the next quiet roll-up still tells the founder the lane is alive, and the rows stay visible in
  // /jobs and /fresh.
  //
  // The heartbeat is reset here, not at send time: its job is "the lane is alive and doing work", and a sweep
  // that stored roles did work. The batch has its own marker (last_digest_at).
  // WHICH roles: `newRoles` interrupt, `backfill` is only counted (see splitByPublishFreshness).
  await bufferAlerts(profile.id, newRoles, backfill.length);
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
