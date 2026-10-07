/**
 * AG-034: a percentage, or a count above 10, must appear in a step result or in the
 * founder's message. Log-only: the function reports, it never rewrites.
 */
import { describe, it, expect } from "vitest";
import type { StepResult } from "../../../src/kernel/index.js";
import { findUnsupportedNumbers } from "../../../src/kernel/number-check.js";

function okWith(output: unknown): StepResult {
  return { step_id: "s1", status: "ok", output, tool_receipts: [] } as unknown as StepResult;
}

describe("findUnsupportedNumbers", () => {
  it("#297: '95% of candidates' with no such number in results is flagged", () => {
    expect(findUnsupportedNumbers("About 95% of candidates never hear back.", [okWith({ count: 3 })], "how are my applications")).toEqual(["95%"]);
  });

  it("#522: '11 automated commits in 72 hours' flags both numbers", () => {
    const out = findUnsupportedNumbers("Antigravity made 11 automated commits in 72 hours.", [okWith({ commits: [] })], "status?");
    expect(out).toEqual(["11", "72"]);
  });

  it("a number present in a step result passes", () => {
    expect(findUnsupportedNumbers("There are 42 open issues.", [okWith({ open_issues: 42 })], "issues?")).toEqual([]);
  });

  it("a percentage present in a step result passes", () => {
    expect(findUnsupportedNumbers("Coverage is 87.5%.", [okWith({ coverage: "87.5%" })], "coverage?")).toEqual([]);
  });

  it("a number the founder typed passes", () => {
    expect(findUnsupportedNumbers("Yes, the 500 rows are loaded.", [], "did the 500 rows load?")).toEqual([]);
  });

  it("a digit run inside a longer number does not count as support", () => {
    expect(findUnsupportedNumbers("That is 12 items.", [okWith({ id: 1234 })], "x")).toEqual(["12"]);
  });

  it("counts of 10 or fewer and issue refs are ignored", () => {
    expect(findUnsupportedNumbers("Issue #762 has 3 PRs and 10 files.", [], "x")).toEqual([]);
  });

  it("thousands separators are normalised on both sides", () => {
    expect(findUnsupportedNumbers("1,200 rows.", [okWith({ rows: 1200 })], "x")).toEqual([]);
  });

  it("returns each number once", () => {
    expect(findUnsupportedNumbers("40% then 40% again", [], "x")).toEqual(["40%"]);
  });
});
