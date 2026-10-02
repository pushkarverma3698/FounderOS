/**
 * `verify-pr-scope` — the 30-day hard freeze (plan 2026-10-02) as a CI check.
 * The incident: 1,112 commits in 5 months, 40% fixes, near-zero output. Every new feature added
 * bugs that the next PR fixed. The freeze and the `Moves:` line make "does this PR serve one of
 * the four outcomes?" a failing check instead of a rule nobody enforces.
 */

import { describe, it, expect } from "vitest";
import { evaluatePrScope, frozenTouches, parseMoves } from "../../../scripts/verify-pr-scope.js";

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

  it("exempts sync and promotion PRs, whose content was gated on the way in", () => {
    for (const headRef of ["main", "beta"]) {
      expect(evaluatePrScope({ files: ["src/tools/video-brief.ts"], body: "", labels: [], headRef }).ok).toBe(true);
    }
  });
});
