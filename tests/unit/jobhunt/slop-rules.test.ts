/**
 * Unit tests — slop-rules colon-reveal detection.
 *
 * THE FAILURE THIS GUARDS AGAINST. The colon-reveal regex used `[^.!?]` for
 * its body, which matches newlines too — so it spanned an entire multi-line
 * CV section rather than one clause, and tripped on ordinary `Label: value`
 * bullets ("Languages: typescript, python, go"). A clean, slop-free CV would
 * fail the tailoring gate, burn a paid revision call, and still fail — see
 * src/tools/jobhunt/tailor-cv.ts.
 */

import { describe, it, expect } from "vitest";
import { findSlop } from "../../../src/tools/jobhunt/slop-rules.js";

describe("findSlop — colon reveal", () => {
  it("does not flag markdown skills/label bullets", () => {
    const cv = [
      "## Skills",
      "- Languages: typescript, python, go",
      "- Databases: postgres, redis",
      "- Cloud: aws, gcp",
    ].join("\n");
    expect(findSlop(cv).filter((v) => v.rule === "Colon reveal")).toEqual([]);
  });

  it("does not flag a bulleted sentence that happens to contain a colon", () => {
    const cv = "- Owned the payments reconciliation service: it processes 40k transactions a day";
    expect(findSlop(cv).filter((v) => v.rule === "Colon reveal")).toEqual([]);
  });

  it("still flags a genuine colon-reveal in prose", () => {
    const text = "Here is the real secret: nobody actually reads the cover letter at all.";
    const violations = findSlop(text).filter((v) => v.rule === "Colon reveal");
    expect(violations.length).toBe(1);
  });

  // 2026-09-16 prod: this exact sentence (real CV body content, describing
  // FounderOS's own eval harness) blocked every /draft attempt for both
  // profiles — "Slop violations persist after revision" — because the locked
  // CV body is pasted verbatim on every tailoring attempt, so a false
  // positive here fails 100% of the time, not just for some postings.
  it("does not flag a factual sentence whose colon introduces an enumeration", () => {
    const text =
      "Measures what agent portfolios assert but rarely test: fabricated-action rate, " +
      "plan determinism, cost and failure recovery across a contract-first kernel, a naive " +
      "ReAct loop and raw tool-calling, holding model, temperature, tools and task set constant.";
    expect(findSlop(text).filter((v) => v.rule === "Colon reveal")).toEqual([]);
  });

  it("does not flag a second real example — a component description with a comma-listed colon body", () => {
    const text =
      "The half of FounderOS that runs on my laptop is Python: about 2,500 lines across 20 " +
      "modules with a pytest suite, handling browser automation for job applications, a " +
      "Postgres sync layer, a local ledger and liveness re-checking of postings before " +
      "anything is submitted.";
    expect(findSlop(text).filter((v) => v.rule === "Colon reveal")).toEqual([]);
  });
});

describe("findSlop — banned words", () => {
  it("does not ban 'harness' as a technical noun (eval harness, test harness)", () => {
    const text = "Built an eval harness that measures fabricated-action rate and plan determinism.";
    expect(findSlop(text).filter((v) => v.rule === "Banned word")).toEqual([]);
  });

  it("still bans other generic AI-cliche filler words", () => {
    const text = "We need to leverage this robust, cutting-edge paradigm shift.";
    const words = findSlop(text)
      .filter((v) => v.rule === "Banned word")
      .map((v) => v.matchedText.toLowerCase());
    expect(words).toEqual(expect.arrayContaining(["leverage", "robust", "cutting-edge"]));
  });
});
