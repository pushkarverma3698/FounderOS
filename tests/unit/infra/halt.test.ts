/**
 * Tests for the global halt (kill switch) — src/infra/halt.ts.
 *
 * The kill switch is a production safety rail: when engaged, the gateway refuses
 * every new turn and every approval resume. These tests lock the contract:
 *   - engage → read → release lifecycle round-trips
 *   - release is idempotent (no throw when not halted)
 *   - presence is authoritative: a corrupt flag file still reports halted (fail-safe)
 *   - readHalt returns null when not halted (fail-open is ONLY for "no flag")
 *   - formatHaltNotice is pure and HTML-safe
 *
 * Each test points HALT_FLAG_PATH at an isolated temp file so runs never collide
 * and never touch the real $HOME/.founderos/HALT.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engageHalt, releaseHalt, readHalt, formatHaltNotice, haltFilePath } from "../../../src/infra/halt.js";

let dir: string;
let flagPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "founderos-halt-"));
  flagPath = join(dir, "nested", "HALT"); // nested → exercises lazy mkdir
  process.env["HALT_FLAG_PATH"] = flagPath;
});

afterEach(() => {
  delete process.env["HALT_FLAG_PATH"];
  rmSync(dir, { recursive: true, force: true });
});

describe("haltFilePath", () => {
  it("honours the HALT_FLAG_PATH env override", () => {
    expect(haltFilePath()).toBe(flagPath);
  });

  it("falls back to $HOME/.founderos/HALT when override is empty", () => {
    process.env["HALT_FLAG_PATH"] = "";
    expect(haltFilePath()).toMatch(/\.founderos\/HALT$/);
  });
});

describe("engage → read → release lifecycle", () => {
  it("readHalt returns null before any halt is engaged", async () => {
    expect(await readHalt()).toBeNull();
  });

  it("engageHalt writes the flag and readHalt reports the state", async () => {
    const state = await engageHalt("deploying v2", "pushkar");
    expect(existsSync(flagPath)).toBe(true);
    expect(state.reason).toBe("deploying v2");
    expect(state.by).toBe("pushkar");
    expect(state.engagedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601

    const read = await readHalt();
    expect(read).not.toBeNull();
    expect(read?.reason).toBe("deploying v2");
    expect(read?.by).toBe("pushkar");
  });

  it("releaseHalt deletes the flag and readHalt returns null again", async () => {
    await engageHalt("stop");
    expect(await readHalt()).not.toBeNull();
    await releaseHalt();
    expect(existsSync(flagPath)).toBe(false);
    expect(await readHalt()).toBeNull();
  });

  it("releaseHalt is idempotent (no throw when nothing is halted)", async () => {
    await expect(releaseHalt()).resolves.toBeUndefined();
    await expect(releaseHalt()).resolves.toBeUndefined();
  });

  it("engageHalt is idempotent — re-engaging overwrites metadata", async () => {
    await engageHalt("first reason");
    const second = await engageHalt("second reason", "ops");
    expect(second.reason).toBe("second reason");
    expect((await readHalt())?.reason).toBe("second reason");
  });

  it("falls back to a default reason when an empty reason is given", async () => {
    const state = await engageHalt("   ");
    expect(state.reason).toBe("no reason given");
  });
});

describe("fail-safe: presence is authoritative", () => {
  it("treats a present-but-corrupt flag file as halted (never fail-open)", async () => {
    // Write a corrupt flag directly at the resolved path.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(flagPath, "{ this is not valid json");
    const read = await readHalt();
    expect(read).not.toBeNull(); // halted despite corruption
    expect(read?.reason).toMatch(/unreadable/i);
  });

  it("backfills missing fields from a partial flag file", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(flagPath, JSON.stringify({ reason: "partial" })); // no engagedAt / by
    const read = await readHalt();
    expect(read?.reason).toBe("partial");
    expect(read?.engagedAt).toBe("unknown");
    expect(read?.by).toBe("unknown");
  });
});

describe("formatHaltNotice (pure)", () => {
  it("includes the reason, who, and the /resume hint", () => {
    const out = formatHaltNotice({ reason: "deploying", engagedAt: "2026-06-12T10:00:00Z", by: "pushkar" });
    expect(out).toContain("deploying");
    expect(out).toContain("pushkar");
    expect(out).toContain("/resume");
    expect(out).toContain("halted");
  });

  it("escapes HTML in the reason so a crafted reason can't break Telegram markup", () => {
    const out = formatHaltNotice({ reason: "<b>x</b> & \"y\"", engagedAt: "now", by: "<i>z</i>" });
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(out).toContain("&amp;");
    expect(out).toContain("&quot;y&quot;");
    expect(out).not.toMatch(/<b>x<\/b>/); // raw tag must not survive
  });

  it("is deterministic for a given state", () => {
    const state = { reason: "r", engagedAt: "t", by: "b" };
    expect(formatHaltNotice(state)).toBe(formatHaltNotice(state));
  });
});
