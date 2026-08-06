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
import type { IngestLine } from "./ingest-batch.js";

const log = childLogger({ module: "scheduler" });

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
    // NOT escaped here. The brief renders its own Telegram HTML and escapes every
    // value at the point it is interpolated (see telegram-format.ts) — running a
    // whole-message escape over it would print "&lt;b&gt;" at the founder rather
    // than bolding anything, which is the exact "message is not formatted"
    // complaint that started this.
    //
    // Chunked because Telegram rejects a body over 4,096 characters outright, and
    // nothing in the send path splits. Before this, a brief that finally had
    // enough supply to be worth reading would have been dropped whole — and the
    // failure would have looked like a sweep that found nothing.
    const brief = await buildDailyBrief({
      screened: result.fetched,
      failures: result.failures,
      // Kept apart from `failures` all the way through. A day that correctly
      // skipped eight expired listings is a working day, and printing that under
      // "incomplete run" would teach the founder to distrust a healthy sweep.
      notes: result.notes,
    });
    for (const part of splitForTelegram(brief)) {
      await sendToChat(part);
    }
  } catch (err) {
    // The postings ARE screened and recorded by this point. Losing the brief must
    // not read as losing the sweep, so say which one actually failed.
    log.error({ err: (err as Error).message }, "Daily brief render failed");
    // Escaped too: this is the path that runs BECAUSE the brief failed, so an
    // unescaped error message here would lose the founder the fallback as well.
    await sendToChat(
      toTelegramSafe(
        `⚠ Screened ${result.fetched} posting(s), but the brief could not be built: ` +
          `${(err as Error).message}\nThe screening results are recorded — run /jobs to read them.`,
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
 * Roles named in the free-sweep alert before it switches to "+ N more".
 * Failed boards named in the free-sweep outage alert before it stops listing.
 */
const NEW_PASS_ALERT_CAP = 5;
const OUTAGE_ALERT_BOARD_CAP = 3;

/**
 * Every 30 minutes. `free-ats-source.ts` already states the reasoning for the
 * interval itself (closes the metered feed's 19.6-hour median lag to minutes);
 * this constant is just where that decision is pinned, so changing the cadence
 * is one edit here instead of a string buried in a `cron.schedule` call.
 */
export const FREE_SWEEP_CRON = "*/30 * * * *";

/**
 * The only message `runFreeSweep` is allowed to send for a healthy run.
 *
 * This lane ticks 48 times a day. A message every tick trains the founder to
 * stop reading it — the exact failure already on record for the metered feed's
 * old screening log, which ran flawlessly and produced zero applications for
 * weeks because nothing about it demanded a reaction. So this fires only for
 * postings that are BOTH a pass AND new: never a re-screened duplicate, and
 * never a flag or reject, however interesting.
 *
 * No `/draft` numbers here. Those are pinned by the daily brief's own ranking
 * (`persistBriefRanks` in daily-brief.ts), and this alert has no ranking of its
 * own to pin them against — inventing one would hand the founder a command that
 * resolves to the wrong row, or to nothing.
 */
function formatFreeSweepAlert(passes: readonly IngestLine[]): string {
  const shown = passes.slice(0, NEW_PASS_ALERT_CAP);
  const rows = shown.map((p) => `• ${esc(p.company)} — ${esc(p.title)}`).join("\n");
  const overflow =
    passes.length > NEW_PASS_ALERT_CAP
      ? `\n<i>+ ${passes.length - NEW_PASS_ALERT_CAP} more not shown here.</i>`
      : "";

  return (
    `🆕 <b>${passes.length} new role${passes.length === 1 ? "" : "s"} passed screening</b>\n` +
    rows +
    overflow +
    `\n\nAsk for the job brief for the full ranking and /draft numbers.`
  );
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
  const { runFreeIngest } = await import("./free-ingest.js");

  let result: Awaited<ReturnType<typeof runFreeIngest>>;
  try {
    result = await runFreeIngest();
  } catch (err) {
    // Called by the cron (which wraps every sweep in its own `.catch()`, same
    // as the rest of startScheduler) AND directly by callers/tests. Either way
    // this runs unattended 48 times a day, so a crash must be loud in the logs
    // and must not reject — the founder's next signal is the next tick, not a
    // Node "unhandled rejection" nobody is watching for.
    log.error({ err: (err as Error).message }, "Free board sweep crashed before it could screen anything");
    return;
  }

  log.info(
    {
      boardsPolled: result.boardsPolled,
      seen: result.seen,
      screened: result.screened,
      failures: result.failures.length,
    },
    "Free board sweep complete",
  );

  if (result.failures.length > 0 && result.screened === 0) {
    // Same guard as runJobIngestSweep's, one layer down: a sweep where every
    // board failed and nothing was screened must not read like a market with no
    // jobs in it.
    log.warn({ failures: result.failures }, "Free board sweep failed on every board");
    await sendToChat(
      esc(
        `⚠ Free job lane failed — nothing was screened this sweep.\n` +
          result.failures.slice(0, OUTAGE_ALERT_BOARD_CAP).join("\n"),
      ),
    );
    return;
  }

  const newPasses = result.lines.filter((line) => line.outcome === "pass" && line.isNew);
  if (newPasses.length === 0) return;

  await sendToChat(formatFreeSweepAlert(newPasses));
}
