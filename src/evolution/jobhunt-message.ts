/**
 * Evolution Engine — the daily jobhunt check's Telegram message.
 * ================================================================
 * Pure rendering, kept apart from `jobhunt-check.ts` for the reason `dispatch-message.ts`
 * is apart from its sweep: escaping and length are the two things most likely to
 * break the send silently, and they are only testable if nothing here touches the
 * network.
 *
 * The first line is ALWAYS one of these, so a founder who reads nothing else still
 * learns what happened:
 *
 *   Jobhunt check: N finding(s) for you
 *   Jobhunt check: nothing new
 *   Jobhunt check: check failed: <reason>
 *
 * Findings are printed in full with their own evidence and a next step, split across
 * messages rather than truncated (CLAUDE.md #26). No GitHub issue is filed (2026-10-10).
 */

import { esc, splitForTelegram } from "../tools/jobhunt/telegram-format.js";
import { ADAPTER_SILENT_MIN_SWEEP_RUNS, ADAPTER_SOURCE_PATHS, CANDIDATE_NOT_ACTING_WINDOW_DAYS } from "./analyzers/jobhunt.js";
import type { JobhuntCoverage } from "./analyzers/jobhunt.js";
import type { QuietDecision } from "./jobhunt-notify-state.js";
import type { Finding } from "./types.js";

/** Every state the daily check can end in. */
export type JobhuntCheckOutcome =
  /** The analyzer ran; `told` findings are printed in full below the head line. */
  | { readonly state: "checked"; readonly told: number }
  | { readonly state: "failed"; readonly reason: string };

export interface JobhuntCheckReport {
  readonly outcome: JobhuntCheckOutcome;
  /** Null when the data could not be read, so there is nothing to say was checked. */
  readonly coverage: JobhuntCoverage | null;
  /** Decisions to tell now (new, or past their re-notify window). */
  readonly due: readonly Finding[];
  /** Decisions already told inside the window: acknowledged, not repeated. */
  readonly quiet: readonly QuietDecision[];
}

/**
 * The chat commands for one candidate. The `wife_` aliases are bound in
 * src/jobs/bot.ts; a test checks them against the ☰ menu so this cannot name a command
 * that does not exist.
 */
const COMMANDS: Readonly<Record<string, { readonly today: string; readonly jobs: string; readonly applied: string }>> = {
  "wife-nl-finance": { today: "/wife_today", jobs: "/wife_jobs", applied: "/wife_applied N" },
};
const OWN_COMMANDS = { today: "/today", jobs: "/jobs", applied: "/applied N" } as const;

/** What to DO about a decision. The evidence above it says what was found; this says the next move. */
function decisionAction(finding: Finding): string {
  const platform = finding.subject.split(" ")[0] ?? finding.subject;
  if (finding.kind === "adapter-silent") {
    return (
      `Code fix: the ${platform} adapter stored nothing. Read ${ADAPTER_SOURCE_PATHS[platform] ?? "src/tools/jobhunt/adapters/"} ` +
      `against one live board from the evidence and add a fixture test that fails first.`
    );
  }
  if (finding.kind === "apply-link-unrecognised") {
    return (
      `Code fix: getApplyUrl in src/tools/jobhunt/apply-packet.ts returns null for ${platform}'s own URLs above. ` +
      `Pin each sample URL in a test, then teach it the form URL.`
    );
  }
  const c = COMMANDS[finding.subject] ?? OWN_COMMANDS;
  if (finding.kind === "candidate-not-acting") {
    return (
      `Ask two things: does the candidate open ${c.today}, and have they applied anywhere in the last ` +
      `${CANDIDATE_NOT_ACTING_WINDOW_DAYS} days, inside or outside FounderOS? Every application made outside the bot ` +
      `needs ${c.applied}, or this count stays at 0. More supply changes nothing until the last mile works.`
    );
  }
  return (
    `Open ${c.jobs} to see what the lane last stored for this candidate. If the stage named above is "already known ` +
    `in tracker" the market is flat and nothing is needed; if it names a filter (stale age cutoff, off-track title, ` +
    `outside target market) the filter may be too tight for this profile.`
  );
}

function decisionBlock(due: readonly Finding[]): string[] {
  if (due.length === 0) return [];
  return [
    "<b>Findings for you</b>",
    ...due.map(
      (f, i) =>
        `${i + 1}. <b>${esc(f.kind)}</b> · <code>${esc(f.subject)}</code>\n${esc(f.evidence)}\n→ ${esc(decisionAction(f))}`,
    ),
  ];
}

function quietBlock(quiet: readonly QuietDecision[]): string[] {
  if (quiet.length === 0) return [];
  const lines = quiet.map(
    ({ finding, nextReminderAt }) =>
      `· ${esc(finding.kind)} for <code>${esc(finding.subject)}</code>: next reminder ${nextReminderAt.toISOString().slice(0, 10)}`,
  );
  return [`<i>Still open, not repeated today (told within the last week):</i>\n${lines.join("\n")}`];
}

/** What was looked at, so "nothing new" can be checked against the numbers. */
function coverageBlock(coverage: JobhuntCoverage | null): string[] {
  if (!coverage) return [];
  const judged = coverage.platformsJudged.length > 0 ? ` (${esc(coverage.platformsJudged.join(", "))})` : "";
  const lines = [
    `Checked: ${coverage.platformsJudged.length} of ${coverage.platformsKnown} platforms with enough volume to judge${judged}; ` +
      `${coverage.sweepRuns24h.toLocaleString("en-US")} free-sweep runs in 24h; ` +
      `${coverage.newPostings7d.toLocaleString("en-US")} new postings in 7 days; ${coverage.profilesChecked} candidate(s).`,
  ];
  if (coverage.newPostings7d === 0) {
    lines.push(
      "⚠ No new postings were stored in the last 7 days, so the platform checks had nothing to read. Either the free lane stored " +
        "nothing (see the sweep line above) or this check is looking for the wrong rows: it reads job_applications rows " +
        "with source free-ats-ingest.",
    );
  }
  if (coverage.sweepRuns24h < ADAPTER_SILENT_MIN_SWEEP_RUNS) {
    lines.push(
      `⚠ Only ${coverage.sweepRuns24h} free-sweep runs in the last 24h (about 96 are normal, ${ADAPTER_SILENT_MIN_SWEEP_RUNS} needed): ` +
        `platform checks were skipped. That is the sweep not running, which is not the same as a quiet market.`,
    );
  }
  return [lines.join("\n")];
}

/** The head of the message: the plan's first line, then what follows from it. */
function headBlock(outcome: JobhuntCheckOutcome): string[] {
  switch (outcome.state) {
    case "checked":
      if (outcome.told === 0) return ["<b>Jobhunt check: nothing new</b>"];
      return [`<b>Jobhunt check: ${outcome.told} finding${outcome.told === 1 ? "" : "s"} for you</b>`];
    case "failed":
      return [
        `<b>${esc(`Jobhunt check: check failed: ${outcome.reason}`)}</b>\n` +
          "This is not a clean result: the check did not finish, so nobody has looked at today's data. " +
          "It runs again tomorrow at 09:30.",
      ];
  }
}

/** The whole message, already split into Telegram-sized parts. Never truncates: a row is moved, not dropped. */
export function renderJobhuntCheck(report: JobhuntCheckReport): string[] {
  const blocks = [
    ...headBlock(report.outcome),
    ...coverageBlock(report.coverage),
    ...decisionBlock(report.due),
    ...quietBlock(report.quiet),
  ];
  return splitForTelegram(blocks.join("\n\n"));
}
