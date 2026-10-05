/**
 * Unit tests for the PR evidence engine (src/tools/pr-evidence.ts).
 *
 * Code, not a model, decides whether a PR proves its task. These cases come from real
 * defects: the dispatcher checked "EXISTENCE, not correctness"; "no CI counted as green";
 * pr-brain once wrote GATE PASSED after targeted vitest only. Each adversarial case is an
 * executor trick the engine must catch: edit the locked test, delete a test, touch CI,
 * add a dependency, ship with no required checks, move the head after review.
 */

import { describe, it, expect } from "vitest";
import {
  canMerge,
  globMatch,
  mergeIdempotencyKey,
  verifyImplementationGreen,
  verifySpecRed,
  type CheckRun,
  type DiffFile,
  type EvidenceSpec,
  type EvidenceVerdict,
} from "../../../src/tools/pr-evidence.js";

const LOCKED = "tests/unit/tools/widget.test.ts";
const LIST = [LOCKED];
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const HEAD2 = "c".repeat(40);

/** Shallow merge helper (keeps call sites short). */
const mix = <T extends object>(a: T, b: object): T => Object.assign({}, a, b) as T;

const spec: EvidenceSpec = {
  locked_tests: LIST,
  scope: ["src/tools/widget.ts", "src/core/**/*.ts"],
  limits: { files: 5, lines: 100, deleted_lines: 20, new_dependencies: false },
  base_sha: BASE,
  spec_commit: "d".repeat(40),
};

const check = (over: Partial<CheckRun> = {}): CheckRun =>
  mix<CheckRun>({ name: "ci / test", required: true, conclusion: "success" }, over);
const file = (path: string, over: Partial<DiffFile> = {}): DiffFile =>
  mix<DiffFile>({ path, status: "modified", additions: 5, deletions: 1 }, over);
const hs = (atSpec: string, atHead: string) => ({
  atSpec: Object.fromEntries([[LOCKED, atSpec]]),
  atHead: Object.fromEntries([[LOCKED, atHead]]),
});

const green = (over: Record<string, unknown> = {}): EvidenceVerdict =>
  verifyImplementationGreen(
    spec,
    mix(
      {
        checks: [check()],
        diff: [file("src/tools/widget.ts"), file(LOCKED, { status: "added" })],
        lockedTestHashes: hs("h1", "h1"),
        dependencyChanged: false,
      },
      over,
    ) as Parameters<typeof verifyImplementationGreen>[1],
  );

const red = (over: Record<string, unknown> = {}): EvidenceVerdict =>
  verifySpecRed(
    spec,
    mix(
      {
        checks: [check({ conclusion: "failure", failedTests: LIST }), check({ name: "ci / lint" })],
        specCommitFiles: [file(LOCKED, { status: "added" })],
      },
      over,
    ) as Parameters<typeof verifySpecRed>[1],
  );

const reasonsOf = (v: EvidenceVerdict) => v.reasons.join(" | ");

describe("verifySpecRed", () => {
  it("PASSes when only the locked test was added and only it fails", () => {
    expect(red()).toEqual({ status: "PASS", reasons: [] });
  });

  it("FAILs when the spec commit also touches a source file", () => {
    const v = red({ specCommitFiles: [file(LOCKED, { status: "added" }), file("src/tools/widget.ts")] });
    expect(v.status).toBe("FAIL");
    expect(reasonsOf(v)).toContain("src/tools/widget.ts");
  });

  it("FAILs when the spec commit touches a test that is not locked", () => {
    const v = red({ specCommitFiles: [file(LOCKED, { status: "added" }), file("tests/unit/other.test.ts")] });
    expect(v.status).toBe("FAIL");
  });

  it("FAILs when the spec commit deletes a file", () => {
    const v = red({ specCommitFiles: [file(LOCKED, { status: "removed" })] });
    expect(v.status).toBe("FAIL");
  });

  it("FAILs when a NON-locked test fails at spec time", () => {
    const failing = [LOCKED, "tests/unit/unrelated.test.ts"];
    const v = red({ checks: [check({ conclusion: "failure", failedTests: failing })] });
    expect(v.status).toBe("FAIL");
    expect(reasonsOf(v)).toContain("tests/unit/unrelated.test.ts");
  });

  it("FAILs when a second required check fails for a non-test reason", () => {
    const v = red({
      checks: [
        check({ conclusion: "failure", failedTests: LIST }),
        check({ name: "ci / lint", conclusion: "failure", failedTests: [] }),
      ],
    });
    expect(v.status).toBe("FAIL");
    expect(reasonsOf(v)).toContain("ci / lint");
  });

  it("FAILs when every required check is green (the locked test proves nothing)", () => {
    const v = red({ checks: [check()] });
    expect(v.status).toBe("FAIL");
    expect(reasonsOf(v)).toMatch(/no required check failed/i);
  });

  it("is UNKNOWN when a failed required check does not say which tests failed", () => {
    const v = red({ checks: [check({ conclusion: "failure" })] });
    expect(v.status).toBe("UNKNOWN");
    expect(reasonsOf(v)).toContain("cannot tell which tests failed");
  });

  it("is UNKNOWN, never PASS, with no required checks", () => {
    expect(red({ checks: [] }).status).toBe("UNKNOWN");
    const notRequired = check({ required: false, conclusion: "failure", failedTests: LIST });
    const v = red({ checks: [notRequired] });
    expect(v.status).toBe("UNKNOWN");
    expect(reasonsOf(v)).toMatch(/no required checks/i);
  });

  it("is UNKNOWN while a required check is still pending", () => {
    const failed = check({ conclusion: "failure", failedTests: LIST });
    const v = red({ checks: [failed, check({ conclusion: null })] });
    expect(v.status).toBe("UNKNOWN");
  });

  it("lets FAIL outrank UNKNOWN", () => {
    const v = red({
      specCommitFiles: [file("src/tools/widget.ts")],
      checks: [check({ conclusion: "failure" })],
    });
    expect(v.status).toBe("FAIL");
  });

  it("is UNKNOWN for a contract with no locked tests", () => {
    const noLocked = mix(spec, { locked_tests: [] });
    const v = verifySpecRed(noLocked, { checks: [check()], specCommitFiles: [] });
    expect(v.status).toBe("UNKNOWN");
  });

  it("ignores failures on checks that are not required", () => {
    const other = check({ name: "ui-qa", required: false, conclusion: "failure", failedTests: ["x.test.ts"] });
    const v = red({
      checks: [check({ conclusion: "failure", failedTests: LIST }), other],
    });
    expect(v.status).toBe("PASS");
  });
});

describe("verifyImplementationGreen", () => {
  it("PASSes a clean in-scope change with green required checks and an untouched locked test", () => {
    expect(green()).toEqual({ status: "PASS", reasons: [] });
  });

  it("FAILs when the executor edited the locked test (hash differs)", () => {
    const v = green({ lockedTestHashes: hs("h1", "h2") });
    expect(v.status).toBe("FAIL");
    expect(reasonsOf(v)).toContain(LOCKED);
  });

  it("is UNKNOWN when a locked test hash is missing at head or at spec", () => {
    const noHead = { atSpec: hs("h1", "h1").atSpec, atHead: {} };
    const noSpec = { atSpec: {}, atHead: hs("h1", "h1").atHead };
    expect(green({ lockedTestHashes: noHead }).status).toBe("UNKNOWN");
    expect(green({ lockedTestHashes: noSpec }).status).toBe("UNKNOWN");
  });

  it("FAILs when the executor deletes a test file", () => {
    const removed = file("tests/unit/old.test.ts", { status: "removed", additions: 0, deletions: 4 });
    const v = green({ diff: [file("src/tools/widget.ts"), removed] });
    expect(v.status).toBe("FAIL");
    expect(reasonsOf(v)).toContain("tests/unit/old.test.ts");
  });

  it("FAILs when a test file is renamed away", () => {
    const moved = file("src/tools/renamed.ts", { status: "renamed", previousPath: "tests/unit/old.test.ts" });
    const v = green({ diff: [file("src/tools/widget.ts"), moved] });
    expect(v.status).toBe("FAIL");
  });

  it.each([
    ".github/workflows/ci.yml",
    "vitest.config.ts",
    "tsconfig.json",
    "tsconfig.test.json",
    "eslint.config.js",
    "package.json",
    "pnpm-lock.yaml",
    "scripts/verify-architecture.ts",
  ])("FAILs when the executor edits %s", (path) => {
    const v = green({ diff: [file("src/tools/widget.ts"), file(path)] });
    expect(v.status).toBe("FAIL");
    expect(reasonsOf(v)).toContain(path);
  });

  it("FAILs when a protected file is hidden behind a rename", () => {
    const moved = file("src/core/x.ts", { status: "renamed", previousPath: ".github/workflows/ci.yml" });
    expect(green({ diff: [moved] }).status).toBe("FAIL");
  });

  it("FAILs when a dependency was added", () => {
    const v = green({ dependencyChanged: true });
    expect(v.status).toBe("FAIL");
    expect(reasonsOf(v)).toMatch(/dependenc/i);
  });

  it("is UNKNOWN, never PASS, with no required checks", () => {
    expect(green({ checks: [] }).status).toBe("UNKNOWN");
    expect(green({ checks: [check({ required: false })] }).status).toBe("UNKNOWN");
  });

  it("is UNKNOWN for pending, skipped, cancelled, neutral or action_required required checks", () => {
    for (const conclusion of [null, "skipped", "cancelled", "neutral", "action_required"] as const) {
      const v = green({ checks: [check({ conclusion })] });
      expect(v.status, String(conclusion)).toBe("UNKNOWN");
    }
  });

  it("FAILs a failed or timed-out required check", () => {
    for (const conclusion of ["failure", "timed_out"] as const) {
      expect(green({ checks: [check({ conclusion })] }).status).toBe("FAIL");
    }
  });

  it("ignores a failing check that is not required", () => {
    const flaky = check({ name: "ui-qa", required: false, conclusion: "failure" });
    expect(green({ checks: [check(), flaky] }).status).toBe("PASS");
  });

  it("FAILs a non-test file outside scope, and exempts test files from scope", () => {
    expect(green({ diff: [file("src/gateway/telegram.ts")] }).status).toBe("FAIL");
    const newTest = file("tests/unit/new-case.test.ts", { status: "added" });
    expect(green({ diff: [file("src/tools/widget.ts"), newTest] }).status).toBe("PASS");
  });

  it("FAILs when limits are exceeded, and PASSes exactly at the limit", () => {
    const many = Array.from({ length: 6 }, (_, i) => file("src/core/f" + i + ".ts", { additions: 1, deletions: 0 }));
    const w = (a: number, d: number) => { diff: [file("src/tools/widget.ts", { additions: a, deletions: d })] };
    expect(green({ diff: many }).status).toBe("FAIL");
    expect(green({ diff: many.slice(0, 5) }).status).toBe("PASS");
    expect(green(w(101, 0)).status).toBe("FAIL");
    expect(green(w(100, 0)).status).toBe("PASS");
    expect(green(w(1, 21)).status).toBe("FAIL");
    expect(green(w(1, 20)).status).toBe("PASS");
  });

  it("FAILs a path that escapes the repo", () => {
    const up = String.fromCharCode(46, 46);
    const sneaky = ["src", "core", up, up, "etc", "passwd"].join("/");
    expect(green({ diff: [file(sneaky)] }).status).toBe("FAIL");
  });

  it("is UNKNOWN on malformed input instead of throwing", () => {
    expect(green({ checks: "nope" }).status).toBe("UNKNOWN");
    const negative = file("src/tools/widget.ts", { additions: -1 });
    expect(green({ diff: [negative] }).status).toBe("UNKNOWN");
  });
});

describe("canMerge", () => {
  const pass: EvidenceVerdict = { status: "PASS", reasons: [] };
  const base = {
    evidence: pass,
    review: { decision: "APPROVE" as const, head_sha: HEAD },
    headAtReview: HEAD,
    headNow: HEAD,
    baseAtReview: BASE,
    baseNow: BASE,
  };
  const approve = (sha: string) => ({ decision: "APPROVE" as const, head_sha: sha });

  it("allows PASS evidence with APPROVE for the same, unmoved head and base", () => {
    expect(canMerge(base)).toEqual({ ok: true, reasons: [] });
  });

  it("refuses when the head moved after review", () => {
    const r = canMerge(mix(base, { headNow: HEAD2 }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/head/i);
  });

  it("refuses an APPROVE issued for an older head", () => {
    const r = canMerge(mix(base, { review: approve(HEAD2) }));
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("refuses when the base moved", () => {
    expect(canMerge(mix(base, { baseNow: "e".repeat(40) })).ok).toBe(false);
  });

  it("refuses REQUEST_CHANGES and UNKNOWN reviews", () => {
    for (const decision of ["REQUEST_CHANGES", "UNKNOWN"] as const) {
      const r = canMerge(mix(base, { review: { decision, head_sha: HEAD } }));
      expect(r.ok).toBe(false);
      expect(r.reasons.length).toBeGreaterThan(0);
    }
  });

  it("refuses FAIL and UNKNOWN evidence, each with a reason", () => {
    for (const status of ["FAIL", "UNKNOWN"] as const) {
      const r = canMerge(mix(base, { evidence: { status, reasons: ["x"] } }));
      expect(r.ok).toBe(false);
      expect(r.reasons.length).toBeGreaterThan(0);
    }
  });

  it("refuses PASS evidence that smuggles in a status string it should not trust", () => {
    const r = canMerge(mix(base, { evidence: { status: "pass", reasons: [] } }));
    expect(r.ok).toBe(false);
  });

  it("refuses empty shas and malformed input", () => {
    const blank = mix(base, { headNow: "", headAtReview: "", review: approve("") });
    expect(canMerge(blank).ok).toBe(false);
    expect(canMerge(mix(base, { evidence: undefined })).ok).toBe(false);
  });
});

describe("mergeIdempotencyKey", () => {
  it("is merge:<repo>#<pr>@<head>", () => {
    expect(mergeIdempotencyKey("o/r", 42, HEAD)).toBe("merge:o/r#42@" + HEAD);
  });
  it("throws on an unusable pr or head rather than minting a shared key", () => {
    expect(() => mergeIdempotencyKey("o/r", 0, HEAD)).toThrow();
    expect(() => mergeIdempotencyKey("o/r", 1, "")).toThrow();
    expect(() => mergeIdempotencyKey("", 1, HEAD)).toThrow();
  });
});

describe("invariant: UNKNOWN never becomes PASS, every non-PASS says why", () => {
  const conclusions = ["success", "failure", "skipped", "cancelled", "neutral", "timed_out", "action_required", null] as const;
  const verdicts: EvidenceVerdict[] = [];
  for (const conclusion of conclusions) {
    for (const required of [true, false]) {
      for (const failedTests of [undefined, [], LIST, ["other.test.ts"]]) {
        const checks = [check({ conclusion, required, failedTests })];
        verdicts.push(green({ checks }), red({ checks }));
      }
    }
  }
  verdicts.push(green({ checks: [] }), red({ checks: [] }), green({ dependencyChanged: true }));

  it("keeps reasons non-empty for every non-PASS verdict and empty for PASS", () => {
    expect(verdicts.length).toBeGreaterThan(50);
    for (const v of verdicts) {
      if (v.status === "PASS") expect(v.reasons).toEqual([]);
      else expect(v.reasons.length).toBeGreaterThan(0);
    }
  });

  it("never lets canMerge pass on non-PASS evidence", () => {
    for (const v of verdicts) {
      const r = canMerge({
        evidence: v,
        review: { decision: "APPROVE", head_sha: HEAD },
        headAtReview: HEAD,
        headNow: HEAD,
        baseAtReview: BASE,
        baseNow: BASE,
      });
      expect(r.ok).toBe(v.status === "PASS");
      if (!r.ok) expect(r.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe("globMatch", () => {
  it.each([
    ["src/tools/widget.ts", "src/tools/widget.ts", true],
    ["src/tools/*.ts", "src/tools/widget.ts", true],
    ["src/tools/*.ts", "src/tools/deep/widget.ts", false],
    ["src/**/*.ts", "src/tools/deep/widget.ts", true],
    ["src/**/*.ts", "src/widget.ts", true],
    ["src/**", "src/a/b/c.md", true],
    ["src/tools/", "src/tools/a/b.ts", true],
    ["src/tools/w?dget.ts", "src/tools/widget.ts", true],
    ["src/*.{ts,tsx}", "src/a.tsx", true],
    ["src/*.{ts,tsx}", "src/a.js", false],
    ["src/tools/widget.ts", "src/tools/widget.tsx", false],
    ["src/a.b", "src/aXb", false],
  ])("%s vs %s -> %s", (glob, path, expected) => {
    expect(globMatch(glob, path)).toBe(expected);
  });
});
