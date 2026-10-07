/**
 * judgeFailFirst: a locked test must FAIL on the code as it is before the fix.
 *
 * Bug it defends (#956 → #965, 2026-10-06): the spec step wrote a locked test for a bug #834 had already fixed. The test
 * passed on the unchanged code, nothing checked, the founder approved it, and Antigravity opened a PR with no fix in it.
 * The report shapes below are the ones vitest 2.1.9 printed on the VPS (claude-agent, git-archive copy, symlinked
 * node_modules, --reporter=json) for a red test, a test that does not load, a skipped-only test and a file not run.
 */
import { describe, expect, it } from "vitest";
import { judgeFailFirst } from "../../../src/tools/fail-first.js";

const T = "tests/unit/x/red.test.ts";
const ROOT = "/var/lib/claude-agent/spec-work/issue-1-42";
const file = (status: string, assertions: string[], message = "", name = `${ROOT}/${T}`) => ({
  name,
  status,
  message,
  assertionResults: assertions.map((s, i) => ({ status: s, fullName: `case ${i}` })),
});
const report = (...testResults: unknown[]) => JSON.stringify({ numTotalTests: 1, testResults });

describe("judgeFailFirst", () => {
  it("FAILS when an assertion in a locked test fails: the spec is honest", () => {
    expect(judgeFailFirst(report(file("failed", ["failed", "passed"])), [T])).toEqual({ status: "FAILS", reason: expect.stringContaining("1 of 2") });
  });

  it("PASSES when every assertion passes: the behaviour is already there", () => {
    const v = judgeFailFirst(report(file("passed", ["passed", "passed", "passed", "passed"])), [T]);
    expect(v.status).toBe("PASSES");
    expect(v.reason).toContain("4");
  });

  it("PASSES when the only tests are skipped: nothing was asserted, so nothing fails", () => {
    expect(judgeFailFirst(report(file("passed", ["skipped"])), [T]).status).toBe("PASSES");
  });

  it("FAILS when the test imports a module the task has to create (a feature's new file)", () => {
    const msg = `Failed to load url ../../../src/tools/new-thing.js (resolved id: ../../../src/tools/new-thing.js) in ${ROOT}/${T}. Does the file exist?`;
    expect(judgeFailFirst(report(file("failed", [], msg)), [T]).status).toBe("FAILS");
  });

  it("BROKEN when the file does not load for any other reason (a syntax error is not a red test)", () => {
    const v = judgeFailFirst(report(file("failed", [], "Transform failed with 1 error: Expected \";\" but found \"x\"")), [T]);
    expect(v.status).toBe("BROKEN");
    expect(v.reason).toContain(T);
    expect(v.reason).toContain("Transform failed");
  });

  it("BROKEN when a locked test was not run at all (outside vitest's include, or misnamed)", () => {
    const v = judgeFailFirst(JSON.stringify({ testResults: [] }), [T]);
    expect(v.status).toBe("BROKEN");
    expect(v.reason).toContain(`${T} was not run`);
  });

  it("BROKEN when one locked file is red but another does not load: every locked test must be a real test", () => {
    const other = "tests/unit/x/other.test.ts";
    const v = judgeFailFirst(report(file("failed", ["failed"]), file("failed", [], "SyntaxError: bad", `${ROOT}/${other}`)), [T, other]);
    expect(v.status).toBe("BROKEN");
    expect(v.reason).toContain(other);
  });

  it("matches a locked path on a path boundary, not as a bare suffix", () => {
    const v = judgeFailFirst(report(file("failed", ["failed"], "", `${ROOT}/tests/unit/x/not-red.test.ts`)), ["red.test.ts"]);
    expect(v.status).toBe("BROKEN");
  });

  it("BROKEN on a report that is not vitest JSON (empty file, a crash before the reporter ran)", () => {
    for (const bad of ["", "not json", "[]", JSON.stringify({ testResults: "x" })]) {
      expect(judgeFailFirst(bad, [T]).status).toBe("BROKEN");
    }
  });

  it("BROKEN with no locked tests to judge", () => {
    expect(judgeFailFirst(report(file("failed", ["failed"])), []).status).toBe("BROKEN");
  });
});
