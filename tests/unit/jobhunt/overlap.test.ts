/**
 * Unit tests — stack overlap ranking.
 *
 * The property that carries the whole feature: both sides go through the SAME
 * extractor. Matching the CV with different logic from the postings is exactly
 * how a report claims a gap in a skill the CV states plainly.
 */

import { describe, it, expect } from "vitest";
import {
  compareOverlap,
  formatOverlap,
  overlapScore,
} from "../../../src/tools/jobhunt/overlap.js";

const CV = "Built with TypeScript, React and PostgreSQL. Deployed on Docker and Kubernetes.";

describe("overlapScore", () => {
  it("counts only the terms the posting actually asks for", () => {
    const result = overlapScore("We need TypeScript and Kubernetes experience.", CV);
    expect(result.asked).toBe(2);
    expect(result.matched).toEqual(expect.arrayContaining(["TypeScript", "Kubernetes"]));
    expect(result.missing).toEqual([]);
    expect(result.ratio).toBe(1);
  });

  it("lists what the posting wants and the CV does not state", () => {
    const result = overlapScore("You will write Rust and TypeScript daily.", CV);
    expect(result.matched).toEqual(["TypeScript"]);
    expect(result.missing).toEqual(["Rust"]);
    expect(result.ratio).toBeCloseTo(0.5);
  });

  it("scores a disjoint posting at zero", () => {
    const result = overlapScore("Deep COBOL and Fortran background required.", CV);
    expect(result.matched).toEqual([]);
    expect(result.ratio).toBe(0);
  });

  it("scores an unmeasurable posting 0, NOT 1", () => {
    // "0 of 0 skills missing" reads as a perfect match. The honest reading is
    // that nothing was measured — and ranking that to the top of DO TODAY would
    // put the least legible role in front of the founder first.
    const result = overlapScore("A great opportunity for a motivated self-starter.", CV);
    expect(result.asked).toBe(0);
    expect(result.ratio).toBe(0);
  });

  it("scores zero against an empty CV rather than throwing", () => {
    // A missing per-track CV must cost the row its rank, never the whole brief.
    const result = overlapScore("We need TypeScript.", "");
    expect(result.matched).toEqual([]);
    expect(result.asked).toBe(1);
  });

  it("uses the same extractor on both sides", () => {
    // A CV that IS the posting must score a perfect overlap. If the two sides
    // ever diverge, this is the test that fails first.
    const posting = "Stack: TypeScript, Kubernetes, PostgreSQL, Docker.";
    const result = overlapScore(posting, posting);
    expect(result.missing).toEqual([]);
    expect(result.ratio).toBe(1);
  });

  it("is deterministic across repeated calls", () => {
    const a = overlapScore("TypeScript, Rust, Kubernetes", CV);
    const b = overlapScore("TypeScript, Rust, Kubernetes", CV);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("formatOverlap", () => {
  it("prints a count over a count, never a percentage or a grade", () => {
    expect(formatOverlap(overlapScore("Rust and TypeScript.", CV))).toBe("1/2");
  });
});

describe("compareOverlap", () => {
  it("puts the larger matched count first, even at a lower ratio", () => {
    // 9/12 leads 3/3: the bigger role has more surface to write an application
    // about, and a 3-term posting hitting 100% is mostly a short posting.
    // "x"/"y" are not real dictionary terms, so every one defaults to weight 1
    // — this is the un-weighted raw-count case, unchanged.
    const big = { matched: Array(9).fill("x"), missing: Array(3).fill("y"), asked: 12, ratio: 0.75 };
    const small = { matched: Array(3).fill("x"), missing: [], asked: 3, ratio: 1 };
    expect(compareOverlap(big, small)).toBeLessThan(0);
  });

  it("breaks ties on ratio", () => {
    const tight = { matched: ["a", "b"], missing: [], asked: 2, ratio: 1 };
    const loose = { matched: ["a", "b"], missing: Array(8).fill("y"), asked: 10, ratio: 0.2 };
    expect(compareOverlap(tight, loose)).toBeLessThan(0);
  });

  it("ranks fewer named technologies above more generic process terms", () => {
    // Reproduces the live case (2026-09-01): a Windows DevOps posting matching
    // Azure/CI-CD/Linux/Mentoring (4 raw) used to outrank an AI Engineer
    // posting matching LangGraph/RAG/LLM/Prompt Engineering/AI Agents (5 raw)
    // whenever the AI posting asked for enough OTHER things it didn't have —
    // both would eventually collide with the DevOps posting's raw count. Here
    // both have four matches; only the CATEGORY differs.
    const genericDevOps = {
      matched: ["Azure", "CI/CD", "Linux", "Mentoring"],
      missing: ["SQL", "Bash", "Ansible"],
      asked: 7,
      ratio: 4 / 7,
    };
    const namedAiStack = {
      matched: ["LangGraph", "RAG", "LLM", "Prompt Engineering"],
      missing: ["Python"],
      asked: 5,
      ratio: 4 / 5,
    };
    expect(compareOverlap(namedAiStack, genericDevOps)).toBeLessThan(0);
  });

  it("is a weighted sum, not a hard category ranking — enough practice terms still win", () => {
    // 6 practice terms × 0.35 = 2.1, which still edges out 2 named terms × 1 = 2.
    // The category weight is a thumb on the scale, not "AI/languages always first".
    const manyPractice = {
      matched: ["Agile", "TDD", "Mentoring", "Code Review", "Observability", "System Design"],
      missing: [],
      asked: 6,
      ratio: 1,
    };
    const fewNamed = { matched: ["Python", "Rust"], missing: [], asked: 2, ratio: 1 };
    expect(compareOverlap(manyPractice, fewNamed)).toBeLessThan(0);
  });
});
