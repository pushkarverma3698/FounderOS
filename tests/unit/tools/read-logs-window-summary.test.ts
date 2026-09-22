/**
 * read_logs must summarize the WINDOW it scanned, not the slice it returned.
 *
 * THE INCIDENT (2026-09-22 20:25, production). The founder asked "Check production
 * logs for founder Os". read_logs ran with the default 1-hour window and a limit of
 * 50. The window held 66 lines containing 5 warnings; the last-50 slice held 1.
 * summarizeLogs() ran on the SLICE, so the tool reported "0 errors, 1 warning" and
 * `truncated: false`, and FounderOS replied:
 *
 *   "Overall Status: Healthy / Fully Operational (0 errors, 1 warning)"
 *
 * Four warnings were dropped and the model was told the window was complete. This
 * is the same confident false negative the SCAN_CAP comment in read-logs.ts was
 * written to kill — that fix corrected journalctl's `-n` and left the identical
 * bug one layer down in `filtered.slice(-limit)`.
 *
 * A tool whose job is to stop the agent guessing must not itself report a number
 * that is true of the excerpt and false of the evidence.
 */

import { describe, expect, it } from "vitest";
import { readLogs, type JournalRunner } from "../../../src/tools/read-logs.js";

/** n info lines then `errors` error lines and `warns` warn lines at the END. */
function journal(opts: { info: number; warns: number; errors: number }): string {
  const line = (level: number, i: number) =>
    JSON.stringify({ level, time: "2026-09-22T20:00:00.000Z", module: "test", msg: `m${i}` });
  return [
    ...Array.from({ length: opts.info }, (_, i) => line(30, i)),
    ...Array.from({ length: opts.warns }, (_, i) => line(40, i)),
    ...Array.from({ length: opts.errors }, (_, i) => line(50, i)),
  ].join("\n");
}

const runnerFor = (stdout: string): JournalRunner => async () => ({ stdout, stderr: "", code: 0 });

interface Data {
  lines: string[];
  summary: { total: number; errors: number; warnings: number };
  note: string;
  scanned: number;
  matched: number;
  returned: number;
  truncated: boolean;
  withheld: number;
}

describe("read_logs — summary describes the scanned window", () => {
  /**
   * The production shape, reproduced: warnings sit OUTSIDE the returned tail.
   * 5 warnings first, then 60 info lines, limit 50 → the tail is pure info.
   */
  it("counts warnings that fall outside the returned slice", async () => {
    const stdout = [
      journal({ info: 0, warns: 5, errors: 0 }),
      journal({ info: 60, warns: 0, errors: 0 }),
    ].join("\n");

    const res = await readLogs({ limit: 50 }, runnerFor(stdout));
    expect(res.success).toBe(true);
    const data = res.data as Data;

    expect(data.lines).toHaveLength(50); // the excerpt is still capped
    expect(data.summary.warnings).toBe(5); // …but the count is of the window
    expect(data.summary.total).toBe(65);
  });

  it("counts errors that fall outside the returned slice", async () => {
    const stdout = [
      journal({ info: 0, warns: 0, errors: 12 }),
      journal({ info: 40, warns: 0, errors: 0 }),
    ].join("\n");

    const data = (await readLogs({ limit: 20 }, runnerFor(stdout))).data as Data;
    expect(data.summary.errors).toBe(12);
    expect(data.lines).toHaveLength(20);
  });

  /**
   * The model must be able to tell "I have everything" from "I have an excerpt".
   * Reporting only the excerpt's size is what let "0 errors" read as a verdict.
   */
  it("reports matched vs returned and flags the withheld remainder", async () => {
    const data = (await readLogs({ limit: 10 }, runnerFor(journal({ info: 30, warns: 0, errors: 0 })))).data as Data;

    expect(data.matched).toBe(30);
    expect(data.returned).toBe(10);
    expect(data.withheld).toBe(20);
    expect(data.truncated).toBe(true);
    expect(data.note).toMatch(/20 older/i);
  });

  it("does not claim truncation when the whole window fits", async () => {
    const data = (await readLogs({ limit: 200 }, runnerFor(journal({ info: 5, warns: 1, errors: 1 })))).data as Data;

    expect(data.matched).toBe(7);
    expect(data.returned).toBe(7);
    expect(data.withheld).toBe(0);
    expect(data.truncated).toBe(false);
    expect(data.note).not.toMatch(/older/i);
  });

  /**
   * The counts must survive the level filter: a request for level='error' that
   * returns 5 of 300 errors must say 300, or "5 errors" becomes the new false
   * negative.
   */
  it("counts the full filtered window, not the returned tail, under a level filter", async () => {
    const stdout = [journal({ info: 100, warns: 0, errors: 300 })].join("\n");
    const data = (await readLogs({ level: "error", limit: 5 }, runnerFor(stdout))).data as Data;

    expect(data.summary.errors).toBe(300);
    expect(data.matched).toBe(300);
    expect(data.returned).toBe(5);
    expect(data.note).toMatch(/295 older/i);
  });
});
