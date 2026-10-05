/**
 * The integration-suite guard must never let an empty or skipped run look green, and the workflow
 * that runs it must stay fail-loud with the network kill-switch on.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { checkIntegrationReport } from "../../../scripts/check-integration-report.js";

const green = {
  numTotalTests: 3,
  numPassedTests: 3,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: [{ name: "a.test.ts", status: "passed" }],
};

describe("checkIntegrationReport", () => {
  it("passes when every test ran and passed", () => {
    expect(checkIntegrationReport(green)).toEqual({ ok: true, problems: [] });
  });

  it("fails an empty run", () => {
    const v = checkIntegrationReport({ ...green, numTotalTests: 0, numPassedTests: 0, testResults: [] });
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/empty or all skipped/);
  });

  it("fails a run where the DB suites skipped themselves", () => {
    const v = checkIntegrationReport({ ...green, numPendingTests: 12 });
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/12 integration test\(s\) skipped/);
  });

  it("fails on a failed test and a failed file", () => {
    const v = checkIntegrationReport({
      ...green,
      numFailedTests: 1,
      testResults: [{ name: "b.test.ts", status: "failed" }],
    });
    expect(v.ok).toBe(false);
    expect(v.problems).toContain("1 integration test(s) failed");
    expect(v.problems).toContain("b.test.ts: status failed");
  });

  it("treats a missing report body as an empty run", () => {
    expect(checkIntegrationReport({}).ok).toBe(false);
  });
});

describe("integration workflow contract", () => {
  const yml = readFileSync(".github/workflows/integration.yml", "utf8");

  it("never swallows failures", () => {
    expect(yml).not.toMatch(/continue-on-error/);
  });

  it("keeps the network kill-switch on (no ALLOW_NETWORK)", () => {
    expect(yml).not.toMatch(/^\s*ALLOW_NETWORK\s*:/m);
  });

  it("runs the guarded script, not bare vitest", () => {
    expect(yml).toMatch(/pnpm test:integration:ci/);
  });
});
