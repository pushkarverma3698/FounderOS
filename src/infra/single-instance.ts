/**
 * FounderOS — Single-Instance Lock
 * =================================
 * The Telegram bot uses long polling (getUpdates). Two live instances make
 * Telegram return `409 Conflict: terminated by other getUpdates request`, and
 * updates get split randomly between processes — messages drop and HITL
 * approvals can land on the wrong instance. This was the #1 source of "the bot
 * feels unreliable": stale processes accumulated across restarts.
 *
 * This module makes startup idempotent. On boot we read the PID file; if a
 * previous instance is still alive we SIGTERM it, then claim the lock with our
 * own PID. Result: exactly one process owns the poll loop.
 *
 * Pure helpers (`isProcessAlive`, `readPidFile`) are unit-tested; the kill /
 * alive checks are injectable for deterministic tests.
 */

import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "single-instance" });

/** Default lock location — matches the documented restart workflow. */
export const DEFAULT_PID_FILE = process.env["FOUNDEROS_PID_FILE"] ?? "/tmp/founderos.pid";

/** Liveness probe: `kill(pid, 0)` throws ESRCH if the process is gone. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it → still "alive".
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read and parse the PID file. Returns null if missing or malformed. */
export function readPidFile(pidFile: string): number | null {
  try {
    const raw = readFileSync(pidFile, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export interface AcquireLockOptions {
  pidFile?: string;
  /** Accepted for test ergonomics; a live previous instance is always signalled. */
  killSignal?: boolean;
  /** Test seam: liveness check. */
  _isAlive?: (pid: number) => boolean;
  /** Test seam: kill implementation. */
  _kill?: (pid: number, sig: NodeJS.Signals) => void;
}

export interface AcquireLockResult {
  /** PID of the previous live instance we replaced, or null if none. */
  replacedPid: number | null;
}

/**
 * Claim the single-instance lock for the current process.
 *  - No file / stale (dead) PID  → just write our PID.
 *  - Live previous instance      → SIGTERM it, then write our PID.
 *  - File already holds our PID   → no-op (re-entrant safe).
 */
export function acquireSingleInstanceLock(opts: AcquireLockOptions = {}): AcquireLockResult {
  const pidFile = opts.pidFile ?? DEFAULT_PID_FILE;
  const isAlive = opts._isAlive ?? isProcessAlive;
  const kill = opts._kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));

  const existing = readPidFile(pidFile);
  let replacedPid: number | null = null;

  if (existing !== null && existing !== process.pid && isAlive(existing)) {
    replacedPid = existing;
    try {
      kill(existing, "SIGTERM");
      log.warn({ replacedPid: existing }, "Replaced a previous live FounderOS instance (SIGTERM)");
    } catch (err) {
      log.warn({ replacedPid: existing, err: (err as Error).message }, "Failed to signal previous instance");
    }
  }

  writeFileSync(pidFile, `${process.pid}\n`, "utf-8");
  return { replacedPid };
}

export interface WaitForExitOptions {
  /** Max time to wait for graceful exit before SIGKILL (default 8000ms). */
  timeoutMs?: number;
  /** Poll interval (default 200ms). */
  pollMs?: number;
  /** Test seams. */
  _isAlive?: (pid: number) => boolean;
  _kill?: (pid: number, sig: NodeJS.Signals) => void;
  _sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait for a SIGTERM'd previous instance to actually exit before we proceed.
 *
 * Why this is load-bearing: the old bot's graceful drain (bot.stop() + DB close)
 * can take several seconds, during which it still holds the Telegram long-poll
 * AND the health port. If the new instance proceeds on a fixed sleep and the old
 * one hasn't exited, the health-server bind throws EADDRINUSE and the NEW
 * instance dies — leaving the STALE old code running and invisible to the lock.
 * Polling until the PID is truly gone (escalating to SIGKILL on timeout) makes
 * restarts deterministic.
 *
 * Returns true if the process exited (or was killed), false if it somehow
 * survived even SIGKILL within the timeout window.
 */
export async function waitForProcessExit(
  pid: number,
  opts: WaitForExitOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const pollMs = opts.pollMs ?? 200;
  const isAlive = opts._isAlive ?? isProcessAlive;
  const kill = opts._kill ?? ((p: number, sig: NodeJS.Signals) => process.kill(p, sig));
  const sleep = opts._sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const deadline = Date.now() + timeoutMs;
  let escalated = false;

  while (isAlive(pid)) {
    if (Date.now() >= deadline) {
      if (escalated) {
        log.error({ pid }, "Previous instance survived SIGKILL — proceeding may risk a 409 conflict");
        return false;
      }
      // Graceful window elapsed — force-kill so the port/long-poll is released.
      try {
        kill(pid, "SIGKILL");
        log.warn({ pid }, "Previous instance did not exit in time — sent SIGKILL");
      } catch {
        /* already gone between the alive check and here */
      }
      escalated = true;
      // Give the OS a final moment to reap and release sockets.
      await sleep(pollMs);
      continue;
    }
    await sleep(pollMs);
  }
  return true;
}

/** Remove the lock file if it still belongs to us. Safe to call on shutdown. */
export function releaseSingleInstanceLock(pidFile: string = DEFAULT_PID_FILE): void {
  if (readPidFile(pidFile) === process.pid) {
    try {
      rmSync(pidFile, { force: true });
    } catch {
      /* best-effort */
    }
  }
}
