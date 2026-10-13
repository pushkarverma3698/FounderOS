/**
 * `verify-pr-scope` — the 30-day hard freeze (plan 2026-10-02) as a CI check.
 * The incident: 1,112 commits in 5 months, 40% fixes, near-zero output. Every new feature added
 * bugs that the next PR fixed. The freeze and the `Moves:` line make "does this PR serve one of
 * the four outcomes?" a failing check instead of a rule nobody enforces.
 */

import { describe, it, expect } from "vitest";
import { evaluatePrScope, frozenTouches, newBuildFiles, parseCheckedFirst, parseMoves } from "../../../scripts/verify-pr-scope.js";

const BODY_A = "## What changed\nx\n\nMoves: A\n";

describe("parseMoves", () => {
  it("reads one outcome", () => expect(parseMoves("Moves: A")).toEqual(["A"]));
  it("reads several outcomes, any case and separator", () => expect(parseMoves("moves: a, C / d")).toEqual(["A", "C", "D"]));
  it("reads crash-fix", () => expect(parseMoves("Moves: crash-fix")).toEqual(["crash-fix"]));
  it("is empty when the line is missing", () => expect(parseMoves("## What changed\nstuff")).toEqual([]));
  it("ignores an unknown outcome", () => expect(parseMoves("Moves: Z")).toEqual([]));
  it("does not read a Moves line inside an HTML comment (the template's placeholder)", () =>
    expect(parseMoves("<!-- Moves: A -->")).toEqual([]));
});

describe("frozenTouches", () => {
  it("flags a frozen module", () =>
    expect(frozenTouches(["src/tools/video-brief.ts", "src/kernel/graph.ts"])).toEqual(["src/tools/video-brief.ts"]));
  it("flags frozen directories", () =>
    expect(frozenTouches(["src/tools/jobhunt/gates.ts", "video-factory/x.mjs", "mac-client/a.swift"])).toHaveLength(3));
  it("does not flag the outcome surfaces", () =>
    expect(frozenTouches(["src/tools/dispatch-antigravity.ts", "src/tools/github.ts", "deploy/agent-dispatch"])).toEqual([]));
});

describe("evaluatePrScope", () => {
  it("passes a PR that names an outcome and touches nothing frozen", () =>
    expect(evaluatePrScope({ files: ["src/tools/github.ts"], body: BODY_A, labels: [], headRef: "claude/fix-x" }).ok).toBe(true));

  it("fails a PR with no Moves line", () => {
    const r = evaluatePrScope({ files: ["src/tools/github.ts"], body: "no line", labels: [], headRef: "claude/fix-x" });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/Moves:/);
  });

  it("fails a PR touching a frozen path without a label, and names the file", () => {
    const r = evaluatePrScope({ files: ["src/tools/video-brief.ts"], body: BODY_A, labels: [], headRef: "claude/feat-x" });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("src/tools/video-brief.ts");
  });

  it("lets a crash-fix or unfreeze label through a frozen path", () => {
    for (const label of ["crash-fix", "unfreeze"]) {
      expect(evaluatePrScope({ files: ["src/tools/video-brief.ts"], body: BODY_A, labels: [label], headRef: "claude/fix-x" }).ok).toBe(true);
    }
  });

  it("accepts `Moves: unfreeze` for work the founder approved outside A–D, only with the unfreeze label", () => {
    const body = "Moves: unfreeze — founder approved";
    expect(parseMoves(body)).toEqual(["unfreeze"]);
    expect(evaluatePrScope({ files: ["src/tools/github.ts"], body, labels: ["unfreeze"], headRef: "feat/x" }).ok).toBe(true);
    const r = evaluatePrScope({ files: ["src/tools/github.ts"], body, labels: [], headRef: "feat/x" });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/unfreeze.*label/);
  });

  it("exempts sync and promotion PRs, whose content was gated on the way in", () => {
    for (const headRef of ["main", "beta", "chore/promote-where-status", "chore/sync-beta"]) {
      expect(evaluatePrScope({ files: ["src/tools/video-brief.ts"], body: "", labels: [], headRef }).ok).toBe(true);
    }
  });
});

describe("promotion-branch exemption is narrow", () => {
  it("does not exempt an ordinary chore/ branch", () => {
    expect(evaluatePrScope({ files: ["src/tools/video-brief.ts"], body: "", labels: [], headRef: "chore/tidy" }).ok).toBe(false);
  });
});

// Founder 2026-10-13: agents built team-shift, chief-run and a host cron scheduler that OpenDots already had natively
// (scheduled tasks, computers), and days went into them. A new code file now needs a `Checked first:` line.
describe("Checked first", () => {
  const CHECKED = `${BODY_A}Checked first: grep -rn scheduler src/ and the OpenDots docs; native scheduled tasks exist, so none built.\n`;
  it("reads the line, ignoring the template's HTML-comment placeholder", () => {
    expect(parseCheckedFirst("Checked first: grep found nothing")).toBe("grep found nothing");
    expect(parseCheckedFirst("Checked first: <!-- what you searched -->")).toBe("");
    expect(parseCheckedFirst("no line")).toBe("");
  });
  it("counts new code and scripts, never tests, docs or markdown", () =>
    expect(newBuildFiles(["src/a.ts", "deploy/x/run", "tests/unit/a.test.ts", "docs/plans/p.md", "README.md"])).toEqual(["src/a.ts", "deploy/x/run"]));
  it("fails a PR that adds a script with no Checked first line, and names the file", () => {
    const r = evaluatePrScope({ files: ["deploy/opendots/team-shift"], added: ["deploy/opendots/team-shift"], body: BODY_A, labels: [], headRef: "feat/x" });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("deploy/opendots/team-shift");
    expect(r.problems.join("\n")).toContain("Checked first:");
  });
  it("fails a one-word Checked first line", () =>
    expect(evaluatePrScope({ files: ["src/a.ts"], added: ["src/a.ts"], body: `${BODY_A}Checked first: yes\n`, labels: [], headRef: "feat/x" }).ok).toBe(false));
  it("passes with a real Checked first line, or when only existing files and tests change", () => {
    expect(evaluatePrScope({ files: ["src/a.ts"], added: ["src/a.ts"], body: CHECKED, labels: [], headRef: "feat/x" }).ok).toBe(true);
    expect(evaluatePrScope({ files: ["src/a.ts", "tests/unit/a.test.ts"], added: ["tests/unit/a.test.ts"], body: BODY_A, labels: [], headRef: "fix/x" }).ok).toBe(true);
  });
  it("exempts promotions", () =>
    expect(evaluatePrScope({ files: ["src/a.ts"], added: ["src/a.ts"], body: BODY_A, labels: [], headRef: "chore/promote-x" }).ok).toBe(true));
});
