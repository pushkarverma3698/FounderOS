/**
 * FounderOS — start the job for an issue that was just filed or approved
 * ======================================================================
 * One /task = one process that owns the job from start to finish and reports its own outcome (a PR card
 * or the error) to Telegram. The bot's only act is to hand that process its work: it writes ONE JSON line
 * `{repo, issue, stage}` to the fos-job socket, and systemd starts `deploy/job-run` for the connection.
 *
 * THIS IS THE PATH, NOT A SHORTCUT. There is no cron fallback that picks the issue up later for the
 * founder's benefit: when the socket cannot be reached the result says so, and the caller tells the
 * founder in the same chat (see `startFailureNote`). Silence about a job that never started is the failure
 * this design removes.
 *
 * WHY A SOCKET, NOT A CHILD PROCESS. The bot runs under systemd with `NoNewPrivileges=true` and
 * `PrivateTmp=true`, so a dispatcher spawned from it can never work:
 *   - every `sudo` fails ("The 'no new privileges' flag is set, which prevents sudo from running as
 *     root") and the dispatcher's startup check read that as "agy is not installed for the antigravity
 *     user": it PAUSED itself and sent the founder a false "🛑 agent-dispatch PAUSED" after every
 *     approved /task (2026-10-02);
 *   - /tmp is private to the service, so the prompt file the dispatcher writes there is invisible to the
 *     antigravity user even if sudo worked.
 * `fos-job@.service` (deploy/systemd) runs outside that sandbox, as the same user, without the flag, so
 * `sudo -n -u antigravity` works exactly as it does for cron. The bot reaches it the way it already
 * reaches /run/agy-login.sock. Nothing in this file may start a process (a test enforces it).
 *
 * `stage` is `build` for an `agent:ready` issue (the executor implements it, then pr-brain reviews the PR) and `fix` for a PR pr-brain blocked (the executor fixes
 * every blocker on the PR's branch, then pr-brain reviews the new head; the line also carries `head`, see startFixJob).
 *
 * Why it lives at the tool layer and not in the /task handler: a gateway turn returns as soon as the
 * HITL approval card is posted (src/gateway/kernel-run.ts), which is minutes to hours BEFORE the issue
 * exists. Starting the job after issues.create also covers the plain-English dispatch path and the
 * self-improvement loop, neither of which goes through /task.
 *
 * Inert unless `AGENT_DISPATCH_BIN` is set, which only the VPS does: that keeps every test run, CI run
 * and laptop run from touching a socket.
 */

import { connect } from "node:net";
import { childLogger } from "../infra/logger.js";
import { promoteRequestLine, validatePromoteRequest } from "./promote-plan.js";

const log = childLogger({ module: "tool:dispatch-tick" });

export type JobStage = "build" | "fix";

export type StartJobResult = { status: "inert" } | { status: "started" } | { status: "failed"; reason: string };

/** Delivers one request line to the socket. Injected in tests so nothing real is ever connected to. */
export type JobSender = (socketPath: string, line: string) => Promise<void>;

const DEFAULT_JOB_SOCKET = "/run/fos-job.sock";
const SEND_TIMEOUT_MS = 5_000;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** The socket `fos-job.socket` listens on (deploy/systemd/fos-job.socket). */
export function jobSocketPath(): string {
  return process.env["FOS_JOB_SOCKET"]?.trim() || DEFAULT_JOB_SOCKET;
}

/** The request line `deploy/job-run` validates. The repo is carried by name: a bare number is ambiguous across repos. */
export function jobRequestLine(issueNumber: number, repo: string, stage: JobStage, head?: string): string {
  return `${JSON.stringify({ repo: repo.trim(), issue: issueNumber, stage, ...(head ? { head } : {}) })}\n`;
}

/** What to tell the founder, in the chat that asked for the job, when it could not be started. */
export function startFailureNote(issueNumber: number, repo: string, reason: string): string {
  return (
    `Could not start the run for ${repo}#${issueNumber}: ${reason}. ` +
    `Nothing is running it. On the VPS check \`systemctl status fos-job.socket\`; the issue is filed and a retry will start it.`
  );
}

const socketSender: JobSender = (socketPath, line) =>
  new Promise<void>((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to ${socketPath}`));
    }, SEND_TIMEOUT_MS);
    const fail = (err: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.end(line, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });

/**
 * Start the job for `issueNumber` now. Never throws: a failure is returned so the caller can say so.
 * `{status: "inert"}` means this host does not run jobs (tests, CI, laptop) and there is nothing to report.
 */
export async function startDispatchJob(
  issueNumber: number,
  repo: string,
  stage: JobStage,
  send: JobSender = socketSender,
  head?: string,
): Promise<StartJobResult> {
  if (!process.env["AGENT_DISPATCH_BIN"]?.trim()) return { status: "inert" };

  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    log.warn({ issueNumber }, "refusing to start a job for a non-positive issue number");
    return { status: "failed", reason: `invalid issue number ${String(issueNumber)}` };
  }
  const repoSlug = repo.trim();
  if (!REPO_RE.test(repoSlug)) {
    log.warn({ issueNumber, repo }, "refusing to start a job for a malformed repo");
    return { status: "failed", reason: `invalid repo "${repoSlug}"` };
  }

  const socketPath = jobSocketPath();
  try {
    await send(socketPath, jobRequestLine(issueNumber, repoSlug, stage, head));
    log.info({ socketPath, issueNumber, repo: repoSlug, stage }, "handed the job to fos-job");
    return { status: "started" };
  } catch (err) {
    const reason = (err as Error).message;
    log.warn({ socketPath, issueNumber, repo: repoSlug, stage, err: reason }, "could not start the job");
    return { status: "failed", reason };
  }
}

/**
 * Start the founder's "fix it" on a PR pr-brain blocked: the executor fixes every blocker on the PR's own branch, then
 * pr-brain reviews the new head. `head` is the PR commit he was shown; the job refuses to fix a head that moved since.
 * Same socket and same dispatch lock as the cron's own re-dispatch (deploy/agent-dispatch): the two never fix one PR at once.
 */
export async function startFixJob(issueNumber: number, repo: string, head: string, send: JobSender = socketSender): Promise<StartJobResult> {
  if (!process.env["AGENT_DISPATCH_BIN"]?.trim()) return { status: "inert" };
  const sha = head.trim().toLowerCase();
  if (!SHA_RE.test(sha)) {
    log.warn({ issueNumber, head }, "refusing to start a fix for a malformed head sha");
    return { status: "failed", reason: `invalid head sha "${head.trim()}"` };
  }
  return startDispatchJob(issueNumber, repo, "fix", send, sha);
}

/**
 * Start a promotion (beta -> main -> prod) now: the same socket, `stage: promote`, no issue. The line carries the beta
 * commit the founder approved so the job refuses to promote a head he never saw. Never throws; inert off the VPS.
 */
export async function startPromoteJob(repo: string, betaSha: string, send: JobSender = socketSender): Promise<StartJobResult> {
  if (!process.env["AGENT_DISPATCH_BIN"]?.trim()) return { status: "inert" };
  const problem = validatePromoteRequest(repo, betaSha);
  if (problem) {
    log.warn({ repo, problem }, "refusing to start a promotion");
    return { status: "failed", reason: problem };
  }
  const socketPath = jobSocketPath();
  try {
    await send(socketPath, promoteRequestLine(repo, betaSha));
    log.info({ socketPath, repo: repo.trim(), betaSha }, "handed the promotion to fos-job");
    return { status: "started" };
  } catch (err) {
    const reason = (err as Error).message;
    log.warn({ socketPath, repo: repo.trim(), err: reason }, "could not start the promotion");
    return { status: "failed", reason };
  }
}
