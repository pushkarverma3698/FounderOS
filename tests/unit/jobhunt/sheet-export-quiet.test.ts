/**
 * Unit tests — an unset job sheet is a valid config, not a warning.
 *
 * THE NOISE THIS GUARDS AGAINST. Prod has no JOBHUNT_SHEET_ID on purpose, and
 * every sweep (two profiles, every 30 minutes) logged "Job sheet export
 * skipped" at warn level plus an info line from the exporter: about 200
 * identical lines a day that buried real warnings in the journal (2026-11-10).
 * The decision is now stated once at boot (one info line); per sweep it is silent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const logCalls: { level: string; msg: string }[] = [];
function fakeLogger(): Record<string, unknown> {
  const rec = (level: string) => (obj: unknown, msg?: string) => {
    logCalls.push({ level, msg: typeof obj === "string" ? obj : String(msg) });
  };
  return { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug"), child: () => fakeLogger() };
}
vi.mock("../../../src/infra/logger.js", () => ({ childLogger: () => fakeLogger(), logger: fakeLogger() }));

vi.mock("../../../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/config.js")>();
  return { ...actual, env: { ...actual.env, JOBHUNT_SHEET_ID: undefined, GOOGLE_SHEETS_CREDENTIALS_PATH: undefined } };
});
vi.mock("../../../src/db/apply-queries.js", () => ({ listApplyQueue: vi.fn(), listRecentlyScreened: vi.fn() }));

const { exportJobSheet, reportSheetExportConfig } = await import("../../../src/tools/jobhunt/sheet-export.js");
const { publishSheet } = await import("../../../src/tools/jobhunt/free-sweep-profile.js");

describe("unset job sheet", () => {
  beforeEach(() => {
    logCalls.length = 0;
  });

  it("logs nothing per sweep when the sheet is not configured", async () => {
    const first = await publishSheet();
    const second = await publishSheet();
    const direct = await exportJobSheet();

    expect(first).toEqual({ link: null, notice: null });
    expect(second).toEqual({ link: null, notice: null });
    expect(direct).toMatchObject({ ok: false, skipped: true });
    expect(logCalls).toEqual([]);
  });

  it("states the decision once at boot, at info, never warn", () => {
    expect(reportSheetExportConfig()).toBe(false);
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]!.level).toBe("info");
    expect(logCalls[0]!.msg).toContain("Job sheet export off");
  });

  it("reports a configured sheet as on", () => {
    expect(reportSheetExportConfig({ JOBHUNT_SHEET_ID: "s", GOOGLE_SHEETS_CREDENTIALS_PATH: "/k.json" })).toBe(true);
    expect(logCalls).toEqual([{ level: "info", msg: "Job sheet export on" }]);
  });
});
