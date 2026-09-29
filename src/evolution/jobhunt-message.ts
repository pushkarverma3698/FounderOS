/**
 * Evolution Engine — the daily jobhunt check's Telegram message.
 * ================================================================
 * Pure rendering, kept apart from `jobhunt-check.ts` for the reason `dispatch-message.ts`
 * is apart from its sweep: escaping and length are the two things most likely to
 * break the send silently, and they are only testable if nothing here touches the
 * network.
 *
 * The first line is ALWAYS one of the plan's three (C3), so a founder who reads
 * nothing else still learns what happened:
 *
 *   Jobhunt check: filed #N <title>
 *   Jobhunt check: nothing new
 *   Jobhunt check: check failed: <reason>
 *
 * plus two states the plan did not name but the loop can be in: skipped because the
 * founder halted FounderOS, and filing switched off by its kill switch. Each is a
 * distinct line, because folding either into "nothing new" would be the
 * silent-looks-healthy failure the whole file exists to prevent.
 *
 * Decision findings never became issues, so this message is the only place they
 * reach the founder. They are printed in full with their own evidence and a command
 * to run, split across messages rather than truncated (CLAUDE.md #26).
 */

import { esc, splitForTelegram } from "../tools/jobhunt/telegram-format.js";
import type { DispatchOutcome } from "./dispatch-findings.js";
import { renderIssueTitle } from "./issue-body.js";
import { ADAPTER_SILENT_MIN_SWEEP_RUNS, CANDIDATE_NOT_ACTING_WINDOW_DAYS } from "./analyzers/jobhunt.js";
import type { JobhuntCoverage } from "./analyzers/jobhunt.js";
import type { QuietDecision } from "./jobhunt-notify-state.js";
import type { Finding } from "./types.js";

/** Every state the daily check can end in. `halted` is the check's own; the rest are the loop's. */
export type JobhuntCheckOutcome =
  | DispatchOutcome
  | { readonly state: "halted"; readonly reason: string; readonly engagedAt: string };

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
 * src/gateway/telegram.ts; a test reads that file so this cannot name a command
 * that does not exist.
 */
const COMMANDS: Readonly<Record<string, { readonly today: string; readonly jobs: string; readonly applied: string }>> = {
  "wife-nl-finance": { today: "/wife_today", jobs: "/wife_jobs", applied: "/wife_applied N" },
};
const OWN_COMMANDS = { today: "/today", jobs: "/jobs", applied: "/applied N" } as const;

/** What to DO about a decision. The evidence above it says what was found; this says the next move. */
function decisionAction(finding: Finding): string {
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
    "<b>Decisions for you</b> <i>(Telegram only: no issue is filed for these, because they are not code)</i>",
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
    case "filed":
      return [
        `<b>${esc(`Jobhunt check: filed #${outcome.issueNumber} ${renderIssueTitle(outcome.finding)}`)}</b>\n` +
          `<a href="${esc(outcome.url)}">Open the issue</a> · ${esc(outcome.finding.severity)}`,
        esc(outcome.finding.evidence),
        [
          "<b>What happens next, without you:</b>",
          "1. <code>agent-dispatch</code> claims it within 15 min and Antigravity implements it in an isolated workspace.",
          "2. A <b>draft</b> PR opens against <code>beta</code>.",
          "3. <code>pr-brain</code> reviews it within 20 min and approves, fixes, or requests changes.",
          "",
          `<b>You only act at the merge.</b> To stop it now: <code>gh issue edit ${outcome.issueNumber} --remove-label agent:ready</code>`,
        ].join("\n"),
      ];
    case "all-filed":
      return [
        "<b>Jobhunt check: nothing new</b>\n" +
          `${outcome.dispatchableCount} finding(s) that could become an issue already have one, open or closed, so none was filed. ` +
          "See them: <code>gh issue list --label evolution:auto --state all</code>",
      ];
    case "nothing-dispatchable":
      return ["<b>Jobhunt check: nothing new</b>\nNothing to file today."];
    case "disabled":
      return [
        "<b>Jobhunt check: filing is switched off (SELF_IMPROVE_DISPATCH_ENABLED=false)</b>\n" +
          "No issue was filed. Remove that line from <code>.env</code> and restart to turn it back on.",
      ];
    case "halted":
      return [
        "<b>Jobhunt check: skipped: FounderOS is halted</b>\n" +
          `Reason: <i>${esc(outcome.reason)}</i> (engaged ${esc(outcome.engagedAt)}). Nothing was read, filed or reported. ` +
          "Send <code>/resume</code> to re-enable; the check runs again tomorrow at 09:30.",
      ];
    case "failed":
      return [
        `<b>${esc(`Jobhunt check: check failed: ${outcome.reason}`)}</b>\n` +
          "Nothing was filed, and this is not a clean result: the check did not finish, so nobody has looked at today's data. " +
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
