/**
 * Boot notices are sent once per window (2026-10-03: the same "Google sign-in expired" alert and the same
 * "back online" card were re-sent on every restart, and a day of deploys restarts the bot a dozen times).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOT_NOTICE_GAP_MS, bootNoticeDue, sendBootNoticeOnce } from "../../../src/infra/boot-notice.js";

const HOUR = 3_600_000;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boot-notice-"));
  process.env["BOOT_NOTICE_PATH"] = join(dir, "boot-notice.json");
});
afterEach(() => {
  delete process.env["BOOT_NOTICE_PATH"];
  rmSync(dir, { recursive: true, force: true });
});

describe("bootNoticeDue (pure)", () => {
  it("is due when nothing was ever sent", () => {
    expect(bootNoticeDue({}, "restart", "x", 0)).toBe(true);
  });
  it("is not due inside the gap for the same text", () => {
    const state = { restart: { sentAt: 0, fingerprint: "x" } };
    expect(bootNoticeDue(state, "restart", "x", BOOT_NOTICE_GAP_MS.restart - 1)).toBe(false);
  });
  it("is due again once the gap has passed", () => {
    const state = { restart: { sentAt: 0, fingerprint: "x" } };
    expect(bootNoticeDue(state, "restart", "x", BOOT_NOTICE_GAP_MS.restart)).toBe(true);
  });
  it("is due immediately when the text changed (a NEW problem is never held back)", () => {
    const state = { "provider-auth": { sentAt: 0, fingerprint: "gmail" } };
    expect(bootNoticeDue(state, "provider-auth", "gmail+calendar", 1)).toBe(true);
  });
  it("kinds are independent", () => {
    const state = { restart: { sentAt: 0, fingerprint: "x" } };
    expect(bootNoticeDue(state, "provider-auth", "x", 1)).toBe(true);
  });
});

describe("sendBootNoticeOnce", () => {
  it("sends the first time, then holds an identical notice across restarts", async () => {
    const send = vi.fn(async (_t: string) => undefined);
    expect(await sendBootNoticeOnce("restart", "back online", send, 1_000)).toBe(true);
    expect(await sendBootNoticeOnce("restart", "back online", send, 1_000 + HOUR)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends again after the gap", async () => {
    const send = vi.fn(async (_t: string) => undefined);
    await sendBootNoticeOnce("restart", "back online", send, 0);
    expect(await sendBootNoticeOnce("restart", "back online", send, BOOT_NOTICE_GAP_MS.restart + 1)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a failed send is not recorded, so the next boot tries again", async () => {
    const failing = vi.fn(async (_t: string) => {
      throw new Error("telegram down");
    });
    await expect(sendBootNoticeOnce("restart", "back online", failing, 0)).rejects.toThrow("telegram down");
    const ok = vi.fn(async (_t: string) => undefined);
    expect(await sendBootNoticeOnce("restart", "back online", ok, 1)).toBe(true);
  });

  it("an unreadable state file never suppresses a notice", async () => {
    writeFileSync(join(dir, "blocker"), "x"); // a file where a directory is needed: the state can never be written
    process.env["BOOT_NOTICE_PATH"] = join(dir, "blocker", "file.json");
    const send = vi.fn(async (_t: string) => undefined);
    expect(await sendBootNoticeOnce("restart", "back online", send, 0)).toBe(true);
    expect(await sendBootNoticeOnce("restart", "back online", send, 1)).toBe(true); // cannot persist: fail open, loudly in the log
  });
});
