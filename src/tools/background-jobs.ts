/**
 * FounderOS — background_jobs (the ops_state scope that answers "what's running?")
 * ================================================================================
 * Read-only. What runs without the founder asking: the two VPS daemons (automatic PR review, coding dispatch), read
 * from the files they leave in ~/.claude (src/infra/daemon-settings.ts), and the bot's own built-in routines, from
 * src/infra/scheduler-registry.ts. It also carries `deployed`, the one line naming the commit this process booted on
 * (src/infra/deployed-version.ts), so "what is live?" has an answer. Nothing here guesses: a daemon that has not
 * reported says so, a file that cannot be read names the file and the reason, and a switch file that cannot be read
 * is "unknown", never "ON".
 *
 * Shaped for a person on a phone. `summary` leads with the result, or with what needs attention. `attention` holds
 * only what is off, paused, stale or unreadable, each with the way back where there is one. The two systems he can
 * act on come first; the routines follow, one plain sentence each, so a reply can mention them in one line.
 */

import {
  STALE_AFTER_MS,
  ago,
  daemonFile,
  parseDown,
  readIfPresent,
  readReviewSetup,
  type DaemonDown,
  type DaemonName,
  type ReviewSetup,
} from "../infra/daemon-settings.js";
import { deployedAtBoot } from "../infra/deployed-version.js";
import { SCHEDULED_ROUTINES, describeCron } from "../infra/scheduler-registry.js";
import { engineDisplay, readDefaultEngine, type Engine } from "./coding-engine.js";

export interface BackgroundDeps {
  /** A file's text; null when it does not exist; throws when it exists and cannot be read. */
  readonly read: (file: string) => string | null;
  readonly now: () => number;
  readonly engine: () => Engine;
  /** The `Deployed: <sha7> "<subject>" (<date>), process started <time>` line, fixed at boot. */
  readonly deployed: () => string;
}

export type JobState = "on" | "off" | "paused" | "unknown";

export interface BackgroundJob {
  readonly name: string;
  readonly kind: "daemon" | "routine";
  readonly state: JobState;
  readonly runs: string;
  readonly detail: string;
  /** The command that flips it, when the founder has one. */
  readonly switch?: string;
}

export interface BackgroundJobsView {
  readonly summary: string;
  readonly attention: readonly string[];
  /** Which commit this process is running; "Deployed: unknown, ..." when git could not say. Not an alarm either way. */
  readonly deployed: string;
  readonly jobs: readonly BackgroundJob[];
}

export const REAL_BACKGROUND_DEPS: BackgroundDeps = {
  read: readIfPresent,
  now: () => Date.now(),
  engine: () => readDefaultEngine(),
  deployed: deployedAtBoot,
};

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface Read {
  readonly text: string | null;
  readonly problem?: string;
}

/** A file read that never throws: the problem is kept so the reply can name the file and why. */
function tryRead(deps: BackgroundDeps, name: DaemonName, kind: "off" | "effective" | "down"): Read {
  try {
    return { text: deps.read(daemonFile(name, kind)) };
  } catch (err) {
    return { text: null, problem: `could not read ~/.claude/${name}.${kind} (${reason(err)})` };
  }
}

function staleNote(at: number | null, now: number): string {
  return at !== null && now - at > STALE_AFTER_MS ? ` (last reported ${ago(now - at)})` : "";
}

const isStale = (at: number | null, now: number): boolean => at !== null && now - at > STALE_AFTER_MS;

interface Switches {
  readonly state: JobState;
  readonly down: DaemonDown | null;
  readonly problems: readonly string[];
}

/** Paused outranks off: a paused daemon is down whatever its switch says. */
function readSwitches(deps: BackgroundDeps, name: DaemonName): Switches {
  const down = tryRead(deps, name, "down");
  const off = tryRead(deps, name, "off");
  const problems = [down.problem, off.problem].filter((p): p is string => p !== undefined);
  if (down.text !== null) return { state: "paused", down: parseDown(down.text), problems };
  if (off.text !== null) return { state: "off", down: null, problems };
  return { state: problems.length > 0 ? "unknown" : "on", down: null, problems };
}

/** " (auth) since 2026-10-04 12:10 UTC": the class and the time, whichever the file has. */
function downClause(down: DaemonDown): string {
  return `${down.cls ? ` (${down.cls})` : ""}${down.since ? ` since ${down.since}` : ""}`;
}

function reviewDetail(setup: ReviewSetup | null, problem: string | undefined, now: number): string {
  if (problem) return `Reviewer settings: ${problem}.`;
  if (!setup?.reviewers) return "Reviewers: not reported yet (the daemon reports on its next run, within 20 minutes).";
  const merge = setup.merges === false ? "never merges: you merge" : "merges a PR it clears";
  return `Reviewers: ${setup.reviewers.join(", then ")}${staleNote(setup.reviewerReportedAt, now)} · ${merge}.`;
}

function writerDetail(setup: ReviewSetup | null, problem: string | undefined, engine: Engine, now: number): string {
  if (problem) return `Writer settings: ${problem}.`;
  const named = (e: Engine): string => {
    const model = e === "claude" ? setup?.claudeModel : setup?.agyModel;
    return model ? `${engineDisplay(e)} on ${model}` : `${engineDisplay(e)} (model not reported yet)`;
  };
  const other: Engine = engine === "claude" ? "agy" : "claude";
  const reported = setup?.agyModel || setup?.claudeModel ? staleNote(setup?.writerReportedAt ?? null, now) : "";
  return `Writes /task work with ${named(engine)}${reported} (the default; /engine switches it). Also available: ${named(other)}.`;
}

function prReviewJob(deps: BackgroundDeps, attention: string[]): BackgroundJob {
  const now = deps.now();
  const sw = readSwitches(deps, "pr-brain");
  const eff = tryRead(deps, "pr-brain", "effective");
  const setup = eff.problem ? null : readReviewSetup(eff.text, null);
  const base = reviewDetail(setup, eff.problem, now);

  for (const p of sw.problems) attention.push(`PR review: ${p}.`);
  if (eff.problem) attention.push(`PR review: ${eff.problem}.`);
  if (sw.state === "off") attention.push("PR review is OFF: agent PRs wait for you. /review on turns it back on.");
  if (sw.state === "paused" && sw.down) attention.push(`PR review is paused${downClause(sw.down)}: agent PRs wait for you.`);
  if (sw.state === "on" && isStale(setup?.reviewerReportedAt ?? null, now)) {
    attention.push(`PR review last reported ${ago(now - (setup?.reviewerReportedAt ?? now))}: its cron may have stopped.`);
  }

  const prefix = sw.state === "off" ? "Switched off. " : sw.state === "paused" && sw.down ? `Paused${downClause(sw.down)}. ` : "";
  return {
    name: "Automatic PR review",
    kind: "daemon",
    state: sw.state,
    runs: "every 20 minutes",
    detail: `${prefix}${base}`,
    ...(sw.state === "on" ? { switch: "/review off" } : sw.state === "off" ? { switch: "/review on" } : {}),
  };
}

function dispatchJob(deps: BackgroundDeps, attention: string[]): BackgroundJob {
  const now = deps.now();
  const sw = readSwitches(deps, "agent-dispatch");
  const eff = tryRead(deps, "agent-dispatch", "effective");
  const setup = eff.problem ? null : readReviewSetup(null, eff.text);
  const base = writerDetail(setup, eff.problem, deps.engine(), now);

  for (const p of sw.problems) attention.push(`Coding dispatch: ${p}.`);
  if (eff.problem) attention.push(`Coding dispatch: ${eff.problem}.`);
  if (sw.state === "off") attention.push("Coding dispatch is OFF: new /task work is not picked up.");
  if (sw.state === "paused" && sw.down) attention.push(`Coding dispatch is paused${downClause(sw.down)}: work waits until it clears.`);
  if (sw.state === "on" && isStale(setup?.writerReportedAt ?? null, now)) {
    attention.push(`Coding dispatch last reported ${ago(now - (setup?.writerReportedAt ?? now))}: its cron may have stopped.`);
  }

  const prefix = sw.state === "off" ? "Switched off. " : sw.state === "paused" && sw.down ? `Paused${downClause(sw.down)}. ` : "";
  return { name: "Coding dispatch", kind: "daemon", state: sw.state, runs: "every 15 minutes", detail: `${prefix}${base}` };
}

function summarise(attention: readonly string[], jobs: readonly BackgroundJob[]): string {
  const daemons = jobs.filter((j) => j.kind === "daemon");
  const routines = jobs.length - daemons.length;
  if (attention.length > 0) {
    const n = attention.length;
    return `${n} ${n === 1 ? "thing needs" : "things need"} attention: ${attention.join(" ")}`;
  }
  const states = `PR review ON, coding dispatch ON, ${routines} built-in routines`;
  const unreported = daemons.some((j) => j.detail.includes("not reported yet"));
  return unreported
    ? `Nothing is off or paused: ${states}. A daemon has not reported its settings yet.`
    : `Everything is running: ${states}.`;
}

export function readBackgroundJobs(deps: BackgroundDeps = REAL_BACKGROUND_DEPS): BackgroundJobsView {
  const attention: string[] = [];
  const jobs: BackgroundJob[] = [
    prReviewJob(deps, attention),
    dispatchJob(deps, attention),
    ...SCHEDULED_ROUTINES.map(
      (r): BackgroundJob => ({ name: r.title, kind: "routine", state: "on", runs: describeCron(r.cron), detail: r.what }),
    ),
  ];
  return { summary: summarise(attention, jobs), attention, deployed: deps.deployed(), jobs };
}
