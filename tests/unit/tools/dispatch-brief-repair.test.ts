/**
 * A brief that cites a file that is not there is repaired, not refused — src/tools/dispatch-brief-repair.ts.
 * ========================================================================================================
 * On 2026-10-02 four plain-English /task requests died at the brief lint, because the planner (which has never
 * seen the repository) invents paths: `src/agent/pr-brain.ts`, `scripts/pr-brain.ts` for a file that is really
 * `deploy/vps-daemons/pr-brain`. The property that matters is the one the founder feels: a request that names
 * no file, or names the wrong one, still becomes a filed brief, and the executor is told which paths are guesses.
 *
 * The strongest check is the last describe: the repaired body, fed back through the REAL lint with a lookup that
 * says every demoted path is missing, passes. If the demotion left one path-shaped token the lint reads, the
 * repair would loop back into a rejection.
 */

import { describe, it, expect } from "vitest";
import {
  demoteMissingPaths,
  evidenceFromFounderRequest,
  prepareDispatchBrief,
  SCOPE_UNKNOWN,
  withFounderRequestBrief,
  withFounderRequestEvidence,
  withFounderRequestProblem,
} from "../../../src/tools/dispatch-brief-repair.js";
import { formatAntigravityIssueBody, type AntigravityTaskInput } from "../../../src/tools/dispatch-antigravity.js";
import { lintAgentBrief, type BriefLintResult } from "../../../src/tools/agent-brief-lint.js";

const BASE: AntigravityTaskInput = {
  title: "feat: pr-brain runs on agy",
  goal: "Make the pr-brain script run its reviewer through agy.",
  problem: "pr-brain only knows the claude CLI.",
  evidence: "The founder's request of 2026-10-02.",
  scope: "the pr-brain script",
  expected: "pr-brain reviews with agy.",
  verification: "pnpm test",
};

const EXISTS = new Set(["src/tools/index.ts", "deploy/vps-daemons/pr-brain"]);
const fileExists = (path: string): boolean => EXISTS.has(path);
const lint = (body: string): Promise<BriefLintResult> => lintAgentBrief(body, fileExists);
const deps = { lint, format: formatAntigravityIssueBody };

describe("demoteMissingPaths", () => {
  it("replaces each occurrence in the scope with a numbered placeholder and lists the paths in a fenced block", () => {
    const { input, demoted } = demoteMissingPaths(
      { ...BASE, scope: "Edit src/agent/pr-brain.ts and scripts/pr-brain.ts, then src/agent/pr-brain.ts again." },
      ["src/agent/pr-brain.ts", "scripts/pr-brain.ts"],
    );

    expect(demoted).toEqual(["src/agent/pr-brain.ts", "scripts/pr-brain.ts"]);
    expect(input.scope.split("\n\n")[0]).toBe("Edit [unverified path 1] and [unverified path 2], then [unverified path 1] again.");
    expect(input.scope).toContain("```text\n1. src/agent/pr-brain.ts\n2. scripts/pr-brain.ts\n```");
    expect(input.scope).toContain("They are guesses, not facts");
    expect(input.scope).toContain("stop and say so on the issue");
  });

  it("keeps a path that exists exactly as it was: only the reported paths are demoted", () => {
    const { input } = demoteMissingPaths({ ...BASE, scope: "src/tools/index.ts and src/gone.ts" }, ["src/gone.ts"]);

    expect(input.scope.split("\n\n")[0]).toBe("src/tools/index.ts and [unverified path 1]");
  });

  it("handles every way the lint reads a token: ./ prefix, line references, trailing punctuation, backticks", () => {
    const { input } = demoteMissingPaths(
      { ...BASE, scope: "see ./src/gone.ts, `src/gone.ts:42`, src/gone.ts#L7-L9 (and src/gone.ts)." },
      ["src/gone.ts"],
    );

    expect(input.scope.split("\n\n")[0]).toBe("see [unverified path 1], `[unverified path 1]`, [unverified path 1] (and [unverified path 1]).");
  });

  it("does not touch a longer path that merely contains the missing one", () => {
    const { input } = demoteMissingPaths({ ...BASE, scope: "src/gone.ts and src/gone.ts.bak and old/src/gone.ts and src/gone.tsx" }, ["src/gone.ts"]);

    expect(input.scope.split("\n\n")[0]).toBe("[unverified path 1] and src/gone.ts.bak and old/src/gone.ts and src/gone.tsx");
  });

  it("in every other field a backticked path loses its backticks and says (unverified), because that is the only form the lint reads there", () => {
    const { input } = demoteMissingPaths(
      {
        ...BASE,
        goal: "Fix `src/gone.ts` and also `src/tools/index.ts`.",
        expected: "`src/gone.ts:12` returns early. Run `pnpm test src/gone.test.ts`.",
        evidence: "Seen in `src/gone.ts#L3`.",
        verification: "pnpm test",
      },
      ["src/gone.ts"],
    );

    expect(input.goal).toBe("Fix src/gone.ts (unverified) and also `src/tools/index.ts`.");
    expect(input.expected).toBe("src/gone.ts:12 (unverified) returns early. Run `pnpm test src/gone.test.ts`.");
    expect(input.evidence).toBe("Seen in src/gone.ts#L3 (unverified).");
  });

  it("returns the input untouched when there is nothing to demote", () => {
    const result = demoteMissingPaths(BASE, []);

    expect(result.input).toBe(BASE);
    expect(result.demoted).toEqual([]);
  });

  it("never lets a scope that was nothing but invented paths end up empty: the hint block is content", () => {
    const { input } = demoteMissingPaths({ ...BASE, scope: "src/agent/pr-brain.ts" }, ["src/agent/pr-brain.ts"]);

    expect(input.scope.startsWith("[unverified path 1]")).toBe(true);
    expect(input.scope.trim().length).toBeGreaterThan(200);
  });

  it("does not mutate its input", () => {
    const original = { ...BASE, scope: "src/gone.ts" };
    const snapshot = JSON.stringify(original);
    demoteMissingPaths(original, ["src/gone.ts"]);

    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe("the founder's request as evidence", () => {
  it("quotes it verbatim, line by line, and says nothing else came with it", () => {
    const text = evidenceFromFounderRequest("  add a footer\nwith the version  ");

    expect(text).toBe(
      "The founder's request, verbatim:\n\n> add a footer\n> with the version\n\n" +
        "Nothing else came with it: no log line, error text or reference. Antigravity establishes the current behavior " +
        "itself, by reading the code and running it, and records what it found in the PR description.",
    );
  });

  it("fills an EMPTY evidence only", () => {
    expect(withFounderRequestEvidence({ ...BASE, evidence: "" }, "do it").evidence).toContain("> do it");
    expect(withFounderRequestEvidence({ ...BASE, evidence: undefined }, "do it").evidence).toContain("> do it");
    expect(withFounderRequestEvidence({ ...BASE, evidence: "   " }, "do it").evidence).toContain("> do it");
    expect(withFounderRequestEvidence({ ...BASE, evidence: "a real log line" }, "do it").evidence).toBe("a real log line");
  });

  it("does nothing without a request", () => {
    const input = { ...BASE, evidence: "" };

    expect(withFounderRequestEvidence(input, undefined)).toBe(input);
    expect(withFounderRequestEvidence(input, null)).toBe(input);
    expect(withFounderRequestEvidence(input, "   ")).toBe(input);
  });
});

describe("the founder's request as the problem", () => {
  // 2026-10-03: the planner left `problem` out on ~5 of 8 first dispatch calls; the lint rejected each and the
  // model spent a turn re-calling. The founder's own words are what he described, so they fill an empty Problem.
  it("fills an EMPTY problem with the quoted request", () => {
    for (const empty of ["", "  ", undefined]) {
      const filled = withFounderRequestProblem({ ...BASE, problem: empty }, "the footer is missing the version");
      expect(filled.problem).toContain("> the footer is missing the version");
      expect(filled.problem).toContain("The founder described it as");
    }
  });

  it("keeps a problem the caller wrote, and does nothing without a request", () => {
    expect(withFounderRequestProblem({ ...BASE, problem: "real error text" }, "do it").problem).toBe("real error text");
    const input = { ...BASE, problem: "" };
    expect(withFounderRequestProblem(input, undefined)).toBe(input);
    expect(withFounderRequestProblem(input, "  ")).toBe(input);
  });

  it("a brief with no problem passes the lint once the request is supplied (no re-call needed)", async () => {
    const prepared = await prepareDispatchBrief({ ...BASE, problem: undefined, evidence: undefined }, "add the version to the footer", deps);

    expect(prepared.ok).toBe(true);
  });
});

describe("prepareDispatchBrief", () => {
  it("passes a complete brief through untouched", async () => {
    const prepared = await prepareDispatchBrief({ ...BASE, scope: "src/tools/index.ts" }, undefined, deps);

    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.demoted).toEqual([]);
      expect(prepared.input.scope).toBe("src/tools/index.ts");
      expect(prepared.warnings).toEqual([]);
    }
  });

  it("2026-10-02: the invented paths for 'change the pr-brain script' no longer kill the request", async () => {
    const prepared = await prepareDispatchBrief(
      { ...BASE, scope: "src/agent/pr-brain.ts, src/agent/antigravity-runner.ts, scripts/pr-brain.ts", evidence: "" },
      "change the pr-brain script responsible for cli tool like agy running to change to claude code",
      deps,
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.demoted).toEqual(["src/agent/pr-brain.ts", "src/agent/antigravity-runner.ts", "scripts/pr-brain.ts"]);
    expect(prepared.body).toContain("> change the pr-brain script responsible for cli tool like agy running to change to claude code");
    expect(prepared.warnings[0]).toBe(
      "Not found in the repository, so filed as unverified hints, not facts: src/agent/pr-brain.ts, src/agent/antigravity-runner.ts, scripts/pr-brain.ts. " +
        "Antigravity locates the real files itself.",
    );
  });

  it("a path that exists survives the repair as a verified fact", async () => {
    const prepared = await prepareDispatchBrief({ ...BASE, scope: "src/tools/index.ts, src/gone.ts" }, undefined, deps);

    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.demoted).toEqual(["src/gone.ts"]);
      expect(prepared.body).toContain("src/tools/index.ts, [unverified path 1]");
    }
  });

  it("an empty section is still rejected: only the author (or the founder) can supply it", async () => {
    const prepared = await prepareDispatchBrief({ ...BASE, problem: "", scope: "src/gone.ts" }, undefined, deps);

    expect(prepared.ok).toBe(false);
    if (!prepared.ok) {
      expect(prepared.lint.missingHeadings).toEqual(["Problem / observed behavior"]);
      expect(prepared.lint.missingPaths).toEqual([]); // the path was demoted; the section is what remains
    }
  });

  it("falls back to the lint's own rejection when a repair does not pass (no worse than refusing)", async () => {
    // A lint that keeps reporting the path whatever the body says: the repair cannot satisfy it.
    const stubborn = (): Promise<BriefLintResult> =>
      Promise.resolve({ ok: false, missing: ["x"], missingHeadings: [], emptyHeadings: [], missingPaths: ["src/gone.ts"], otherProblems: [], warnings: [] });

    const prepared = await prepareDispatchBrief({ ...BASE, scope: "src/gone.ts" }, undefined, { lint: stubborn, format: formatAntigravityIssueBody });

    expect(prepared.ok).toBe(false);
  });

  it("is deterministic: the same input and repository state give the same body, so the card and the filing agree", async () => {
    const input = { ...BASE, scope: "src/gone.ts and src/other-gone.ts", evidence: "" };
    const a = await prepareDispatchBrief(input, "do the thing", deps);
    const b = await prepareDispatchBrief(input, "do the thing", deps);

    expect(a.body).toBe(b.body);
  });

  it("carries the lint's own warnings (a path it could not check) after the demotion note", async () => {
    const warns = (body: string): Promise<BriefLintResult> =>
      lintAgentBrief(body, (path) => (path === "src/unknown.ts" ? "unknown" : false)).then((r) => r);

    const prepared = await prepareDispatchBrief({ ...BASE, scope: "src/gone.ts, src/unknown.ts" }, undefined, { lint: warns, format: formatAntigravityIssueBody });

    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.warnings[0]).toMatch(/^Not found in the repository/);
      expect(prepared.warnings.some((w) => /Could not verify/.test(w))).toBe(true);
    }
  });
});

describe("the repaired body really passes the real lint", () => {
  const FORMS = [
    "src/gone.ts",
    "`src/gone.ts`",
    "./src/gone.ts",
    "src/gone.ts:12",
    "`src/gone.ts:12-20`",
    "src/gone.ts#L3",
    "(src/gone.ts)",
    "src/gone.ts, then src/gone.ts.",
    "**src/gone.ts**",
  ];

  it.each(FORMS)("scope written as %s", async (form) => {
    const prepared = await prepareDispatchBrief({ ...BASE, scope: `Change ${form} so it works` }, undefined, deps);

    expect(prepared.ok, JSON.stringify(prepared.lint)).toBe(true);
    if (prepared.ok) {
      expect(prepared.demoted).toEqual(["src/gone.ts"]);
      const relinted = await lintAgentBrief(prepared.body, () => false);
      expect(relinted.missingPaths).toEqual([]);
    }
  });

  it.each(["goal", "expected", "problem", "evidence", "verification", "constraints", "forbidden", "acceptance"] as const)(
    "a backticked missing path in %s",
    async (field) => {
      const prepared = await prepareDispatchBrief({ ...BASE, [field]: `Look at \`src/gone.ts\` and \`src/gone.ts:9\`.` }, undefined, deps);

      expect(prepared.ok, JSON.stringify(prepared.lint)).toBe(true);
      if (prepared.ok) expect(prepared.demoted).toEqual(["src/gone.ts"]);
    },
  );
});

describe("withFounderRequestBrief (C-P0-2: /task writes the brief)", () => {
  const BLANK: AntigravityTaskInput = { title: "feat: shorter digest", goal: "", scope: "", expected: "  ", verification: "" };
  const REQUEST = "make the daily digest shorter";

  it("fills a blank goal, expected and verification from the founder's quoted sentence, and names what it filled", () => {
    const { input, filled } = withFounderRequestBrief(BLANK, REQUEST);

    expect(filled).toEqual(["Goal", "Expected", "Verification"]);
    expect(input.goal).toContain("> make the daily digest shorter");
    expect(input.expected).toContain("> make the daily digest shorter");
    expect(input.verification).toMatch(/repo(sitory)?'s own checks/i);
  });

  it("keeps every field the planner did supply, and lists only the ones it had to fill", () => {
    const { input, filled } = withFounderRequestBrief({ ...BLANK, goal: "Digest is at most 5 lines.", verification: "pnpm test" }, REQUEST);

    expect(filled).toEqual(["Expected"]);
    expect(input.goal).toBe("Digest is at most 5 lines.");
    expect(input.verification).toBe("pnpm test");
  });

  it("does nothing without a founder request: the tool cannot invent a goal", () => {
    for (const request of [undefined, null, "", "   "]) {
      const { input, filled } = withFounderRequestBrief(BLANK, request);
      expect(filled).toEqual([]);
      expect(input).toBe(BLANK);
    }
  });

  it("fills a multi-line request as one quoted block", () => {
    const { input } = withFounderRequestBrief(BLANK, "line one\nline two");
    expect(input.goal).toContain("> line one\n> line two");
  });

  it("produces a body the real lint accepts, with no file named anywhere", async () => {
    const prepared = await prepareDispatchBrief(BLANK, REQUEST, deps);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.filled).toEqual(["Goal", "Expected", "Verification"]);
    expect(prepared.input.scope).toBe(SCOPE_UNKNOWN);
  });

  it("reports nothing filled for a brief the planner completed", async () => {
    const prepared = await prepareDispatchBrief(BASE, REQUEST, deps);
    expect(prepared.ok && prepared.filled).toEqual([]);
  });

  it("refuses, as before, a blank brief with no founder request", async () => {
    const prepared = await prepareDispatchBrief(BLANK, undefined, deps);
    expect(prepared.ok).toBe(false);
  });
});
