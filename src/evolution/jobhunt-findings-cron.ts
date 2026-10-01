/**
 * Evolution Engine — registers the daily jobhunt check on a cron.
 * ================================================================
 * Its own file so `src/infra/scheduler.ts` (367 of 400 lines) takes exactly one
 * import and one call. Daily at 09:30 in the founder's timezone (`appTimeZone()`:
 * the server itself stays on UTC, so an unqualified "30 9" would fire at 15:00 IST).
 *
 * This is NOT the 2026-08-21 cron coming back. That was the every-third-day
 * code-health audit (08:00) and dispatch (09:00), removed because paid crons that
 * produced no acted-on output were switched off; both are still unregistered, and
 * `scheduler-cron-wiring.test.ts` still asserts it. This one runs only the jobhunt
 * analyzer, costs nothing, and ends in a Telegram line every day.
 */

import cron from "node-cron";
import { appTimeZone } from "../core/time.js";
import { childLogger } from "../infra/logger.js";
import { runJobhuntFindingsCheck } from "./jobhunt-check.js";

const log = childLogger({ module: "jobhunt-findings-cron" });

/** Daily 09:30, evaluated in `appTimeZone()`. */
export const JOBHUNT_FINDINGS_CRON = "30 9 * * *";

export function startJobhuntFindingsCron(): void {
  const timezone = appTimeZone();
  cron.schedule(
    JOBHUNT_FINDINGS_CRON,
    () => {
      // The check reports its own failures to Telegram and never throws; this catch is for the
      // impossible, so a rejection cannot become an unhandled one in the bot process.
      runJobhuntFindingsCheck().catch((err) =>
        log.error({ err: (err as Error).message }, "Jobhunt findings check cron error"),
      );
    },
    { timezone },
  );
  log.info({ cron: JOBHUNT_FINDINGS_CRON, timezone }, "Jobhunt findings check scheduled (daily, zero LLM, at most one issue)");
}
