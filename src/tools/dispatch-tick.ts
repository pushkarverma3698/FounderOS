/**
 * FounderOS — kick the VPS dispatch tick
 * ======================================
 * Nudges `agent-dispatch` to claim an issue immediately instead of waiting for its
 * next cron tick (every 15 minutes). Called right after the issue is created, so the
 * founder sees Antigravity start in seconds rather than up to a quarter of an hour.
 *
 * THIS IS A SHORTCUT, NEVER A DEPENDENCY. Cron remains the guaranteed path: every
 * failure here — binary unset, executable missing, spawn refused, the child killed by
 * a deploy — costs at most the 15 minutes it was trying to save. So nothing in here
 * throws, nothing is awaited, and nothing reaches the ToolResult. An issue that is
 * filed is the deliverable; when it gets claimed is an optimisation.
 *
 * Why it lives at the tool layer and not in the /task handler: a gateway turn returns
 * as soon as the HITL approval card is posted (src/gateway/kernel-run.ts), which is
 * minutes to hours BEFORE the issue exists. A kick fired there would run against an
 * empty queue. Firing after issues.create also covers the plain-English dispatch path
 * and the self-improvement loop, neither of which goes through /task.
 *
 * Known limitation: the child inherits founderos.service's cgroup, so a deploy
 * (`systemctl restart founderos`) kills an in-flight kicked tick. That is the
 * documented fallback working as intended — cron picks the issue up on the next tick.
 */

import { spawn } from "node:child_process";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "tool:dispatch-tick" });

/** Injected in tests so no real process is ever created. */
export type Spawner = (command: string, args: readonly string[]) => void;

const detachedSpawner: Spawner = (command, args) => {
  const child = spawn(command, [...args], { detached: true, stdio: "ignore" });
  // Without unref() the parent keeps a handle on a process that can run for 30
  // minutes, and the bot's own shutdown would block on it.
  child.unref();
};

/**
 * Ask the dispatcher to claim `issueNumber` in `repo` now. Silent no-op unless
 * `AGENT_DISPATCH_BIN` is set, which only the VPS does.
 *
 * `repo` (owner/name) is required, not inferred: `--issue N` alone leaves the
 * dispatcher's multi-repo loop to claim whichever `${ISSUE_REPOS[0]}` comes up
 * first, independent of which repo issue N actually lives in — confirmed
 * live 2026-09-21, a FounderOS-numbered issue silently "claimed" in place of
 * a same-numbered Oplify one. `--repo` lets the loop skip every repo but the
 * one the caller means.
 */
export function kickDispatchTick(
  issueNumber: number,
  repo: string,
  spawner: Spawner = detachedSpawner,
): void {
  const bin = process.env["AGENT_DISPATCH_BIN"]?.trim();
  if (!bin) return;

  // A bare or malformed tick would scan the agent:ready queue and could claim a
  // different issue than the one just filed.
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    log.warn({ issueNumber }, "refusing to kick dispatch for a non-positive issue number");
    return;
  }

  const repoSlug = repo.trim();
  if (!repoSlug) {
    log.warn({ issueNumber }, "refusing to kick dispatch without a repo — would claim the wrong one");
    return;
  }

  try {
    spawner(bin, ["--issue", String(issueNumber), "--repo", repoSlug]);
    log.info({ bin, issueNumber, repo: repoSlug }, "kicked agent-dispatch for freshly filed issue");
  } catch (err) {
    // allow-failopen: the issue is already filed; cron claims it within 15 minutes.
    log.warn(
      { bin, issueNumber, repo: repoSlug, err: (err as Error).message },
      "dispatch kick failed — cron will claim it",
    );
  }
}
