/**
 * scripts/eval-reviewer.ts: does the PR reviewer catch known defects?
 *
 * The reviewer (pr-brain) was never tested against defects we knew about: on PR #861 it cleared
 * three real bugs, on PR #797 it cleared an invented command. This scores a reviewer's output per
 * fixture. The scorer is pure and driven here with scripted outputs; no model is called.
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import {
  buildReviewerPrompt,
  caseHead,
  EvalCaseSchema,
  loadCases,
  parseArgs,
  renderTable,
  runEval,
  scoreCase,
  scriptedRunner,
  type EvalCase,
} from "../../../scripts/eval-reviewer.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/reviewer-eval", import.meta.url));

const CASE: EvalCase = {
  id: "unit-case",
  source: "planted",
  context: "Task: x",
  diff: "diff --git a/src/a.ts b/src/a.ts\n+curl -s url\n",
  planted_defects: [
    { file: "src/a.ts", line: 2, description: "curl -s hides a 4xx", keyword: "4xx|curl" },
    { file: "src/b.ts", description: "second defect", keyword: "secret" },
  ],
};

function output(head: string, decision: string, findings: unknown[]): string {
  return "Review done.\n```json\n" + JSON.stringify({ version: 1, head_sha: head, decision, findings }) + "\n```\n";
}
const finding = (file: string | undefined, claim: string, evidence = "seen in diff", severity = "blocker") => ({
  severity,
  ...(file ? { file } : {}),
  claim,
  evidence,
});

describe("scoreCase", () => {
  const head = caseHead(CASE.id);

  it("counts a defect as caught: REQUEST_CHANGES, file matches, keyword in claim", () => {
    const s = scoreCase(CASE, output(head, "REQUEST_CHANGES", [finding("src/a.ts", "uses CURL without -f")]));
    expect(s.defects[0]).toMatchObject({ caught: true, mentioned: true });
    expect(s.defects[1]).toMatchObject({ caught: false });
    expect(s.caught).toBe(1);
    expect(s.total).toBe(2);
  });

  it("matches the keyword in evidence too, case-insensitively, and tolerates a ./ or b/ path prefix", () => {
    const s = scoreCase(CASE, output(head, "REQUEST_CHANGES", [finding("b/src/a.ts", "send is unchecked", "curl -s returns 0 on a 4XX")]));
    expect(s.defects[0]?.caught).toBe(true);
  });

  it("misses when the keyword is absent", () => {
    const s = scoreCase(CASE, output(head, "REQUEST_CHANGES", [finding("src/a.ts", "style nit", "naming")]));
    expect(s.caught).toBe(0);
  });

  it("misses when the finding names a different file", () => {
    const s = scoreCase(CASE, output(head, "REQUEST_CHANGES", [finding("src/other.ts", "curl without -f")]));
    expect(s.defects[0]?.caught).toBe(false);
  });

  it("misses when the finding names no file", () => {
    const s = scoreCase(CASE, output(head, "REQUEST_CHANGES", [finding(undefined, "curl without -f")]));
    expect(s.defects[0]?.caught).toBe(false);
  });

  it("a finding under APPROVE is mentioned but does not block the merge, so it is not caught", () => {
    const s = scoreCase(CASE, output(head, "APPROVE", [finding("src/a.ts", "curl without -f", "x", "major")]));
    expect(s.defects[0]).toMatchObject({ mentioned: true, caught: false });
  });

  it("APPROVE carrying a blocker is coerced to REQUEST_CHANGES and counts as caught", () => {
    const s = scoreCase(CASE, output(head, "APPROVE", [finding("src/a.ts", "curl without -f")]));
    expect(s.decision).toBe("REQUEST_CHANGES");
    expect(s.defects[0]?.caught).toBe(true);
  });

  it("unparseable output counts as missed", () => {
    const s = scoreCase(CASE, "GATE PASSED. Nothing to fix.");
    expect(s.decision).toBe("UNKNOWN");
    expect(s.parsed).toBe(false);
    expect(s.caught).toBe(0);
  });

  it("a verdict for another head counts as missed", () => {
    const s = scoreCase(CASE, output("f".repeat(40), "REQUEST_CHANGES", [finding("src/a.ts", "curl without -f")]));
    expect(s.decision).toBe("UNKNOWN");
    expect(s.caught).toBe(0);
  });

  it("counts findings that match no defect as extra", () => {
    const s = scoreCase(CASE, output(head, "REQUEST_CHANGES", [finding("src/a.ts", "curl without -f"), finding("src/z.ts", "unrelated")]));
    expect(s.extraFindings).toBe(1);
  });
});

describe("prompt", () => {
  it("carries the diff, context, head and the verdict instructions, and never the answer key", () => {
    const p = buildReviewerPrompt(CASE);
    expect(p).toContain(CASE.diff);
    expect(p).toContain("Task: x");
    expect(p).toContain(caseHead(CASE.id));
    expect(p).toContain("head_sha");
    expect(p).not.toContain("second defect");
    expect(p).not.toContain("planted");
  });

  it("inlines an optional protocol text", () => {
    expect(buildReviewerPrompt(CASE, "PROTOCOL-TEXT")).toContain("PROTOCOL-TEXT");
  });
});

describe("runEval", () => {
  it("scores every case with the injected runner and aggregates the catch rate", async () => {
    const other: EvalCase = { ...CASE, id: "other", planted_defects: [CASE.planted_defects[0]!] };
    const calls: string[] = [];
    const report = await runEval([CASE, other], async (prompt) => {
      calls.push(prompt);
      return prompt.includes(caseHead("other"))
        ? output(caseHead("other"), "REQUEST_CHANGES", [finding("src/a.ts", "curl")])
        : "no json";
    });
    expect(calls).toHaveLength(2);
    expect(report.totalDefects).toBe(3);
    expect(report.caughtDefects).toBe(1);
    expect(report.catchRate).toBeCloseTo(1 / 3);
    const table = renderTable(report);
    expect(table).toContain("unit-case");
    expect(table).toContain("other");
    expect(table).toMatch(/1\/3/);
  });

  it("a runner that throws is a miss for that case, not a crash", async () => {
    const report = await runEval([CASE], async () => {
      throw new Error("model down");
    });
    expect(report.cases[0]?.caught).toBe(0);
    expect(report.cases[0]?.error).toContain("model down");
  });
});

const CLEAN: EvalCase = {
  id: "clean-case",
  source: "historical",
  expect: "APPROVE",
  diff: "diff --git a/src/a.ts b/src/a.ts\n+export const ok = 1;\n",
  planted_defects: [],
};

describe("clean cases (false-block measurement)", () => {
  const head = caseHead(CLEAN.id);

  it("schema: no defects is allowed only with expect APPROVE", () => {
    expect(EvalCaseSchema.safeParse(CLEAN).success).toBe(true);
    expect(EvalCaseSchema.safeParse({ ...CLEAN, expect: undefined }).success).toBe(false);
    expect(EvalCaseSchema.safeParse({ ...CASE, expect: "APPROVE" }).success).toBe(false);
  });

  it("passes only on APPROVE", () => {
    const ok = scoreCase(CLEAN, output(head, "APPROVE", []));
    expect(ok).toMatchObject({ clean: true, falseBlock: false, total: 0 });
  });

  it("REQUEST_CHANGES on a clean case is a false block, even with findings", () => {
    const s = scoreCase(CLEAN, output(head, "REQUEST_CHANGES", [finding("src/a.ts", "looks wrong")]));
    expect(s).toMatchObject({ clean: true, falseBlock: true });
  });

  it("UNKNOWN (no verdict, wrong head, thrown runner) is a false block", async () => {
    expect(scoreCase(CLEAN, "no json").falseBlock).toBe(true);
    expect(scoreCase(CLEAN, output("0".repeat(40), "APPROVE", [])).falseBlock).toBe(true);
    const report = await runEval([CLEAN], async () => {
      throw new Error("model down");
    });
    expect(report.cases[0]).toMatchObject({ falseBlock: true, error: expect.stringContaining("model down") });
  });

  it("a defect case is never counted as a false block", () => {
    expect(scoreCase(CASE, output(caseHead(CASE.id), "REQUEST_CHANGES", [])).falseBlock).toBe(false);
  });

  it("the report counts false blocks apart from the catch rate and prints them under it", async () => {
    const report = await runEval([CASE, CLEAN], async (prompt) =>
      prompt.includes(head) ? output(head, "REQUEST_CHANGES", []) : output(caseHead(CASE.id), "APPROVE", []),
    );
    expect(report).toMatchObject({ cleanCases: 1, falseBlocks: 1, totalDefects: 2 });
    const lines = renderTable(report).split("\n");
    const rate = lines.findIndex((l) => l.startsWith("Catch rate:"));
    expect(lines[rate + 1]).toBe("False blocks: 1/1");
  });
});

describe("fixtures", () => {
  const cases = loadCases(FIXTURES);
  const clean = cases.filter((c) => c.expect === "APPROVE");

  it("has two clean cases from real merged PRs with no follow-up fix", () => {
    expect(clean.length).toBeGreaterThanOrEqual(2);
    for (const c of clean) {
      expect(c.source, c.id).toBe("historical");
      expect(c.pr, c.id).toBeGreaterThan(0);
      expect(c.planted_defects, c.id).toEqual([]);
    }
  });

  it("an always-REQUEST_CHANGES reviewer that dumps every keyword scores 100% catch but 2/2 false blocks", async () => {
    const defects = cases.flatMap((c) => c.planted_defects);
    const report = await runEval(cases, async (prompt) => {
      const c = cases.find((x) => prompt.includes(caseHead(x.id)))!;
      const findings = defects.map((d) => ({
        severity: "blocker",
        file: d.file.split("|")[0],
        claim: `problem in ${d.file}`,
        evidence: d.keyword.split("|").join(" "),
      }));
      return output(caseHead(c.id), "REQUEST_CHANGES", findings);
    });
    expect(report.catchRate).toBe(1);
    expect(report.cleanCases).toBe(2);
    expect(report.falseBlocks).toBe(2);
    expect(renderTable(report)).toContain("False blocks: 2/2");
  });

  it("the dry run answers clean cases with APPROVE: zero false blocks", async () => {
    const report = await runEval(cases, scriptedRunner(cases));
    expect(report.falseBlocks).toBe(0);
    for (const c of report.cases.filter((x) => x.clean)) expect(c.decision, c.id).toBe("APPROVE");
  });

  it("has about ten defect cases, historical and planted, with unique ids", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(cases.filter((c) => c.source === "historical").length).toBeGreaterThanOrEqual(4);
    expect(cases.filter((c) => c.source === "planted").length).toBeGreaterThanOrEqual(6);
  });

  it("covers the named historical defects", () => {
    const ids = cases.map((c) => c.id).join(" ");
    expect(cases.filter((c) => c.pr === 861)).toHaveLength(3);
    expect(cases.some((c) => c.pr === 797 && c.planted_defects.some((d) => /agy auth login/.test(d.keyword)))).toBe(true);
    expect(ids).toMatch(/pr861/);
  });

  it("every defect names a file that is in the diff", () => {
    for (const c of cases) {
      for (const d of c.planted_defects) {
        const files = d.file.split("|");
        expect(files.some((f) => c.diff.includes(f)), `${c.id}: ${d.file}`).toBe(true);
      }
    }
  });

  it("the diff is small enough to read in one prompt", () => {
    for (const c of cases) expect(c.diff.split("\n").length, c.id).toBeLessThan(c.expect === "APPROVE" ? 200 : 131);
  });

  it("dry run with the scripted runner catches every defect (wiring check, not a model measurement)", async () => {
    const report = await runEval(cases, scriptedRunner(cases));
    expect(report.caughtDefects).toBe(report.totalDefects);
    expect(report.cases.every((c) => c.parsed)).toBe(true);
  });

  it("a runner that always approves catches nothing", async () => {
    const report = await runEval(cases, async (prompt) => {
      const c = cases.find((x) => prompt.includes(caseHead(x.id)))!;
      return output(caseHead(c.id), "APPROVE", []);
    });
    expect(report.caughtDefects).toBe(0);
  });
});

describe("parseArgs", () => {
  it("defaults to dry run", () => {
    expect(parseArgs([])).toMatchObject({ mode: "dry-run" });
  });
  it("live needs the explicit flag and a command", () => {
    expect(parseArgs(["--live", "--cmd", "claude -p"])).toMatchObject({ mode: "live", cmd: "claude -p" });
    expect(() => parseArgs(["--live"])).toThrow(/--cmd/);
  });
  it("rejects --live together with --dry-run", () => {
    expect(() => parseArgs(["--live", "--dry-run", "--cmd", "x"])).toThrow(/both/);
  });
  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown/);
  });
});
