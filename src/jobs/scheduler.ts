/**
 * Jobs scheduler (2026-10-10): the crons of the standalone jobs process, and only those.
 *
 * Each entry is lifted unchanged from the retired src/infra/scheduler.ts: the free board
 * sweep (which also sends the due daily brief, alert-digest.ts), the follow-up nudges, the
 * Monday pipeline digest, the nightly funding grower, the monthly import-boards reminder and
 * the daily findings check. Every job catches its own errors here, so a rejection never
 * becomes an unhandled one in the bot process.
 */

import cron from "node-cron";
import { appTimeZone } from "../core/time.js";
import { childLogger } from "../infra/logger.js";
import { runMaintenanceChild } from "../infra/child-run.js";
import { sendToChat } from "../infra/telegram-send.js";
import { FREE_SWEEP_CRON, runFreeSweep } from "../tools/jobhunt/sweep-runner.js";
import { runPipelineDigest, runFollowupSweep } from "../tools/jobhunt/pipeline-followup.js";
import { runJobhuntFindingsCheck } from "../evolution/jobhunt-check.js";

const log = childLogger({ module: "jobs-scheduler" });

/**
 * Daily 2am: sweep funding news and grow the free-lane board registry (zero LLM).
 * stderr is captured (child-run.ts): this sweep once crashed nightly and prod kept only `{"code":1}`.
 */
export async function runFundingGrowerSweep(): Promise<void> {
  await runMaintenanceChild("node", ["--import", "tsx/esm", "scripts/jobhunt-funding-grow.ts"], "Funding registry grower sweep");
}

async function sendImportBoardsReminder(): Promise<void> {
  await sendToChat(
    "⏰ <b>Monthly Reminder:</b> Time to refresh the ATS sponsor boards registry! Run <code>pnpm jobhunt:import-boards</code> on your laptop to discover and register new companies.",
    "HTML",
  );
}

async function runFollowups(): Promise<void> {
  const outcome = await runFollowupSweep();
  if (outcome.sent > 0 || outcome.failed > 0) log.info(outcome, "Follow-up nudge sweep complete");
}

export interface JobsCron {
  readonly name: string;
  readonly expr: string;
  readonly run: () => Promise<unknown>;
  /** Evaluated in the founder's timezone instead of the server's UTC. */
  readonly local?: boolean;
}

export const JOBS_CRONS: readonly JobsCron[] = [
  { name: "free-sweep", expr: FREE_SWEEP_CRON, run: runFreeSweep },
  { name: "follow-up", expr: "0 9 * * *", run: runFollowups },
  { name: "pipeline-digest", expr: "0 9 * * 1", run: runPipelineDigest },
  { name: "funding-grower", expr: "0 2 * * *", run: runFundingGrowerSweep },
  { name: "import-boards-reminder", expr: "0 10 1 * *", run: sendImportBoardsReminder },
  // 09:30 in appTimeZone(): the server is on UTC, so a bare "30 9" would fire at 15:00 IST.
  { name: "findings", expr: "30 9 * * *", run: runJobhuntFindingsCheck, local: true },
];

export type ScheduleFn = (expr: string, fn: () => void, opts?: { timezone?: string }) => unknown;

export function startJobsScheduler(schedule: ScheduleFn = cron.schedule): void {
  const timezone = appTimeZone();
  for (const job of JOBS_CRONS) {
    const tick = () => {
      job.run().catch((err) => log.error({ cron: job.name, err: (err as Error).message }, "Jobs cron failed"));
    };
    if (job.local) schedule(job.expr, tick, { timezone });
    else schedule(job.expr, tick);
  }
  log.info({ crons: JOBS_CRONS.map((j) => `${j.name} ${j.expr}`), timezone }, "Jobs scheduler started");
}
