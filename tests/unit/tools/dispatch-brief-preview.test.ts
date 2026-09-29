/**
 * Unit tests — what the approval card shows of a brief (src/tools/dispatch-brief-preview.ts).
 * ===========================================================================================
 * src/gateway/approval-card.ts cuts every card's preview at 1500 characters, with no marker.
 * With the brief now carrying nine sections and a standing-constraints block, the raw body
 * overflows that on an ordinary task and the first thing to go is the END: Verification and
 * Acceptance, the two sections the founder most needs to see before he approves an
 * unattended write. The card therefore shows a budgeted digest, says how much of each field
 * it clipped, and says what else is in the issue.
 */

import { describe, it, expect } from "vitest";
import { formatApprovalCard } from "../../../src/gateway/approval-card.js";
import { formatAntigravityIssueBody } from "../../../src/tools/dispatch-antigravity.js";
import {
  CARD_FIELD_BUDGETS,
  CARD_PREVIEW_MAX_CHARS,
  clipForCard,
  renderCardPreview,
} from "../../../src/tools/dispatch-brief-preview.js";

/** The card's own cut-off, as a test-side literal so a change to it is noticed here. */
const APPROVAL_CARD_PREVIEW_LIMIT = 1500;

const TYPICAL = {
  title: "fix: retry budget is spent on 4xx",
  goal: "Stop the ATS sweep spending its retry budget on 4xx responses, which can never succeed.",
  scope: "src/tools/jobhunt/free-ats-source.ts",
  expected: "A 4xx response is recorded as a permanent failure and never retried; 5xx and network errors still are.",
  verification: "pnpm test tests/unit/tools/free-ats-source.test.ts && pnpm gate",
  acceptance: "A new test fails without the fix and passes with it.",
  problem: "Every 404 board is retried three times.",
  evidence: "The sweep log of 2026-09-20 shows 1,204 retries on 404 responses.",
};

/** Every field far larger than the card can show. */
const MAXIMAL = {
  title: "feat: everything",
  goal: "goal ".repeat(6000),
  scope: "src/a.ts, ".repeat(3000),
  expected: "expected ".repeat(6000),
  verification: "pnpm test && ".repeat(3000),
  acceptance: "acceptance ".repeat(6000),
  problem: "problem ".repeat(6000),
  evidence: "evidence ".repeat(6000),
  constraints: "constraint ".repeat(6000),
  newFiles: "src/new-file.ts\n".repeat(3000),
};

const card = (preview: string) =>
  formatApprovalCard({ kind: "approval", action: "dispatch_antigravity_task", title: "T", summary: "S", preview, args: {} }).html;

describe("clipForCard", () => {
  it("leaves a field that fits alone, with whitespace collapsed to single spaces", () => {
    expect(clipForCard("a\n\n- b\n- c   d", 100)).toBe("a - b - c d");
  });

  it("says exactly how many characters it left out, and never exceeds the budget", () => {
    const text = "x".repeat(1000);
    const clipped = clipForCard(text, 100);

    expect(clipped.length).toBeLessThanOrEqual(100);
    const kept = clipped.replace(/ … \(\+\d+ more\)$/, "").length;
    expect(clipped).toMatch(/ … \(\+\d+ more\)$/);
    expect(clipped.endsWith(`(+${text.length - kept} more)`)).toBe(true);
  });

  it("stays within the budget for an enormous input too", () => {
    expect(clipForCard("y".repeat(10_000_000), 100).length).toBeLessThanOrEqual(100);
  });
});

describe("renderCardPreview", () => {
  it("shows what the founder approves on, labelled, and what else is in the issue", () => {
    const body = formatAntigravityIssueBody(TYPICAL);
    const preview = renderCardPreview(TYPICAL, { bodyChars: body.length });

    expect(preview.split("\n")).toEqual([
      `Goal: ${TYPICAL.goal}`,
      `Expected: ${TYPICAL.expected}`,
      `Files: ${TYPICAL.scope}`,
      `Verify: ${TYPICAL.verification}`,
      `Accept: ${TYPICAL.acceptance}`,
      `Also filed: Problem, Evidence, Constraints, Forbidden (full brief: ${body.length} characters).`,
    ]);
    expect(preview).not.toContain("(+");
  });

  it("shows the acceptance criteria the issue will really carry when none were given", () => {
    const preview = renderCardPreview({ ...TYPICAL, acceptance: undefined }, { bodyChars: 100 });
    expect(preview).toContain("Accept: All verification commands pass; Claude pr-brain clears review with no BLOCKER.");
  });

  it("lists new files on their own line, only when there are any", () => {
    expect(renderCardPreview(TYPICAL, { bodyChars: 1 })).not.toContain("New files:");
    expect(renderCardPreview({ ...TYPICAL, newFiles: "src/tools/x.ts" }, { bodyChars: 1 })).toContain(
      "New files: src/tools/x.ts",
    );
  });

  it("says when paths could not be verified, so approving is an informed act", () => {
    const preview = renderCardPreview(TYPICAL, {
      bodyChars: 1,
      warnings: ["Could not verify 2 of 2 paths (Service Unavailable); not blocking the dispatch: src/a.ts, src/b.ts."],
    });

    expect(preview).toContain("Not verified: Could not verify 2 of 2 paths (Service Unavailable)");
  });

  it("fits under the approval card's own cut-off even when every field is enormous", () => {
    const preview = renderCardPreview(MAXIMAL, {
      bodyChars: 500_000,
      warnings: ["Could not verify 30 of 30 paths (".padEnd(1000, "x")],
    });

    expect(CARD_PREVIEW_MAX_CHARS).toBeLessThan(APPROVAL_CARD_PREVIEW_LIMIT);
    expect(preview.length).toBeLessThanOrEqual(CARD_PREVIEW_MAX_CHARS);
    for (const label of ["Goal:", "Expected:", "Files:", "New files:", "Verify:", "Accept:", "Also filed:", "Not verified:"]) {
      expect(preview).toContain(label);
    }
    expect(preview.match(/\(\+\d+ more\)/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("reaches the founder whole: nothing is cut by the real approval card", () => {
    const preview = renderCardPreview(MAXIMAL, { bodyChars: 500_000, warnings: ["w".repeat(500)] });
    const html = card(preview);

    // The last line survives the card's slice, and so does the line before it.
    expect(html).toContain("Also filed: Problem, Evidence, Constraints, Forbidden (full brief: 500000 characters).");
    expect(html).toContain("Accept: ");
    expect(html.length).toBeLessThan(4096);
  });

  it("keeps the budget table honest: the worst case cannot exceed CARD_PREVIEW_MAX_CHARS", () => {
    const fields = Object.values(CARD_FIELD_BUDGETS).reduce((sum, n) => sum + n, 0);
    // labels (~50) + separators (~8) + the closing line (~100) + a warning line (~185)
    expect(fields + 50 + 8 + 100 + 185).toBeLessThanOrEqual(CARD_PREVIEW_MAX_CHARS);
  });
});

describe("why the raw body is not the preview", () => {
  it("an ordinary brief overflows the card, and the card cuts Verification and Acceptance first", () => {
    const body = formatAntigravityIssueBody({
      ...TYPICAL,
      goal: `${TYPICAL.goal} ${"Context the executor needs. ".repeat(8)}`,
      expected: `${TYPICAL.expected} ${"Behaviour detail. ".repeat(20)}`,
    });
    const html = card(body);

    expect(body.length).toBeGreaterThan(APPROVAL_CARD_PREVIEW_LIMIT);
    expect(html).not.toContain("Verification commands");
    expect(html).not.toContain("Acceptance criteria");
    // The digest of the very same brief keeps both.
    const digest = card(renderCardPreview(TYPICAL, { bodyChars: body.length }));
    expect(digest).toContain("Verify: pnpm test");
    expect(digest).toContain("Accept: A new test fails");
  });
});
