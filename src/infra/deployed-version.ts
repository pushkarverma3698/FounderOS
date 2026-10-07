/**
 * FounderOS — which commit is this process running?
 * =================================================
 * Prod 2026-10-07: the founder asked what shipped today and the bot said no deployment was confirmed, although prod had
 * moved an hour earlier. Nothing in src/ knew the deployed commit. This module reads it once, when the process boots,
 * and `deployedAtBoot()` hands the same one line to the ops_state `background_jobs` scope for the rest of the process's life:
 *
 *   Deployed: fec3075 "fix(pr-brain): ..." (2026-10-07 08:42 UTC), process started 2026-10-07 09:50 UTC
 *
 * Read at boot, not per question, on purpose: the deploy script checks the new commit out of /opt/founderos before it
 * restarts the service, so a later read could name a commit this process is not yet running.
 *
 * Pure and injected: git, the clock and the uptime are arguments, so the line is unit-tested without a repository.
 * Every failure (no git, no repository, a timeout, odd output) is the word `unknown`, never a throw: a missing version
 * must not stop the bot from booting, and the line says so instead of inventing a commit.
 */

import { execFileSync } from "node:child_process";

/** Runs `git <args>` and returns its stdout; throws when git fails. */
export type GitRunner = (args: readonly string[]) => string;

export interface DeployedCommit {
  /** Seven hex characters. */
  readonly sha: string;
  readonly committedAt: Date;
  /** The commit's first line, as written (not yet tidied for display). */
  readonly subject: string;
}

const GIT_TIMEOUT_MS = 5_000;
const SUBJECT_MAX = 100;
const SEP = "\u001f";

/** The real runner: `git` in `cwd` (the process's own directory by default), no shell, no stderr noise. */
export const gitRunner =
  (cwd: string = process.cwd()): GitRunner =>
  (args) =>
    execFileSync("git", [...args], { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });

/** HEAD's full sha, committer time (epoch seconds) and subject, from one call so they cannot come from two different commits. */
export function readDeployedCommit(run: GitRunner): DeployedCommit | null {
  try {
    const [sha = "", epoch = "", ...subject] = run(["log", "-1", "--format=%H%x1f%ct%x1f%s"]).trim().split(SEP);
    if (!/^[0-9a-f]{7,64}$/.test(sha) || !/^\d+$/.test(epoch)) return null;
    return { sha: sha.slice(0, 7), committedAt: new Date(Number(epoch) * 1000), subject: subject.join(SEP) };
  } catch {
    // allow-failopen: no git, no repository or a timeout means "unknown", which the line says out loud; it must not stop boot.
    return null;
  }
}

/** "2026-10-07 08:42 UTC": the format the daemons' status files already use. */
const utc = (when: Date): string => `${when.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** One line: no newlines, quotes swapped for apostrophes (the subject sits inside quotes), long subjects cut. */
function tidy(subject: string): string {
  const flat = subject.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return flat.length <= SUBJECT_MAX ? flat : `${flat.slice(0, SUBJECT_MAX - 1).trimEnd()}…`;
}

export function deployedLine(commit: DeployedCommit | null, startedAt: Date): string {
  const started = `process started ${utc(startedAt)}`;
  return commit === null
    ? `Deployed: unknown, ${started}`
    : `Deployed: ${commit.sha} "${tidy(commit.subject)}" (${utc(commit.committedAt)}), ${started}`;
}

/** The line for a process that started `uptimeSeconds` before `now` (epoch ms). */
export function bootDeployedLine(run: GitRunner = gitRunner(), now: number = Date.now(), uptimeSeconds: number = process.uptime()): string {
  return deployedLine(readDeployedCommit(run), new Date(now - uptimeSeconds * 1000));
}

const AT_BOOT = bootDeployedLine();

/** The line computed when this module loaded, which is when the process booted. Same value for the process's whole life. */
export const deployedAtBoot = (): string => AT_BOOT;
