/**
 * FounderOS — /review
 * ===================
 * Shows or switches the automatic PR review (pr-brain, deploy/vps-daemons/pr-brain):
 *
 *   /review        → on or off, the reviewer models in order, whether it merges, and who writes the code
 *   /review off    → stop reviewing from the next cron tick
 *   /review on     → start again
 *
 * pr-brain does nothing while ~/.claude/pr-brain.off exists, and the bot runs as the same founderos user,
 * so the switch is that file. Like /engine, a switch is confirmed by reading the file back, never by
 * trusting that the write returned.
 *
 * The models are what the daemons REPORT: each sweep, pr-brain and agent-dispatch write the settings they are
 * actually running with to ~/.claude/pr-brain.effective and agent-dispatch.effective, and this reads them. It
 * used to run `crontab -l`, which the bot cannot do: it runs under NoNewPrivileges=true, where crontab is denied,
 * so /review said ON and could not name a model (2026-10-04). Reporting from the daemon also means the answer
 * includes the scripts' own defaults and can never disagree with them.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Context } from "grammy";
import { STALE_AFTER_MS, ago, effectiveFile, readIfPresent, readReviewSetup, reviewOffFile, type ReportName } from "../infra/daemon-settings.js";
import { engineDisplay, readDefaultEngine, type Engine } from "../tools/coding-engine.js";

export interface ReviewCommandDeps {
  readonly isOff: () => boolean;
  readonly setOff: (off: boolean) => void;
  /** The text of a daemon's report, null when it has not written one, throws when it cannot be read. */
  readonly effective: (name: ReportName) => string | null;
  readonly now: () => number;
  readonly engine: () => Engine;
}

const REAL_DEPS: ReviewCommandDeps = {
  isOff: () => existsSync(reviewOffFile()),
  setOff: (off) => {
    const file = reviewOffFile();
    if (!off) return rmSync(file, { force: true });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `switched off from Telegram /review at ${new Date().toISOString()}\n`);
  },
  effective: (name) => readIfPresent(effectiveFile(name)),
  now: () => Date.now(),
  engine: () => readDefaultEngine(),
};

/** Appended only when a report is stale: a fresh one needs no comment. */
function staleNote(at: number | null, now: number): string {
  return at !== null && now - at > STALE_AFTER_MS ? ` (last reported ${ago(now - at)})` : "";
}

const state = (off: boolean): string => (off ? "OFF" : "ON");

function readReport(deps: ReviewCommandDeps, name: ReportName): { text: string | null; problem?: string } {
  try {
    return { text: deps.effective(name) };
  } catch (err) {
    // Not swallowed: the file and the reason are printed, and on/off is still answered from its own file.
    return { text: null, problem: `Could not read ~/.claude/${name}.effective: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function describeSetup(deps: ReviewCommandDeps): string {
  const brain = readReport(deps, "pr-brain");
  const dispatch = readReport(deps, "agent-dispatch");
  const setup = readReviewSetup(brain.text, dispatch.text);
  const now = deps.now();
  const engine = deps.engine();
  const writerModel = engine === "claude" ? setup.claudeModel : setup.agyModel;

  const lines: string[] = [];
  if (brain.problem) lines.push(brain.problem);
  else if (setup.reviewers) lines.push(`Reviewer: ${setup.reviewers.join(", then ")}${staleNote(setup.reviewerReportedAt, now)}`);
  else lines.push("Reviewer models: not reported yet. pr-brain reports them on its next run (every 20 minutes).");
  if (setup.merges !== null) {
    lines.push(setup.merges ? "A PR it clears is merged automatically." : "It reviews and clears PRs but never merges: you merge.");
  }
  if (dispatch.problem) lines.push(dispatch.problem);
  else if (writerModel) lines.push(`Writer for /task: ${engineDisplay(engine)} on ${writerModel}${staleNote(setup.writerReportedAt, now)} (/engine switches it)`);
  else lines.push("Writer model: not reported yet. agent-dispatch reports it on its next run (every 15 minutes).");
  lines.push("Models are set on the pr-brain and agent-dispatch lines of the founderos crontab on the VPS.");
  return lines.join("\n");
}

export async function handleReview(ctx: Context, deps: ReviewCommandDeps = REAL_DEPS): Promise<void> {
  const arg = (ctx.match?.toString() ?? "").trim().toLowerCase();

  if (!arg) {
    const off = deps.isOff();
    const flip = off ? "Turn it on with /review on." : "Turn it off with /review off.";
    await ctx.reply(`Automatic PR review is ${state(off)}. ${flip}\n${describeSetup(deps)}`);
    return;
  }

  if (arg !== "on" && arg !== "off") {
    await ctx.reply(`"${arg}" is not a setting. Use /review on or /review off.`);
    return;
  }

  const wantOff = arg === "off";
  let failure: string | undefined;
  try {
    deps.setOff(wantOff);
  } catch (err) {
    // Not swallowed: the reason goes into the reply below, and the state is read back, not assumed.
    failure = err instanceof Error ? err.message : String(err);
  }

  const off = deps.isOff();
  if (!failure && off !== wantOff) failure = "the switch file did not change after the write";
  if (failure) {
    await ctx.reply(`Could not switch it: ${failure}. It is still ${state(off)}.`);
    return;
  }

  await ctx.reply(
    off
      ? "Automatic PR review is now OFF from its next cron run. A review already running finishes. " +
          "Agent PRs stay drafts until you review them or send /review on."
      : "Automatic PR review is now ON. Its next cron run picks up the open agent PRs.",
  );
}
