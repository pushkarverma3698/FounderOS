/**
 * ReviewVerdict parsing: a reviewer's prose is not a verdict, its JSON block is.
 *
 * Why this exists: on PR #861 the reviewer wrote "GATE PASSED" in free text and missed three real
 * bugs; on PR #797 a reviewer cleared a runbook containing an invented command. A verdict is only
 * trusted when it is schema-valid and names the head it reviewed. Anything else is UNKNOWN, and
 * UNKNOWN never becomes APPROVE.
 */

import { describe, it, expect } from "vitest";
import {
  REVIEW_VERDICT_INSTRUCTIONS,
  ReviewVerdictSchema,
  parseReviewVerdict,
} from "../../../src/tools/review-verdict.js";

const HEAD = "a".repeat(40);

function verdictJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, head_sha: HEAD, decision: "APPROVE", findings: [], ...over });
}
const fenced = (json: string): string => "Looks fine.\n\n```json\n" + json + "\n```\n";

const BLOCKER = { severity: "blocker", file: "src/a.ts", line: 3, claim: "drops the queue", evidence: "curl -s ignores 4xx" };

describe("parseReviewVerdict: accepted shapes", () => {
  it("parses a fenced json block", () => {
    const v = parseReviewVerdict(fenced(verdictJson()), HEAD);
    expect(v).toEqual({ version: 1, head_sha: HEAD, decision: "APPROVE", findings: [] });
  });

  it("parses a bare JSON object after prose", () => {
    const v = parseReviewVerdict(`GATE PASSED\n${verdictJson({ decision: "REQUEST_CHANGES", findings: [BLOCKER] })}`, HEAD);
    expect(v.decision).toBe("REQUEST_CHANGES");
    expect(v.findings).toHaveLength(1);
  });

  it("uses the LAST fenced block, so quoted examples earlier in the answer do not win", () => {
    const earlier = "```json\n" + verdictJson({ decision: "APPROVE" }) + "\n```\n";
    const text = `${earlier}\nOn reflection:\n` + fenced(verdictJson({ decision: "REQUEST_CHANGES", findings: [BLOCKER] }));
    expect(parseReviewVerdict(text, HEAD).decision).toBe("REQUEST_CHANGES");
  });

  it("does not let a valid earlier block rescue an invalid last block", () => {
    const text = fenced(verdictJson()) + "\n```json\n{ not json\n```\n";
    const v = parseReviewVerdict(text, HEAD);
    expect(v.decision).toBe("UNKNOWN");
  });

  it("finds a bare object whose strings contain braces", () => {
    const f = { ...BLOCKER, claim: "uses ${VAR} } and {" };
    const v = parseReviewVerdict(`done ${verdictJson({ decision: "REQUEST_CHANGES", findings: [f] })} bye`, HEAD);
    expect(v.decision).toBe("REQUEST_CHANGES");
    expect(v.findings[0]?.claim).toContain("${VAR}");
  });
});

describe("parseReviewVerdict: everything else is UNKNOWN with a reason", () => {
  const cases: Array<[string, string]> = [
    ["empty output", ""],
    ["free text only", "GATE PASSED. Nothing to fix."],
    ["malformed JSON", "```json\n{\"version\":1,\n```"],
    ["wrong version", fenced(verdictJson({ version: 2 }))],
    ["unknown decision", fenced(verdictJson({ decision: "LGTM" }))],
    ["finding without evidence", fenced(verdictJson({ decision: "REQUEST_CHANGES", findings: [{ severity: "major", claim: "x" }] }))],
    ["bad severity", fenced(verdictJson({ findings: [{ ...BLOCKER, severity: "nit" }] }))],
    ["JSON array instead of object", "```json\n[]\n```"],
  ];
  it.each(cases)("%s", (_name, text) => {
    const v = parseReviewVerdict(text, HEAD);
    expect(v.decision).toBe("UNKNOWN");
    expect(v.head_sha).toBe(HEAD);
    expect(v.findings.length).toBeGreaterThanOrEqual(1);
    expect(v.findings[0]?.claim.length).toBeGreaterThan(0);
  });

  it("head_sha mismatch is UNKNOWN and says both shas", () => {
    const other = "b".repeat(40);
    const v = parseReviewVerdict(fenced(verdictJson({ head_sha: other })), HEAD);
    expect(v.decision).toBe("UNKNOWN");
    expect(v.head_sha).toBe(HEAD);
    const text = v.findings.map((f) => f.claim + f.evidence).join(" ");
    expect(text).toContain(other);
    expect(text).toContain(HEAD);
  });

  it("a model-supplied UNKNOWN stays UNKNOWN and keeps its findings", () => {
    const f = { severity: "major", claim: "could not run the tests", evidence: "no network" };
    const v = parseReviewVerdict(fenced(verdictJson({ decision: "UNKNOWN", findings: [f] })), HEAD);
    expect(v.decision).toBe("UNKNOWN");
    expect(v.findings).toContainEqual(f);
  });

  it("UNKNOWN is never APPROVE, whatever the text says", () => {
    for (const t of ["APPROVE", "decision: APPROVE", fenced(verdictJson({ head_sha: "c".repeat(40) }))]) {
      expect(parseReviewVerdict(t, HEAD).decision).not.toBe("APPROVE");
    }
  });
});

describe("parseReviewVerdict: APPROVE with a blocker", () => {
  it("is coerced to REQUEST_CHANGES and keeps the blocker", () => {
    const v = parseReviewVerdict(fenced(verdictJson({ decision: "APPROVE", findings: [BLOCKER] })), HEAD);
    expect(v.decision).toBe("REQUEST_CHANGES");
    expect(v.findings).toContainEqual(BLOCKER);
    expect(v.findings.some((f) => /coerced|blocker/i.test(f.claim))).toBe(true);
  });

  it("APPROVE with only major/minor findings stays APPROVE", () => {
    const f = { severity: "major", claim: "naming", evidence: "x" };
    expect(parseReviewVerdict(fenced(verdictJson({ findings: [f] })), HEAD).decision).toBe("APPROVE");
  });
});

describe("ReviewVerdictSchema and the prompt fragment", () => {
  it("accepts optional file and line", () => {
    const r = ReviewVerdictSchema.safeParse({ version: 1, head_sha: HEAD, decision: "REQUEST_CHANGES", findings: [BLOCKER, { severity: "minor", claim: "c", evidence: "e" }] });
    expect(r.success).toBe(true);
  });

  it("instructions are short and name the schema fields", () => {
    expect(REVIEW_VERDICT_INSTRUCTIONS.split("\n").length).toBeLessThan(25);
    for (const k of ["head_sha", "decision", "APPROVE", "REQUEST_CHANGES", "UNKNOWN", "blocker", "```json"]) {
      expect(REVIEW_VERDICT_INSTRUCTIONS).toContain(k);
    }
  });
});
