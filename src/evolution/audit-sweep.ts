/**
 * Evolution Engine — 3-Day Self-Audit & Experience Sweep
 * =======================================================
 * The ACTING LOOP: the scheduler's every-3-days entry point (src/infra/scheduler.ts)
 * into the self-audit. Runs the static and telemetry analyzers, persists the run's
 * findings when EVOLUTION_PERSIST_FINDINGS is on, and reports to Telegram.
 *
 * Three properties this file is responsible for, each of which it previously broke
 * (Task 3 — docs/plans/2026-08-13-task3-acting-loop-telemetry-wiring.md):
 *
 *   - it imports the shared runner in src/, not `../../scripts/audit-self.js`. The
 *     old dynamic import into scripts/ was how the cron and the CLI drifted into two
 *     renderers, only one of which reported a skipped telemetry tier;
 *   - it escapes everything before sending as HTML (see audit-message.ts);
 *   - it ALWAYS sends. A crashed audit now says so. Silence used to be the outcome
 *     of every failure here, and silence is indistinguishable from "nothing to report".
 */

import { sendToChat } from "../infra/telegram-send.js";
import { logger } from "../infra/logger.js";
import { runSelfAudit, persistAuditRun } from "./run-audit.js";
import { renderAuditMessage, renderAuditCrashMessage } from "./audit-message.js";
import { repoRoot } from "./repo-root.js";

const log = logger.child({ module: "audit-sweep" });

export async function runSelfAuditSweep(): Promise<void> {
  let message: string;

  try {
    const run = await runSelfAudit(repoRoot());
    const persistence = await persistAuditRun(run);
    message = renderAuditMessage(run, persistence);

    log.info(
      {
        findings: run.ranked.length,
        telemetry_skipped: run.telemetrySkippedReason !== null,
        persistence: persistence.state,
      },
      "3-day self-audit sweep completed",
    );
  } catch (err) {
    const reason = (err as Error).message;
    log.error({ err: reason }, "Self-audit sweep failed — reporting the failure to the founder");
    message = renderAuditCrashMessage(reason);
  }

  try {
    await sendToChat(message, "HTML");
  } catch (err) {
    // allow-failopen: the audit already ran; a Telegram outage must not throw into
    // the scheduler's cron callback. Logged loudly because this is the one failure
    // mode the founder cannot observe from the chat itself.
    log.error({ err: (err as Error).message }, "Self-audit report could not be delivered to Telegram");
  }
}
