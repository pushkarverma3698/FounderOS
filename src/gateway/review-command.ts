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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "grammy";
import { engineDisplay, readDefaultEngine, type Engine } from "../tools/coding-engine.js";

/** A cron run every 20 minutes (pr-brain) or 15 (agent-dispatch): a report older than this means the cron stopped. */
const STALE_AFTER_MS = 2 * 3_600_000;

export type ReportName = "pr-brain" | "agent-dispatch";

export interface ReviewSetup {
  /** null = the daemon has not reported (file missing, empty or unreadable as a report). */
  readonly reviewers: readonly string[] | null;
  readonly merges: boolean | null;
  readonly agyModel: string | null;
  readonly claudeModel: string | null;
  /** When the daemon wrote the report, ms since epoch; null when unknown. */
  readonly reviewerReportedAt: number | null;
  readonly writerReportedAt: number | null;
}

export interface ReviewCommandDeps {
  readonly isOff: () => boolean;
  readonly setOff: (off: boolean) => void;
  /** The text of a daemon's report, null when it has not written one, throws when it cannot be read. */
  readonly effective: (name: ReportName) => string | null;
  readonly now: () => number;
  readonly engine: () => Engine;
}

export function reviewOffFile(): string {
  return join(homedir(), ".claude", "pr-brain.off");
}

export function effectiveFile(name: ReportName): string {
  return join(homedir(), ".claude", `${name}.effective`);
}

const REAL_DEPS: ReviewCommandDeps = {
  isOff: () => existsSync(reviewOffFile()),
  setOff: (off) => {
    const file = reviewOffFile();
    if (!off) return rmSync(file, { force: true });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `switched off from Telegram /review at ${new Date().toISOString()}\n`);
  },
  effective: (name) => {
    try {
      return readFileSync(effectiveFile(name), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  now: () => Date.now(),
  engine: () => readDefaultEngine(),
};

/** `key=value` lines. Anything else (comments, blanks, a line with no key) is skipped. */
function parseReport(text: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (text ?? "").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

function reportedAt(report: Map<string, string>): number | null {
  const sec = Number(report.get("written"));
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}

export function readReviewSetup(prBrain: string | null, dispatch: string | null): ReviewSetup {
  const brain = parseReport(prBrain);
  const writer = parseReport(dispatch);
  const reviewers = (brain.get("reviewers") ?? "").split(/[\s,]+/).filter(Boolean);
  return {
    reviewers: reviewers.length > 0 ? reviewers : null,
    merges: brain.has("merge") || reviewers.length > 0 ? brain.get("merge") !== "0" : null,
    agyModel: writer.get("agy_model") || null,
    claudeModel: writer.get("claude_model") || null,
    reviewerReportedAt: reviewers.length > 0 ? reportedAt(brain) : null,
    writerReportedAt: writer.get("agy_model") || writer.get("claude_model") ? reportedAt(writer) : null,
  };
}

/** "5 h ago", "2 days ago": coarse on purpose, the founder needs "is this old?", not a timestamp. */
function ago(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 48 ? `${Math.floor(hours / 24)} days ago` : `${hours} h ago`;
}

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
