/**
 * Unit tests for the single-instance lock.
 *
 * Why: the Telegram bot uses long polling (getUpdates). If two instances run,
 * Telegram returns 409 Conflict and updates get split randomly between them —
 * messages drop, HITL approvals land on the wrong process. This guard makes
 * startup idempotent: a fresh boot replaces any previous live instance and
 * leaves exactly one PID owning the lock file.
 *
 * Pure/file functions → no network mocks. RED until
 * src/infra/single-instance.ts exists.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isEphemeralLockPath,
  isProcessAlive,
  readPidFile,
  acquireSingleInstanceLock,
  waitForProcessExit,
} from "../../../src/infra/single-instance.js";

let dir: string;
let pidFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "founderos-lock-"));
  pidFile = join(dir, "founderos.pid");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isProcessAlive", () => {
  it("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for a pid that cannot exist", () => {
    // 2^31-ish pid never assigned on a normal machine
    expect(isProcessAlive(2_147_480_000)).toBe(false);
  });

  it("returns false for pid 0 / invalid input", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });
});

describe("readPidFile", () => {
  it("returns null when the file does not exist", () => {
    expect(readPidFile(pidFile)).toBeNull();
  });

  it("parses a valid pid", () => {
    writeFileSync(pidFile, "12345\n");
    expect(readPidFile(pidFile)).toBe(12345);
  });

  it("returns null for garbage content", () => {
    writeFileSync(pidFile, "not-a-pid");
    expect(readPidFile(pidFile)).toBeNull();
  });
});

describe("acquireSingleInstanceLock", () => {
  it("writes the current pid when no lock file exists", () => {
    const r = acquireSingleInstanceLock({ pidFile, killSignal: false });
    expect(r.replacedPid).toBeNull();
    expect(readPidFile(pidFile)).toBe(process.pid);
  });

  it("overwrites a stale pid (dead process) without trying to kill anything", () => {
    writeFileSync(pidFile, "2147480000\n"); // dead pid
    const r = acquireSingleInstanceLock({ pidFile, killSignal: false });
    expect(r.replacedPid).toBeNull(); // dead → nothing replaced
    expect(readPidFile(pidFile)).toBe(process.pid);
  });

  it("reports a live previous instance as replaced and records it via the kill hook", () => {
    writeFileSync(pidFile, "424242\n");
    const killed: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    const r = acquireSingleInstanceLock({
      pidFile,
      killSignal: false,
      _isAlive: (pid) => pid === 424242,
      _kill: (pid, sig) => killed.push({ pid, sig }),
    });
    expect(r.replacedPid).toBe(424242);
    expect(killed).toEqual([{ pid: 424242, sig: "SIGTERM" }]);
    expect(readPidFile(pidFile)).toBe(process.pid);
  });

  it("is a no-op replacement when the lock file already holds the current pid", () => {
    writeFileSync(pidFile, `${process.pid}\n`);
    const r = acquireSingleInstanceLock({ pidFile, killSignal: false });
    expect(r.replacedPid).toBeNull();
    expect(readPidFile(pidFile)).toBe(process.pid);
  });
});

/**
 * waitForProcessExit — the fix for restarts silently no-op'ing.
 *
 * Before this existed, startup waited a fixed 2s after SIGTERM; a slow graceful
 * drain meant the old instance still held the health port → the new instance
 * crashed on EADDRINUSE → the stale old code kept running. This polls until the
 * old PID is truly gone and SIGKILLs on timeout so restarts are deterministic.
 */
describe("waitForProcessExit", () => {
  const noSleep = async () => {};

  it("returns true immediately when the process is already gone", async () => {
    const ok = await waitForProcessExit(424242, { _isAlive: () => false, _sleep: noSleep });
    expect(ok).toBe(true);
  });

  it("returns true once the process exits gracefully within the timeout", async () => {
    let alivePolls = 3; // alive for 3 checks, then exits
    const ok = await waitForProcessExit(424242, {
      _isAlive: () => alivePolls-- > 0,
      _sleep: noSleep,
      timeoutMs: 10_000,
      pollMs: 1,
    });
    expect(ok).toBe(true);
  });

  it("escalates to SIGKILL when the process refuses to exit, then succeeds", async () => {
    const signals: NodeJS.Signals[] = [];
    let alive = true;
    const ok = await waitForProcessExit(424242, {
      _isAlive: () => alive,
      _kill: (_pid, sig) => {
        signals.push(sig);
        alive = false; // SIGKILL takes effect
      },
      _sleep: noSleep,
      timeoutMs: 0, // force immediate escalation
      pollMs: 1,
    });
    expect(signals).toContain("SIGKILL");
    expect(ok).toBe(true);
  });

  it("returns false when the process survives even SIGKILL", async () => {
    const ok = await waitForProcessExit(424242, {
      _isAlive: () => true, // never dies
      _kill: () => {},
      _sleep: noSleep,
      timeoutMs: 0,
      pollMs: 1,
    });
    expect(ok).toBe(false);
  });
});

describe("isEphemeralLockPath — the PrivateTmp trap", () => {
  /**
   * The lock was on /tmp/founderos.pid while deploy/founderos.service sets
   * PrivateTmp=true, so every restart got a fresh empty /tmp and the lock was
   * never read back. Verified on the box 2026-08-09: the host had no
   * /tmp/founderos.pid, only a per-invocation copy under /proc/<pid>/root/tmp.
   */
  it("flags /tmp — wiped on every service start under PrivateTmp", () => {
    expect(isEphemeralLockPath("/tmp/founderos.pid")).toBe(true);
  });

  it("flags /var/tmp and macOS's /private/tmp", () => {
    expect(isEphemeralLockPath("/var/tmp/founderos.pid")).toBe(true);
    expect(isEphemeralLockPath("/private/tmp/founderos.pid")).toBe(true);
    expect(isEphemeralLockPath("/private/var/tmp/founderos.pid")).toBe(true);
  });

  it("accepts the persistent path the unit file now pins", () => {
    expect(isEphemeralLockPath("/opt/founderos-data/founderos.pid")).toBe(false);
  });

  it("accepts other persistent locations", () => {
    expect(isEphemeralLockPath("/run/founderos/founderos.pid")).toBe(false);
    expect(isEphemeralLockPath("/opt/founderos/tmp/founderos.pid")).toBe(false);
  });

  it("does not flag a path that merely contains the substring tmp", () => {
    expect(isEphemeralLockPath("/opt/tmpdata/founderos.pid")).toBe(false);
  });
});
