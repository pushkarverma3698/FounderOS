/**
 * The days a halt swallowed. While FounderOS is halted the 09:00 standup does not run; the founder is told
 * ONCE, at /resume, which days were skipped. The record is a small file beside the halt flag, so it lives
 * exactly as long as the halt does and needs no table.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSkipLedger, formatSkippedLine, skipLedgerPath } from "../../../src/goals/skipped.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "goals-skips-"));
});
afterEach(async () => {
  delete process.env["HALT_FLAG_PATH"];
  await rm(dir, { recursive: true, force: true });
});

describe("createFileSkipLedger", () => {
  it("records a date once however often it is recorded, and hands the days over exactly once", async () => {
    const ledger = createFileSkipLedger(join(dir, "skipped.json"));
    await ledger.record("2026-09-30");
    await ledger.record("2026-09-30");
    await ledger.record("2026-10-01");
    expect(await ledger.take()).toEqual(["2026-09-30", "2026-10-01"]);
    expect(await ledger.take()).toEqual([]);
  });

  it("returns days in date order whatever order they were recorded in", async () => {
    const ledger = createFileSkipLedger(join(dir, "skipped.json"));
    await ledger.record("2026-10-02");
    await ledger.record("2026-09-30");
    expect(await ledger.take()).toEqual(["2026-09-30", "2026-10-02"]);
  });

  it("has nothing to hand over when nothing was skipped", async () => {
    expect(await createFileSkipLedger(join(dir, "never-written.json")).take()).toEqual([]);
  });

  it("creates its directory, and survives a new ledger object reading what an earlier one wrote (a restart)", async () => {
    const path = join(dir, "nested", "deeper", "skipped.json");
    await createFileSkipLedger(path).record("2026-09-30");
    expect(await createFileSkipLedger(path).take()).toEqual(["2026-09-30"]);
  });

  it("treats an unreadable file as empty rather than blocking /resume, and can be written again", async () => {
    const path = join(dir, "skipped.json");
    await writeFile(path, "{not json", "utf8");
    const ledger = createFileSkipLedger(path);
    expect(await ledger.take()).toEqual([]);
    await ledger.record("2026-09-30");
    expect(await ledger.take()).toEqual(["2026-09-30"]);
  });

  it("ignores entries in the file that are not real dates", async () => {
    const path = join(dir, "skipped.json");
    await writeFile(path, JSON.stringify({ dates: ["2026-09-30", "tomorrow", "2026-02-30", 5, null] }), "utf8");
    expect(await createFileSkipLedger(path).take()).toEqual(["2026-09-30"]);
  });

  it("writes plain JSON a person can read", async () => {
    const path = join(dir, "skipped.json");
    await createFileSkipLedger(path).record("2026-09-30");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ dates: ["2026-09-30"] });
  });
});

describe("skipLedgerPath — beside the halt flag", () => {
  it("is standup-skipped.json in the same directory as the flag", () => {
    process.env["HALT_FLAG_PATH"] = join(dir, "HALT");
    expect(skipLedgerPath()).toBe(join(dir, "standup-skipped.json"));
  });
});

describe("formatSkippedLine — the one line at /resume", () => {
  it("names one skipped day, or several in order", () => {
    expect(formatSkippedLine(["2026-09-30"])).toBe("standup skipped on 30 Sep");
    expect(formatSkippedLine(["2026-09-30", "2026-10-01", "2026-10-02"])).toBe("standup skipped on 30 Sep, 1 Oct, 2 Oct");
  });

  it("says nothing when nothing was skipped", () => {
    expect(formatSkippedLine([])).toBeNull();
  });
});
