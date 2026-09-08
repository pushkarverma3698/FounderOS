/**
 * FounderOS — job lane sweep entrypoints
 * =======================================
 * The two periodic sweeps both job feeds hang their cron off of: the metered
 * ATS/Indeed sweep (`runJobIngestSweep`) and the free-board sweep
 * (`runFreeSweep`). `runJobIngestSweep`, `JOB_SWEEP_CRON` and
 * `JOB_INGEST_DAILY_LIMIT` moved here from `src/infra/scheduler.ts` verbatim on
 * 2026-08-06 — registering the free lane's cron there would have pushed that
 * file past the 400-line CI budget (`scripts/verify-architecture.ts`,
 * loc-budget). `scheduler.ts` re-exports the metered names, so no import site
 * or test had to change.
 *
 * Lives in tools/jobhunt, not infra: both sweeps are entirely job-lane logic —
 * fetch, screen, format, alert — and `infra/scheduler.ts`'s job stays only to
 * register the cron and swallow the promise, same as every other job it runs.
 */

import { childLogger } from "../../infra/logger.js";
import { sendToChat } from "../../infra/telegram-send.js";
import { esc } from "./telegram-format.js";
import { DEFAULT_PROFILE_ID } from "./profile-config.js";
import type { DiscoveredBoard } from "./board-token.js";
import { initialHeartbeat } from "./sweep-heartbeat.js";
import { clearLaneHeartbeats, saveLaneHeartbeat } from "../../db/job-heartbeat-queries.js";
// The per-candidate half of the free sweep, split out 2026-09-08 for the
// 400-line budget. `publishSheet` went with it because the free lane is its
// main caller; the metered sweep below imports it back.
import { publishSheet, runFreeSweepForProfile, setLastSheetLink } from "./free-sweep-profile.js";

const log = childLogger({ module: "scheduler" });

/** Names shown before the line falls back to a bare count. */
const NEW_BOARDS_NAME_CAP = 5;

/**
 * "+3 new companies now polled: Speechify, IMC, Roadie" — one extra line
 * inside the sweep's existing message, never its own notification. Two
 * messages for one event is how a channel becomes noise (see `publishSheet`
 * below, which states the same rule for the sheet-export failure line).
 */
export function newBoardsLine(newBoards: readonly DiscoveredBoard[]): string {
  if (newBoards.length === 0) return "";
  const names = newBoards
    .slice(0, NEW_BOARDS_NAME_CAP)
    .map((b) => esc(b.name))
    .join(", ");
  const overflow = newBoards.length > NEW_BOARDS_NAME_CAP ? ` +${newBoards.length - NEW_BOARDS_NAME_CAP} more` : "";
  const plural = newBoards.length === 1 ? "company" : "companies";
  return `\n<i>+${newBoards.length} new ${plural} now polled: ${names}${overflow}</i>`;
}

// 01:30 UTC = 07:00 IST, every THIRD day (founder decision, 2026-08-02). The
// feed bills per job RETURNED, so cadence changes only how often we re-buy the
// same posting: the 2026-08-02 sweep was billed for 32 of which ZERO were new,
// and daily bought that inventory three times over ($14.05/mo against $4.68).
export const JOB_SWEEP_CRON = "30 1 */3 * *";

/**
 * Every third day — sweep every source pool, screen everything, send a BRIEF.
 *
 * Zero-LLM: the fetch is HTTP, every gate is pure code, and ranking is a set
 * intersection, so this runs unattended without touching the model budget.
 *
 * What the founder receives is a ranked shortlist with one command per row, not
 * a log of verdicts. The previous version screened flawlessly and produced zero
 * applications for weeks: screening was never the binding constraint, and a
 * report that costs nothing to ignore will be ignored.
 *
 * A total failure still sends. A sweep that goes quiet is indistinguishable from
 * a market with no jobs in it, and that ambiguity is exactly why the founder
 * would stop trusting the number.
 */
export async function runJobIngestSweep(): Promise<void> {
  const { runPooledIngest } = await import("./ingest.js");
  const { buildDailyBrief } = await import("./daily-brief.js");
  const { toTelegramSafe, splitForTelegram } = await import("./brief.js");

  const result = await runPooledIngest({
    limit: JOB_INGEST_DAILY_LIMIT,
    includeIndeed: true,
  });

  if (result.fetched === 0 && result.failures.length > 0) {
    log.warn({ failures: result.failures }, "Daily job ingest failed on every source");
    // Escaped, not raw: sendToChat defaults to parse_mode "HTML", and real job
    // titles carry "&" and "<" ("Bloom & Wild Group", prod 2026-07-31). Telegram
    // rejects the WHOLE message on an unparseable entity — the alert must not
    // fail on the alert's own content.
    await sendToChat(
      toTelegramSafe(`⚠ Job sweep failed — nothing was screened today.\n${result.failures.join("\n")}`),
    );
    return;
  }

  log.info(
    { fetched: result.fetched, failures: result.failures.length },
    "Daily job ingest complete",
  );

  try {
    // The brief is still BUILT and no longer SENT (founder decision, 2026-08-06:
    // the Sheet replaced the Telegram text). Building it is what pins
    // `brief_section` and `brief_rank` on every row — the numbering `/draft N`
    // resolves against and the `#` column the Sheet prints. Skipping the build
    // to save the work would leave the queue unranked and `/draft 3` pointing at
    // nothing.
    await buildDailyBrief({
      screened: result.fetched,
      failures: result.failures,
      // Kept apart from `failures` all the way through. A day that correctly
      // skipped eight expired listings is a working day, and printing that under
      // "incomplete run" would teach the founder to distrust a healthy sweep.
      notes: result.notes,
    });
    const { link, notice } = await publishSheet();
    setLastSheetLink(link);
    // The metered sweep has no alert of its own to carry the line — it runs
    // every third day and the founder should hear from it either way.
    await sendToChat(
      (notice ??
        `📊 <b>Screened ${result.fetched} posting(s)</b> — the job sheet is up to date.\n${link}`) +
        newBoardsLine(result.newBoards),
    );
  } catch (err) {
    // The postings ARE screened and recorded by this point. Losing the ranking
    // must not read as losing the sweep, so say which one actually failed.
    log.error({ err: (err as Error).message }, "Brief ranking failed");
    // Escaped: this is the path that runs BECAUSE the ranking failed, so an
    // unescaped error message here would lose the founder the fallback as well.
    await sendToChat(
      toTelegramSafe(
        `⚠ Screened ${result.fetched} posting(s), but the ranking could not be built: ` +
          `${(err as Error).message}\nThe screening results are recorded — ask for the job brief to read them.`,
      ),
    );
  }
}

/**
 * Daily ATS volume, as a TOTAL split evenly across the sweep's ATS queries.
 *
 * The number was 30 and it capped nothing. The sweep runs one query per
 * (pool × track) and the actor rejects any limit below 10, so the real budget is
 * `max(10, floor(total / queries))` per query — and at 30 across 8 queries that
 * floor won every time. The sweep was quietly free to fetch 100 postings while
 * a constant named DAILY_LIMIT said 30. A budget that does not bind is worse
 * than no budget: it is a number the founder would reason about that has no
 * relationship to what is spent.
 *
 * IT BECAME FICTION ANYWAY: the India pool took the sweep from 8 ATS queries to
 * 12 without touching this, so the ceiling silently became 120 + 20 Indeed, and
 * on 2026-08-06 it bought 92 postings for $0.997 while this said 80. A
 * per-posting count cannot bind a per-query floor. THE CAP THAT BINDS IS IN
 * DOLLARS — `spend-gate.ts`, before the first actor call of every sweep.
 */
const JOB_INGEST_DAILY_LIMIT = 80;

/**
 * Every 30 minutes. `free-ats-source.ts` already states the reasoning for the
 * interval itself (closes the metered feed's 19.6-hour median lag to minutes);
 * this constant is just where that decision is pinned, so changing the cadence
 * is one edit here instead of a string buried in a `cron.schedule` call.
 */
export const FREE_SWEEP_CRON = "*/30 * * * *";

/** Test/ops seam: reset every profile's ping clock so a suite is not order-dependent. */
export async function resetHeartbeat(now: Date = new Date()): Promise<void> {
  await clearLaneHeartbeats();
  await saveLaneHeartbeat(DEFAULT_PROFILE_ID, initialHeartbeat(now));
}

/**
 * Every 30 minutes — poll every free board, screen what's new, and interrupt
 * the founder ONLY when there is something worth interrupting for.
 *
 * Zero-LLM, same reasoning as `runJobIngestSweep`. The two alert rules exist
 * because this lane's two failure directions are opposite and both silent by
 * default: a healthy run with nothing new must stay quiet (see
 * `formatFreeSweepAlert`), and a broken run that screened nothing must NOT look
 * like a healthy run that found nothing — that ambiguity is on record as having
 * cost this pipeline weeks (see `JOB_SWEEP_CRON` above).
 */
export async function runFreeSweep(): Promise<void> {
  const { sweepBoards } = await import("./free-ats-source.js");
  const { getFreeBoards } = await import("./free-boards.js");
  const { listProfiles } = await import("./profile-config.js");
  const { sweepAggregators } = await import("./aggregator-source.js");

  // POLLED ONCE, SCREENED FOR EVERYONE. The board sweep is the expensive half of
  // this lane and its result says nothing about which candidate is looking, so a
  // second profile costs only the body fetches its own filters keep. Doing it
  // per profile instead would poll 1,297 boards twice every thirty minutes for
  // identical data — and it is the reason a second candidate was affordable at
  // all. Everything downstream of here is per profile: the filters, the tracker
  // dedupe, the verdicts, the ranking and the alert.
  let sweep: Awaited<ReturnType<typeof sweepBoards>>;
  try {
    sweep = await sweepBoards(getFreeBoards());
  } catch (err) {
    log.error({ err: (err as Error).message }, "Free board sweep crashed before it could poll anything");
    return;
  }

  // AGGREGATOR SWEEP — runs AFTER the board sweep, merges results in. Fails
  // open: aggregator outages must never block the 1,297-board ATS sweep that
  // has always worked without them. Board token harvesting logged separately.
  try {
    const aggResult = await sweepAggregators();
    if (aggResult.candidates.length > 0) {
      sweep = {
        candidates: [...sweep.candidates, ...aggResult.candidates],
        failures: [...sweep.failures, ...aggResult.failures],
        boardsPolled: sweep.boardsPolled,
      };
    }
    if (aggResult.harvestedTokens.length > 0) {
      log.info(
        { tokens: aggResult.harvestedTokens.length },
        "Board tokens harvested from aggregator URLs",
      );
    }
  } catch (err) {
    // allow-failopen: aggregator crash must not block the board sweep
    log.warn({ err: (err as Error).message }, "Aggregator sweep failed — ATS boards unaffected");
  }

  for (const profile of listProfiles()) {
    // THIS TRY/CATCH IS THE POINT, and until 2026-09-08 the comment here claimed
    // it while the code did not have it. `runFreeSweepForProfile` guards its own
    // ingest and ranking calls; `publishSheet`, `sendToChat` (which rethrows by
    // design) and `saveLaneHeartbeat` were unguarded. The default profile runs
    // first, so one Telegram failure on his alert meant the second candidate was
    // never screened and `runFreeSweep` rejected into the cron's `.catch()`: one
    // log line, whole tick gone. The suite missed it because its one test for
    // this property injected at the site already covered.
    try {
      await runFreeSweepForProfile(profile, sweep);
    } catch (err) {
      log.error(
        { err: (err as Error).message, profile: profile.id },
        "Profile lane failed after screening — the remaining profiles still run",
      );
    }
  }
}
