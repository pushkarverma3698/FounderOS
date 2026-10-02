/**
 * FounderOS — tell the VPS dispatcher an issue was just filed
 * ===========================================================
 * Nudges `agent-dispatch` to claim an issue within a minute instead of waiting for its next
 * 15-minute cron tick. Called right after the issue is created, so the founder sees Antigravity
 * start in seconds-to-a-minute rather than up to a quarter of an hour.
 *
 * THE BOT LEAVES A NOTE; IT DOES NOT START THE DISPATCHER. This used to spawn
 * `agent-dispatch --issue N --repo R` as a child of the bot. That could never work, and it did harm:
 * the bot runs under systemd with `NoNewPrivileges=true` and `PrivateTmp=true`, so in that child
 *   - every `sudo` fails ("The 'no new privileges' flag is set, which prevents sudo from running as
 *     root") and the dispatcher's startup check read that as "agy is not installed for the antigravity
 *     user": it PAUSED itself and sent the founder a false "🛑 agent-dispatch PAUSED" after every
 *     approved /task (2026-10-02 14:51, 15:27, 16:51), and "✅ resumed" when the next cron tick ran;
 *   - /tmp is private to the service, so the prompt file the dispatcher writes there would be invisible
 *     to the antigravity user even if sudo had worked.
 * Reproduced with `systemd-run --uid=founderos -p NoNewPrivileges=true`: sudo refused; without the
 * flag it printed agy's path.
 *
 * So the bot only appends a line to ~/.claude/agent-dispatch.kick. A cron job outside that sandbox runs
 * `agent-dispatch --kicked` every minute; it costs nothing when the file is absent, and when it is
 * there it runs an ordinary tick, which is the same path cron has always used.
 *
 * THIS IS A SHORTCUT, NEVER A DEPENDENCY. Cron's 15-minute tick remains the guaranteed path: every
 * failure here (not on the VPS, directory unwritable, the per-minute job not installed) costs at most
 * the 15 minutes it was trying to save. So nothing in here throws, nothing is awaited, and nothing
 * reaches the ToolResult. An issue that is filed is the deliverable; when it is claimed is an
 * optimisation.
 *
 * Why it lives at the tool layer and not in the /task handler: a gateway turn returns as soon as the
 * HITL approval card is posted (src/gateway/kernel-run.ts), which is minutes to hours BEFORE the issue
 * exists. A note left there would describe an issue that does not exist yet. Writing it after
 * issues.create also covers the plain-English dispatch path and the self-improvement loop, neither of
 * which goes through /task.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "tool:dispatch-tick" });

/** Where the note goes. Injected in tests so nothing real is ever written. */
export type KickWriter = (file: string, line: string) => void;

const fileWriter: KickWriter = (file, line) => {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, line, { mode: 0o600 });
};

/** The file `agent-dispatch --kicked` watches (KICK_FILE in deploy/agent-dispatch). */
export function kickFilePath(): string {
  return process.env["AGENT_DISPATCH_KICK_FILE"]?.trim() || join(homedir(), ".claude", "agent-dispatch.kick");
}

/**
 * Ask the dispatcher to look at the queue now. A silent no-op unless `AGENT_DISPATCH_BIN` is set, which
 * only the VPS does: that keeps every test run, CI run and laptop run inert.
 *
 * `repo` (owner/name) is recorded with the issue number because the dispatcher's log says what it was
 * kicked for, and a bare number is ambiguous across its four repos (a FounderOS-numbered issue was once
 * "claimed" in place of a same-numbered Oplify one, 2026-09-21).
 */
export function kickDispatchTick(issueNumber: number, repo: string, write: KickWriter = fileWriter): void {
  if (!process.env["AGENT_DISPATCH_BIN"]?.trim()) return;

  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    log.warn({ issueNumber }, "refusing to leave a kick note for a non-positive issue number");
    return;
  }

  const repoSlug = repo.trim();
  if (!repoSlug) {
    log.warn({ issueNumber }, "refusing to leave a kick note without a repo");
    return;
  }

  const file = kickFilePath();
  try {
    write(file, `${repoSlug}#${issueNumber}\n`);
    log.info({ file, issueNumber, repo: repoSlug }, "left a kick note for agent-dispatch");
  } catch (err) {
    // allow-failopen: the issue is already filed; cron claims it within 15 minutes.
    log.warn(
      { file, issueNumber, repo: repoSlug, err: (err as Error).message },
      "could not leave a kick note — cron will claim the issue on its next tick",
    );
  }
}
