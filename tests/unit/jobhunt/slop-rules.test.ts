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
});
