/**
 * FounderOS — what the VPS daemons leave in ~/.claude for the bot to read
 * =======================================================================
 * pr-brain and agent-dispatch are cron jobs on the VPS. The bot cannot run `crontab -l` (it runs under systemd
 * NoNewPrivileges=true), so each daemon writes down what it is running with, and the bot reads files:
 *
 *   ~/.claude/<daemon>.effective   `written=<epoch>` + `key=value` lines: the models and settings in force
 *   ~/.claude/<daemon>.off         kill switch (the founder's /review off writes pr-brain.off)
 *   ~/.claude/<daemon>.down        present while the daemon is paused: line 1 class, line 2 "YYYY-MM-DD HH:MM UTC"
 *
 * Shared by /review (src/gateway/review-command.ts) and the ops_state `background_jobs` scope
 * (src/tools/background-jobs.ts). It lives in infra because nothing outside src/gateway may import gateway.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A cron run every 20 minutes (pr-brain) or 15 (agent-dispatch): a report older than this means the cron stopped. */
export const STALE_AFTER_MS = 2 * 3_600_000;

export type DaemonName = "pr-brain" | "agent-dispatch";
export type ReportName = DaemonName;

export function daemonFile(name: DaemonName, kind: "off" | "effective" | "down"): string {
  return join(homedir(), ".claude", `${name}.${kind}`);
}

export function effectiveFile(name: ReportName): string {
  return daemonFile(name, "effective");
}

export function reviewOffFile(): string {
  return daemonFile("pr-brain", "off");
}

/** The file's text, null when it does not exist, and a thrown error when it exists and cannot be read. */
export function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface DaemonDown {
  readonly cls: string;
  readonly since: string;
}

/** deploy/lib/down-state.sh: line 1 is the class (auth, limit, gh-auth …), line 2 the UTC time it went down. */
export function parseDown(text: string): DaemonDown {
  const [cls = "", since = ""] = text.split("\n");
  return { cls: cls.trim(), since: since.trim() };
}

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
export function ago(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 48 ? `${Math.floor(hours / 24)} days ago` : `${hours} h ago`;
}
