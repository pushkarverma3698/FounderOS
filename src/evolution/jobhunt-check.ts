/**
 * Evolution Engine — the daily jobhunt check (plan 2026-09-29, part C2 + C3).
 * ============================================================================
 * One morning run: read the jobhunt tables, run ONLY the jobhunt analyzer, tell the founder.
 *
 *   read rows → analyze → findings (told once a week each) → Telegram
 *
 * REPORT-ONLY since 2026-10-10. It used to file one GitHub issue a day for agent-dispatch
 * to implement; the coding pipeline is retired (docs/plans/2026-10-10-opendots-migration.md),
 * so every finding, code fix or decision, now reaches the founder here instead.
 *
 * No model: every step is code over rows. `jobhunt-check.test.ts` injects models that
 * throw on any call.
 *
 * IT ALWAYS SENDS. A failed read produces its own first line; it cannot read as
 * "nothing new".
 */

import { childLogger } from "../infra/logger.js";
import { sendToChat } from "../infra/telegram-send.js";
import { analyzeJobhunt } from "./analyzers/jobhunt.js";
import type { JobhuntAnalysis, JobhuntSnapshot } from "./analyzers/jobhunt.js";
import { renderJobhuntCheck } from "./jobhunt-message.js";
import type { JobhuntCheckOutcome, JobhuntCheckReport } from "./jobhunt-message.js";
import {
  EMPTY_NOTIFY_STATE,
  loadNotifyState,
  partitionDecisions,
  recordNotified,
  saveNotifyState,
} from "./jobhunt-notify-state.js";
import type { NotifyState } from "./jobhunt-notify-state.js";
import type { Finding } from "./types.js";

const log = childLogger({ module: "jobhunt-check" });

/** Everything the check touches, injectable so the whole run is a unit test at $0. */
export interface JobhuntCheckDeps {
  readonly now: () => Date;
  /** Reads the jobhunt tables. Throws, naming the table, when the database cannot be read. */
  readonly read: (now: Date) => Promise<JobhuntSnapshot>;
  readonly send: (parts: readonly string[]) => Promise<void>;
  readonly state: {
    readonly load: () => Promise<NotifyState>;
    readonly save: (state: NotifyState) => Promise<void>;
  };
}

export interface JobhuntCheckResult {
  readonly outcome: JobhuntCheckOutcome;
  /** The Telegram parts that were (or would have been) sent. */
  readonly parts: readonly string[];
  /** Findings told in full this run. */
  readonly notified: readonly Finding[];
  /** False when Telegram refused the message: the decisions were then NOT marked as told. */
  readonly delivered: boolean;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function defaultDeps(): JobhuntCheckDeps {
  return {
    now: () => new Date(),
    // Dynamic, like run-audit.ts's telemetry tier: a dead database or a missing DATABASE_URL
    // is then a failure this run REPORTS, not an error at import time.
    read: async (now) => (await import("./collect-jobhunt.js")).collectJobhuntSnapshot(now),
    send: async (parts) => {
      for (const part of parts) await sendToChat(part, "HTML");
    },
    state: { load: () => loadNotifyState(), save: (state) => saveNotifyState(state) },
  };
}

async function analyse(
  deps: JobhuntCheckDeps,
  now: Date,
): Promise<{ readonly analysis: JobhuntAnalysis } | { readonly failure: string }> {
  try {
    return { analysis: analyzeJobhunt(await deps.read(now), now) };
  } catch (err) {
    return { failure: `reading production data: ${messageOf(err)}` };
  }
}

async function loadState(deps: JobhuntCheckDeps): Promise<NotifyState> {
  try {
    return await deps.state.load();
  } catch (err) {
    // allow-failopen: the memory only stops a repeat. Losing it means telling a finding once more, never
    // silence, so an unreadable file must not stop the check.
    log.warn({ err: messageOf(err) }, "Jobhunt notify state could not be read — treating it as empty");
    return EMPTY_NOTIFY_STATE;
  }
}

/** Send, then (only if it arrived) remember which decisions were told. Never throws. */
async function deliver(
  deps: JobhuntCheckDeps,
  now: Date,
  report: JobhuntCheckReport,
  state: NotifyState,
): Promise<JobhuntCheckResult> {
  const parts = renderJobhuntCheck(report);
  let delivered = false;
  try {
    await deps.send(parts);
    delivered = true;
  } catch (err) {
    // allow-failopen: the check has already run. A Telegram outage must not throw
    // into the cron callback. Logged loudly because it is the one failure the founder cannot see from the chat.
    log.error({ err: messageOf(err) }, "Jobhunt check report could not be delivered to Telegram");
  }
  // Only what actually reached the founder counts as told, or an outage would silence a decision for a week.
  if (delivered && report.due.length > 0) {
    try {
      await deps.state.save(recordNotified(state, report.due, now));
    } catch (err) {
      log.warn({ err: messageOf(err) }, "Jobhunt notify state could not be saved — the decision may be told again tomorrow");
    }
  }
  return { outcome: report.outcome, parts, notified: delivered ? report.due : [], delivered };
}

/** The daily check. Never throws: every ending is reported to the founder. */
export async function runJobhuntFindingsCheck(overrides: Partial<JobhuntCheckDeps> = {}): Promise<JobhuntCheckResult> {
  const deps: JobhuntCheckDeps = { ...defaultDeps(), ...overrides };
  const now = deps.now();

  const analysed = await analyse(deps, now);
  if ("failure" in analysed) {
    log.error({ reason: analysed.failure }, "Jobhunt check could not read the data — reporting the failure to the founder");
    return deliver(
      deps,
      now,
      { outcome: { state: "failed", reason: analysed.failure }, coverage: null, due: [], quiet: [] },
      EMPTY_NOTIFY_STATE,
    );
  }

  const { analysis } = analysed;
  const state = await loadState(deps);
  const { due, quiet } = partitionDecisions(analysis.findings, state, now);
  const outcome: JobhuntCheckOutcome = { state: "checked", told: due.length };

  log.info(
    { findings: analysis.findings.length, findingsDue: due.length, findingsQuiet: quiet.length },
    "Jobhunt check completed",
  );
  return deliver(deps, now, { outcome, coverage: analysis.coverage, due, quiet }, state);
}
