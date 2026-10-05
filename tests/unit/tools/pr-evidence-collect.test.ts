import { describe, it, expect } from "vitest";
import {
  DEFAULT_REQUIRED_CHECKS,
  TEST_CHECK_NAME,
  dependencyChanged,
  mapCheckRuns,
  mapPrFiles,
  mapTreeHashes,
  mapVitestReport,
  parseCheckRuns,
  type ParsedCheck,
} from "../../../src/tools/pr-evidence-collect.js";
import { verifyImplementationGreen } from "../../../src/tools/pr-evidence.js";
import { contractFixture } from "../../helpers/contract-fixture.js";
import { PR912_HEAD, loadPrEvidenceFixture } from "../../helpers/pr-evidence-fixtures.js";

const T1 = "tests/unit/tools/oracle.test.ts";
const T2 = "tests/unit/tools/oracle-http.test.ts";

function check(over: Partial<ParsedCheck> & { name: string }): ParsedCheck {
  return { id: 1, status: "completed", conclusion: "success", headSha: PR912_HEAD, runId: 100, ...over };
}

function ok<T>(m: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!m.ok) throw new Error("expected ok, got: " + m.error);
  return m.value;
}

describe("parseCheckRuns", () => {
  it("reads the real check-runs fixture, with the workflow run id from details_url", () => {
    const checks = ok(parseCheckRuns(loadPrEvidenceFixture("pr912-check-runs.json"), PR912_HEAD));
    expect(checks).toHaveLength(8);
    const unit = checks.filter((c) => c.name === TEST_CHECK_NAME);
    expect(unit.map((c) => c.runId).sort()).toEqual([37348794832, 37348802837]);
  });
  it("accepts gh --paginate --slurp output (an array of pages)", () => {
    const page = loadPrEvidenceFixture("pr912-check-runs.json");
    expect(ok(parseCheckRuns([page, page], PR912_HEAD))).toHaveLength(16);
  });
  it("refuses a check run for a different head and malformed input", () => {
    expect(parseCheckRuns(loadPrEvidenceFixture("pr912-check-runs.json"), "f".repeat(40)).ok).toBe(false);
    expect(parseCheckRuns({ nope: 1 }, PR912_HEAD).ok).toBe(false);
    expect(parseCheckRuns("x", PR912_HEAD).ok).toBe(false);
    expect(parseCheckRuns({ check_runs: [{ id: 1, name: "" }] }, PR912_HEAD).ok).toBe(false);
  });
  it("gives runId null when details_url has no run", () => {
    const raw = { check_runs: [{ id: 5, name: "x", status: "completed", conclusion: "success", head_sha: PR912_HEAD, details_url: "https://example.com/foo" }] };
    expect(ok(parseCheckRuns(raw, PR912_HEAD))[0]?.runId).toBeNull();
  });
});

describe("mapCheckRuns", () => {
  const required = ["Type check + lint + wiring", "Unit + regression tests"];
  it("defaults the required list to the two protected CI checks", () => {
    expect(DEFAULT_REQUIRED_CHECKS).toEqual(required);
  });
  it("marks required by name and merges duplicate names (push + pull_request runs)", () => {
    const checks = ok(parseCheckRuns(loadPrEvidenceFixture("pr912-check-runs.json"), PR912_HEAD));
    const mapped = mapCheckRuns(checks, { requiredNames: required });
    expect(mapped.filter((c) => c.name === "Unit + regression tests")).toEqual([{ name: "Unit + regression tests", required: true, conclusion: "success" }]);
    expect(mapped.find((c) => c.name === "gate")).toEqual({ name: "gate", required: false, conclusion: "success" });
    expect(mapped.filter((c) => c.required).map((c) => c.name).sort()).toEqual([...required].sort());
  });
  it("a required name with no run becomes a pending check, which pr-evidence reads as UNKNOWN", () => {
    const mapped = mapCheckRuns([check({ name: "gate" })], { requiredNames: ["Unit + regression tests"] });
    expect(mapped).toContainEqual({ name: "Unit + regression tests", required: true, conclusion: null });
  });
  it("an unfinished run, or a conclusion pr-evidence does not know, is null", () => {
    const mapped = mapCheckRuns(
      [check({ name: "a", status: "in_progress", conclusion: "success" }), check({ name: "b", conclusion: null }), check({ id: 2, name: "c", conclusion: null, status: "completed" })],
      { requiredNames: ["a", "b", "c"] },
    );
    expect(mapped.map((c) => c.conclusion)).toEqual([null, null, null]);
    const odd = { check_runs: [{ id: 9, name: "z", status: "completed", conclusion: "startup_failure", head_sha: PR912_HEAD }] };
    expect(mapCheckRuns(ok(parseCheckRuns(odd, PR912_HEAD)), { requiredNames: ["z"] })[0]?.conclusion).toBeNull();
  });
  it("the worst run wins when a name has several: one red run is red", () => {
    const mapped = mapCheckRuns(
      [check({ id: 1, name: "a", conclusion: "success" }), check({ id: 2, name: "a", conclusion: "failure" }), check({ id: 3, name: "b", conclusion: "success" }), check({ id: 4, name: "b", conclusion: null, status: "in_progress" })],
      { requiredNames: ["a", "b"] },
    );
    expect(mapped).toEqual([
      { name: "a", required: true, conclusion: "failure" },
      { name: "b", required: true, conclusion: null },
    ]);
  });
  it("attaches test results only to the test check; others stay unknown", () => {
    const mapped = mapCheckRuns(
      [check({ id: 1, name: TEST_CHECK_NAME }), check({ id: 2, name: "Type check + lint + wiring" })],
      { requiredNames: required, testsByCheckId: { 1: { passedTests: [T1], failedTests: [] }, 2: { passedTests: ["x"], failedTests: ["y"] } } },
    );
    expect(mapped.find((c) => c.name === TEST_CHECK_NAME)).toMatchObject({ passedTests: [T1], failedTests: [] });
    const lint = mapped.find((c) => c.name === "Type check + lint + wiring");
    expect(lint?.passedTests).toBeUndefined();
    expect(lint?.failedTests).toBeUndefined();
  });
  it("two runs of the test check: passed = intersection, failed = union, and one run with no report makes both unknown", () => {
    const two = [check({ id: 1, name: TEST_CHECK_NAME }), check({ id: 2, name: TEST_CHECK_NAME })];
    const both = mapCheckRuns(two, {
      requiredNames: [TEST_CHECK_NAME],
      testsByCheckId: { 1: { passedTests: [T1, T2], failedTests: ["a"] }, 2: { passedTests: [T1], failedTests: ["b"] } },
    });
    expect(both[0]).toMatchObject({ passedTests: [T1], failedTests: ["a", "b"] });
    const one = mapCheckRuns(two, { requiredNames: [TEST_CHECK_NAME], testsByCheckId: { 1: { passedTests: [T1], failedTests: [] } } });
    expect(one[0]?.passedTests).toBeUndefined();
    expect(one[0]?.failedTests).toBeUndefined();
  });
});

describe("mapPrFiles", () => {
  it("maps the real PR #912 files fixture", () => {
    const files = ok(mapPrFiles(loadPrEvidenceFixture("pr912-files.json")));
    expect(files).toHaveLength(8);
    expect(files[0]).toEqual({ path: "docs/ROADMAP.md", status: "modified", additions: 1, deletions: 1 });
    expect(files.find((f) => f.path === "src/tools/oracle.ts")).toMatchObject({ status: "added", additions: 110, deletions: 0 });
  });
  it("maps copied to added, changed to modified, drops unchanged, keeps previous_filename", () => {
    const f = (filename: string, status: string, extra: object = {}) => ({ filename, status, additions: 1, deletions: 2, ...extra });
    const files = ok(
      mapPrFiles([f("a", "copied"), f("b", "changed"), f("c", "unchanged"), f("d", "renamed", { previous_filename: "old/d" }), f("e", "removed"), f("g", "added"), f("h", "modified")]),
    );
    expect(files.map((x) => [x.path, x.status])).toEqual([["a", "added"], ["b", "modified"], ["d", "renamed"], ["e", "removed"], ["g", "added"], ["h", "modified"]]);
    expect(files.find((x) => x.path === "d")?.previousPath).toBe("old/d");
    expect(files.find((x) => x.path === "a")?.previousPath).toBeUndefined();
  });
  it("accepts slurped pages and a commit object with a files array", () => {
    const one = { filename: "a", status: "added", additions: 1, deletions: 0 };
    expect(ok(mapPrFiles([[one], [{ ...one, filename: "b" }]])).map((x) => x.path)).toEqual(["a", "b"]);
    expect(ok(mapPrFiles({ sha: "x", files: [one] }))).toHaveLength(1);
  });
  it("an unknown status, malformed input, or a list GitHub may have truncated is an error", () => {
    expect(mapPrFiles([{ filename: "a", status: "teleported", additions: 0, deletions: 0 }]).ok).toBe(false);
    expect(mapPrFiles("nope").ok).toBe(false);
    expect(mapPrFiles([{ status: "added" }]).ok).toBe(false);
    const many = Array.from({ length: 3000 }, (_, i) => ({ filename: "f" + i, status: "added", additions: 1, deletions: 0 }));
    expect(mapPrFiles(many).ok).toBe(false);
  });
});

describe("mapVitestReport", () => {
  const lockedTests = [T1, T2];
  const prefix = "/home/runner/work/R/R/";
  it("strips the runner checkout prefix, inferred from a locked test", () => {
    const r = ok(mapVitestReport(loadPrEvidenceFixture("pr912-vitest-results.json"), { lockedTests }));
    expect([...r.passedTests].sort()).toEqual([T2, T1].sort());
    expect(r.failedTests).toEqual([]);
  });
  it("uses an explicit repoRoot when given, and the GitHub runner layout as a fallback", () => {
    const report = { testResults: [{ name: "/srv/ci/checkout/tests/unit/a.test.ts", status: "passed", assertionResults: [{ status: "passed" }] }] };
    expect(ok(mapVitestReport(report, { lockedTests: [], repoRoot: "/srv/ci/checkout" })).passedTests).toEqual(["tests/unit/a.test.ts"]);
    const runner = { testResults: [{ name: prefix + "tests/unit/a.test.ts", status: "passed", assertionResults: [{ status: "passed" }] }] };
    expect(ok(mapVitestReport(runner, { lockedTests: [] })).passedTests).toEqual(["tests/unit/a.test.ts"]);
  });
  it("a locked test the report never mentions is simply absent (pr-evidence then says it did not run)", () => {
    const r = ok(mapVitestReport(loadPrEvidenceFixture("pr912-vitest-results.json"), { lockedTests: [...lockedTests, "tests/unit/other.test.ts"] }));
    expect(r.passedTests).not.toContain("tests/unit/other.test.ts");
  });
  it("a file is failed when any assertion failed or the suite itself failed (import error)", () => {
    const report = {
      testResults: [
        { name: prefix + "tests/unit/a.test.ts", status: "failed", assertionResults: [{ status: "passed" }, { status: "failed" }] },
        { name: prefix + "tests/unit/b.test.ts", status: "failed", assertionResults: [] },
        { name: prefix + "tests/unit/c.test.ts", status: "passed", assertionResults: [{ status: "passed" }, { status: "failed" }] },
      ],
    };
    const r = ok(mapVitestReport(report, { lockedTests: [] }));
    expect([...r.failedTests].sort()).toEqual(["tests/unit/a.test.ts", "tests/unit/b.test.ts", "tests/unit/c.test.ts"]);
    expect(r.passedTests).toEqual([]);
  });
  it("skipped, todo and empty files do not count as passed", () => {
    const report = {
      testResults: [
        { name: prefix + "tests/unit/a.test.ts", status: "passed", assertionResults: [{ status: "passed" }, { status: "skipped" }] },
        { name: prefix + "tests/unit/b.test.ts", status: "passed", assertionResults: [{ status: "todo" }] },
        { name: prefix + "tests/unit/c.test.ts", status: "passed", assertionResults: [] },
        { name: prefix + "tests/unit/d.test.ts", status: "skipped", assertionResults: [{ status: "skipped" }] },
      ],
    };
    const r = ok(mapVitestReport(report, { lockedTests: [] }));
    expect(r.passedTests).toEqual([]);
    expect(r.failedTests).toEqual([]);
  });
  it("malformed input is an error, never an empty pass", () => {
    expect(mapVitestReport({}, { lockedTests: [] }).ok).toBe(false);
    expect(mapVitestReport("x", { lockedTests: [] }).ok).toBe(false);
    expect(mapVitestReport({ testResults: [{ status: "passed" }] }, { lockedTests: [] }).ok).toBe(false);
  });
});

describe("mapTreeHashes", () => {
  it("returns blob shas for the requested paths from the real tree fixture", () => {
    const h = ok(mapTreeHashes(loadPrEvidenceFixture("pr912-tree.json"), [T1, T2]));
    expect(h).toEqual({ [T1]: "117317dc53267dadb813528522d069f0022af26a", [T2]: "f59e20b15402c1707fafc9ab6095882e4994ac02" });
  });
  it("a missing path stays missing; a directory is not a blob", () => {
    const h = ok(mapTreeHashes(loadPrEvidenceFixture("pr912-tree.json"), [T1, "tests/unit/nope.test.ts", "src/tools"]));
    expect(Object.keys(h)).toEqual([T1]);
  });
  it("a truncated or malformed listing is an error", () => {
    expect(mapTreeHashes({ sha: "x", truncated: true, tree: [] }, [T1]).ok).toBe(false);
    expect(mapTreeHashes({ nope: 1 }, [T1]).ok).toBe(false);
  });
});

describe("dependencyChanged", () => {
  const f = (path: string) => ({ path, status: "modified" as const, additions: 1, deletions: 0 });
  it("is true when package.json or pnpm-lock.yaml is in the diff, at any depth or as a rename source", () => {
    expect(dependencyChanged([f("src/a.ts"), f("package.json")])).toBe(true);
    expect(dependencyChanged([f("pnpm-lock.yaml")])).toBe(true);
    expect(dependencyChanged([f("video-factory/package.json")])).toBe(true);
    expect(dependencyChanged([{ path: "x.json", status: "renamed" as const, additions: 0, deletions: 0, previousPath: "package.json" }])).toBe(true);
    expect(dependencyChanged([f("src/package.json.ts"), f("docs/package.md")])).toBe(false);
    expect(dependencyChanged([])).toBe(false);
  });
});

describe("end to end: real PR #912 fixtures through verifyImplementationGreen", () => {
  const required = ["Type check + lint + wiring", "Unit + regression tests"];
  const hashes = ok(mapTreeHashes(loadPrEvidenceFixture("pr912-tree.json"), [T1, T2]));
  const diff = ok(mapPrFiles(loadPrEvidenceFixture("pr912-files.json")));
  const checksRaw = ok(parseCheckRuns(loadPrEvidenceFixture("pr912-check-runs.json"), PR912_HEAD));
  const wide = ["docs/**", "scripts/post-deploy-oracle.ts", "src/tools/oracle*.ts"];

  interface Over {
    scope?: string[];
    atSpec?: Record<string, string>;
    noReport?: boolean;
    names?: string[];
    lockedTests?: string[];
    lines?: number;
  }
  function run(over: Over) {
    const lockedTests = over.lockedTests ?? [T1, T2];
    const contract = contractFixture({
      scope: over.scope ?? wide,
      locked_tests: lockedTests,
      limits: { files: 20, lines: over.lines ?? 1000, deleted_lines: 50, new_dependencies: false },
    });
    const testsByCheckId: Record<number, { passedTests: string[]; failedTests: string[] }> = {};
    if (!over.noReport) {
      const tests = ok(mapVitestReport(loadPrEvidenceFixture("pr912-vitest-results.json"), { lockedTests }));
      for (const c of checksRaw) if (c.name === TEST_CHECK_NAME) testsByCheckId[c.id] = tests;
    }
    return verifyImplementationGreen(contract, {
      head_sha: PR912_HEAD,
      checks: mapCheckRuns(checksRaw, { requiredNames: over.names ?? required, testsByCheckId }),
      diff,
      lockedTestHashes: { atSpec: over.atSpec ?? hashes, atHead: hashes },
      dependencyChanged: dependencyChanged(diff),
    });
  }

  it("PASS: green required checks, locked tests ran and are unchanged, diff in scope", () => {
    expect(run({})).toEqual({ status: "PASS", reasons: [], head_sha: PR912_HEAD });
  });
  it("FAIL, with each out-of-scope file named, when the scope is too narrow", () => {
    const v = run({ scope: ["src/tools/oracle.ts"] });
    expect(v.status).toBe("FAIL");
    expect(v.reasons).toEqual(
      expect.arrayContaining([
        "docs/ROADMAP.md is outside the contract scope",
        "docs/study/INTERVIEW-BRIEF.md is outside the contract scope",
        "scripts/post-deploy-oracle.ts is outside the contract scope",
        "src/tools/oracle-http.ts is outside the contract scope",
      ]),
    );
    expect(v.reasons.some((r) => r.startsWith("src/tools/oracle.ts"))).toBe(false);
  });
  it("UNKNOWN when the spec-time hash of a locked test is missing from the tree", () => {
    const atSpec = { [T1]: hashes[T1] as string };
    const v = run({ atSpec });
    expect(v.status).toBe("UNKNOWN");
    expect(v.reasons).toEqual(["no spec-time hash for locked test " + T2 + ": cannot prove it is unchanged"]);
  });
  it("FAIL when a locked test changed after the spec commit", () => {
    const v = run({ atSpec: { ...hashes, [T1]: "0".repeat(40) } });
    expect(v.status).toBe("FAIL");
    expect(v.reasons).toEqual(["locked test " + T1 + " was modified after the spec commit (hash differs)"]);
  });
  it("UNKNOWN when no vitest report was available: green CI that may not have run the locked tests", () => {
    const v = run({ noReport: true });
    expect(v.status).toBe("UNKNOWN");
    expect(v.reasons).toEqual(["cannot tell whether the locked test ran: no required check reports which tests passed"]);
  });
  it("FAIL when green CI never ran a locked test", () => {
    const v = run({ lockedTests: [T1, T2, "tests/unit/tools/never-ran.test.ts"] });
    expect(v.status).toBe("FAIL");
    expect(v.reasons).toContain("locked test tests/unit/tools/never-ran.test.ts did not run in any required check");
  });
  it("UNKNOWN when a required check never reported", () => {
    const v = run({ names: [...required, "Mutation tests"] });
    expect(v.status).toBe("UNKNOWN");
    expect(v.reasons).toEqual(["required check Mutation tests has no usable result (pending)"]);
  });
  it("FAIL when the diff is over the line limit", () => {
    const v = run({ lines: 100 });
    expect(v.status).toBe("FAIL");
    expect(v.reasons[0]).toMatch(/^diff adds \d+ lines, over the limit of 100$/);
  });
});

