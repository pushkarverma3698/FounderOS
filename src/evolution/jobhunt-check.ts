/**
 * Evolution Engine — the daily jobhunt check (plan 2026-09-29, part C2 + C3).
 * ============================================================================
 * One morning run: read the jobhunt tables, run ONLY the jobhunt analyzer, file at
 * most one GitHub issue through the existing acting loop, tell the founder.
 *
 *   halt? → read rows → analyze → runSelfImprovementDispatch (issue) → decisions → Telegram
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *  · No model. Every step is code over rows: the analyzer is pure, the dispatch loop
 *    files a templated issue, the message is a template. `jobhunt-check.test.ts`
 *    injects models that throw on any call, and `jobhunt-dispatch.test.ts` walks the
 *    import graph. The 2026-08-21 directive was that paid crons producing no acted-on
 *    output get switched off; this one costs nothing, and must stay that way.
 *  · No code-health analyzers. `runSelfImprovementDispatch` takes a finding source,
 *    and this passes its own, so the tidiness backlog stays a separate decision and
 *    the 2026-08-21 cron is NOT re-enabled.
 *  · No executor. The loop files an issue; `agent-dispatch` on the VPS claims it and
 *    a human merges the PR. Nothing here reaches `claudeCodeTool` or
 *    `resolveExecutorCwd` (the old acting loop's failure); a test proves it.
 *
 * IT ALWAYS SENDS, the property dispatch-sweep.ts and audit-sweep.ts exist to hold.
 * A failed read, a missing GitHub token, a halted FounderOS and a switched-off loop
 * each produce their own first line; none can read as "nothing new".
 *
 * AT MOST ONE ISSUE A DAY, by mechanism: the loop files at most one per call, and
 * this runs once a day. There is deliberately no entry point that files by hand, so
 * nothing can add a second (`scripts/jobhunt-findings-check.ts` only prints).
 *
 * /halt: a halted FounderOS acts on nothing. Filing an `agent:ready` issue starts an
 * unattended implementation, which is acting. The check says it was skipped, rather
 * than going quiet, so a halt forgotten for a fortnight cannot silently disable it.
 */

import { readHalt } from "../infra/halt.js";
import type { HaltState } from "../infra/halt.js";
import { childLogger } from "../infra/logger.js";
import { sendToChat } from "../infra/telegram-send.js";
import { analyzeJobhunt } from "./analyzers/jobhunt.js";
import type { JobhuntAnalysis, JobhuntSnapshot } from "./analyzers/jobhunt.js";
import { octokitIssueGateway, runSelfImprovementDispatch } from "./dispatch-findings.js";
import type { IssueGateway } from "./dispatch-findings.js";
import { isDispatchable } from "./issue-body.js";
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
  /** Built lazily inside the run, so a missing GITHUB_TOKEN is a reported failure, not a crash. */
  readonly gateway: () => IssueGateway;
  readonly send: (parts: readonly string[]) => Promise<void>;
  readonly halt: () => Promise<HaltState | null>;
  readonly state: {
    readonly load: () => Promise<NotifyState>;
    readonly save: (state: NotifyState) => Promise<void>;
  };
}

export interface JobhuntCheckResult {
  readonly outcome: JobhuntCheckOutcome;
  /** The Telegram parts that were (or would have been) sent. */
  readonly parts: readonly string[];
  /** Decision findings told in full this run. */
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
    gateway: () => octokitIssueGateway(),
    send: async (parts) => {
      for (const part of parts) await sendToChat(part, "HTML");
    },
    halt: readHalt,
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

async function file(deps: JobhuntCheckDeps, now: Date, analysis: JobhuntAnalysis): Promise<JobhuntCheckOutcome> {
  try {
    return await runSelfImprovementDispatch(deps.gateway(), now, async () => ({
      ranked: analysis.findings,
      telemetrySkippedReason: null,
    }));
  } catch (err) {
    return { state: "failed", reason: `filing an issue: ${messageOf(err)}` };
  }
}

async function loadState(deps: JobhuntCheckDeps): Promise<NotifyState> {
  try {
    return await deps.state.load();
  } catch (err) {
    // allow-failopen: the memory only stops a repeat. Losing it means telling a decision once more, never
    // silence and never a missed issue, so an unreadable file must not stop the check.
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
    // allow-failopen: the check has already run and any issue it filed exists. A Telegram outage must not throw
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

  const halt = await deps.halt();
  if (halt) {
    log.warn({ reason: halt.reason }, "Jobhunt check skipped: FounderOS is halted");
    return deliver(
      deps,
      now,
      {
        outcome: { state: "halted", reason: halt.reason, engagedAt: halt.engagedAt },
        coverage: null,
        due: [],
        quiet: [],
      },
      EMPTY_NOTIFY_STATE,
    );
  }

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
  const outcome = await file(deps, now, analysis);
  const state = await loadState(deps);
  // Decisions are everything the loop is not allowed to hand to an executor.
  const { due, quiet } = partitionDecisions(analysis.findings.filter((f) => !isDispatchable(f)), state, now);

  log.info(
    { state: outcome.state, findings: analysis.findings.length, decisionsDue: due.length, decisionsQuiet: quiet.length },
    "Jobhunt check completed",
  );
  return deliver(deps, now, { outcome, coverage: analysis.coverage, due, quiet }, state);
}
