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
  isProcessAlive,
  readPidFile,
  acquireSingleInstanceLock,
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
