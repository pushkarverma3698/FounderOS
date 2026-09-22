/**
 * Third-party nag output must not crowd real evidence out of the log window.
 *
 * MEASURED 2026-09-23 on the production journal: of 1,398 lines in 24 hours, 674
 * — 48% — were the composio-core line
 *
 *   "2026-09-22T20:58:02.302Z - 🚀 Upgrade available! Your composio-core version
 *    (0.10.0) is behind. Latest version: 0.19.0."
 *
 * emitted every ~2 minutes by a dependency. Half the capacity of the one
 * instrument FounderOS has for observing itself is spent on a message nobody
 * reads, and it is why the 2026-09-22 "check production logs" request came back
 * "Healthy": the excerpt it was given was mostly this.
 *
 * Excluded, never silently dropped. The count is reported so the window stays
 * honest — hiding lines to make a number look better is the defect this file sits
 * next to, pointing the other way.
 */

import { describe, expect, it } from "vitest";
import { readLogs, isNoiseLine, type JournalRunner } from "../../../src/tools/read-logs.js";

const runnerFor = (stdout: string): JournalRunner => async () => ({ stdout, stderr: "", code: 0 });

// Verbatim from the production journal.
const NAG =
  "2026-09-22T20:58:02.302Z - 🚀 Upgrade available! Your composio-core version (0.10.0) is behind. Latest version: 0.19.0.";
const REAL = JSON.stringify({ level: 50, time: "2026-09-22T20:58:00.000Z", module: "kernel", msg: "boom" });

interface Data {
  lines: string[];
  summary: { errors: number };
  matched: number;
  noise: number;
  note: string;
}

describe("isNoiseLine", () => {
  it("matches the composio upgrade nag", () => {
    expect(isNoiseLine(NAG)).toBe(true);
  });

  it("matches the older 0.13.1 variant in the journal", () => {
    expect(
      isNoiseLine("2026-07-14T04:22:01.896Z - 🚀 Upgrade available! Your composio-core version (0.10.0) is behind. Latest version: 0.13.1"),
    ).toBe(true);
  });

  it.each([
    ["a structured error", REAL],
    ["a real log mentioning a version", '{"level":30,"msg":"deployed version 0.19.0"}'],
    ["an app line about upgrades", '{"level":40,"module":"deploy","msg":"Upgrade available for the VPS kernel"}'],
    ["an empty line", ""],
  ])("does not match %s", (_case, line) => {
    expect(isNoiseLine(line)).toBe(false);
  });
});

describe("read_logs — noise exclusion", () => {
  it("keeps real lines that the nag would have pushed out of the excerpt", async () => {
    // 60 nags then 1 real error: with limit 50 the error is outside the tail.
    const stdout = [...Array.from({ length: 60 }, () => NAG), REAL].join("\n");

    const data = (await readLogs({ limit: 50 }, runnerFor(stdout))).data as Data;

    expect(data.lines).toContain(REAL);
    expect(data.lines).toHaveLength(1);
    expect(data.summary.errors).toBe(1);
  });

  it("reports how many lines were excluded rather than hiding them", async () => {
    const stdout = [...Array.from({ length: 12 }, () => NAG), REAL].join("\n");

    const data = (await readLogs({}, runnerFor(stdout))).data as Data;

    expect(data.noise).toBe(12);
    expect(data.note).toMatch(/12 .*(nag|notice|third-party)/i);
  });

  it("reports zero noise when there is none", async () => {
    const data = (await readLogs({}, runnerFor(REAL))).data as Data;
    expect(data.noise).toBe(0);
    expect(data.note).not.toMatch(/third-party/i);
  });

  it("surfaces the excluded count even when nothing else matched", async () => {
    const stdout = Array.from({ length: 30 }, () => NAG).join("\n");

    const data = (await readLogs({}, runnerFor(stdout))).data as Data;

    expect(data.matched).toBe(0);
    expect(data.noise).toBe(30);
    // "genuinely empty" must not be claimed while 30 lines were removed.
    expect(data.note).toMatch(/30/);
  });

  it("an explicit grep for the nag still finds it — exclusion is a default, not a ban", async () => {
    const stdout = [NAG, REAL].join("\n");

    const data = (await readLogs({ grep: "Upgrade available" }, runnerFor(stdout))).data as Data;

    expect(data.lines).toContain(NAG);
    expect(data.noise).toBe(0);
  });
});
