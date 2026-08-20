/**
 * Unit tests — rendering a Finding as a dispatchable GitHub issue.
 *
 * THE FAILURES THESE GUARD AGAINST.
 *  · An issue handed to an unattended executor is read with no conversation
 *    history. A missing template section is not cosmetic — `agent:ready` is the
 *    intake gate and this loop applies it itself, so the body must satisfy the
 *    template at the moment it is filed or an executor starts on an underspecified
 *    task.
 *  · A kind that needs a decision (a cost hotspot has no code fix) reaching an
 *    executor produces a PR invented to look productive. That must be impossible,
 *    not merely unlikely.
 *  · A persistent finding must not spawn a new issue every three days.
 */

import { describe, it, expect } from "vitest";
import {
  AGENT_READY_LABEL,
  DISPATCHABLE_KINDS,
  EVOLUTION_LABEL,
  findingMarker,
  isDispatchable,
  pickDispatchTarget,
  renderIssueBody,
  renderIssueTitle,
} from "../../../src/evolution/issue-body.js";
import { computeFingerprint } from "../../../src/evolution/fingerprint.js";
import type { Finding } from "../../../src/evolution/types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    kind: "unused-dependency",
    subject: "left-pad",
    evidence: "left-pad is declared in package.json and imported nowhere under src/.",
    severity: "medium",
    ...overrides,
  };
}

const CONTEXT = { fingerprint: "a".repeat(64), detectedAt: new Date("2026-08-13T09:00:00Z") };

describe("dispatch eligibility", () => {
  it("refuses the kinds that need a decision rather than an implementation", () => {
    // Each of these has a documented reason in issue-body.ts. A cost hotspot has
    // no code fix at all; the other three have a blast radius no unattended
    // executor should be handed.
    for (const kind of ["cost-hotspot", "orphan-module", "dead-export", "oversized-prompt", "loc-pressure"] as const) {
      expect(isDispatchable(finding({ kind }))).toBe(false);
    }
  });

  it("accepts the kinds an executor can close without a product decision", () => {
    for (const kind of ["unapplied-lesson", "recurring-failure", "unused-dependency", "untested-module"] as const) {
      expect(isDispatchable(finding({ kind }))).toBe(true);
    }
  });

  it("DISPATCHABLE_KINDS and isDispatchable never disagree", () => {
    for (const kind of DISPATCHABLE_KINDS) {
      expect(isDispatchable(finding({ kind }))).toBe(true);
    }
  });

  it("renderIssueBody throws rather than emitting an issue for an undispatchable kind", () => {
    // Belt and braces: if a future caller skips the filter, this must fail loudly
    // instead of filing an issue with no guidance in it.
    expect(() => renderIssueBody(finding({ kind: "cost-hotspot" }), CONTEXT)).toThrow(/not in DISPATCHABLE_KINDS/);
  });
});

describe("pickDispatchTarget", () => {
  it("takes the first dispatchable finding in ranked order, skipping the rest", () => {
    const ranked = [
      finding({ kind: "cost-hotspot", subject: "planner:gemini" }),
      finding({ kind: "orphan-module", subject: "src/core/companies.ts" }),
      finding({ kind: "unused-dependency", subject: "left-pad" }),
    ];

    const target = pickDispatchTarget(ranked, new Set());

    expect(target?.finding.subject).toBe("left-pad");
  });

  it("skips a finding that already has an issue and moves to the next", () => {
    const first = finding({ kind: "unused-dependency", subject: "left-pad" });
    const second = finding({ kind: "untested-module", subject: "src/core/time.ts" });

    const target = pickDispatchTarget([first, second], new Set([computeFingerprint(first)]));

    expect(target?.finding.subject).toBe("src/core/time.ts");
  });

  it("returns null when every dispatchable finding is already filed", () => {
    const only = finding();
    expect(pickDispatchTarget([only], new Set([computeFingerprint(only)]))).toBeNull();
  });

  it("returns null when nothing is dispatchable, however many findings there are", () => {
    const ranked = Array.from({ length: 50 }, (_, i) =>
      finding({ kind: "dead-export", subject: `symbol${i}` }),
    );
    expect(pickDispatchTarget(ranked, new Set())).toBeNull();
  });

  it("the fingerprint it returns is the one persist-findings keys on", () => {
    // If these two ever diverge, an issue and its evolution_findings row stop
    // agreeing on what "the same defect" means, and dedupe silently fails.
    const only = finding();
    expect(pickDispatchTarget([only], new Set())?.fingerprint).toBe(computeFingerprint(only));
  });
});

describe("renderIssueBody", () => {
  it("fills every section of .github/ISSUE_TEMPLATE/agent-task.md", () => {
    const body = renderIssueBody(finding(), CONTEXT);

    for (const heading of [
      "## Goal",
      "## Problem / observed behavior",
      "## Expected behavior",
      "## Evidence",
      "## Files or subsystem in scope",
      "## Constraints",
      "## Explicitly forbidden",
      "## Verification commands",
      "## Acceptance criteria",
    ]) {
      expect(body).toContain(heading);
    }
  });

  it("no section is left empty — the template's gate is that they are filled in", () => {
    const body = renderIssueBody(finding(), CONTEXT);
    const sections = body.split(/^## /m).slice(1);

    expect(sections).toHaveLength(9);
    for (const section of sections) {
      const content = section.split("\n").slice(1).join("\n").trim();
      expect(content.length).toBeGreaterThan(20);
    }
  });

  it("carries a machine-readable fingerprint the next run can read back", () => {
    const body = renderIssueBody(finding(), CONTEXT);
    expect(body).toContain(findingMarker(CONTEXT.fingerprint));
  });

  it("states the finding's own evidence verbatim, not a paraphrase", () => {
    const f = finding({ evidence: "left-pad cost $0.16 of $0.22 across 419 calls." });
    expect(renderIssueBody(f, CONTEXT)).toContain("left-pad cost $0.16 of $0.22 across 419 calls.");
  });

  it("tells the executor to close the issue rather than invent a change when the finding does not reproduce", () => {
    // The likeliest harm from an automated filer is a PR that changes code to
    // look productive. The body must license doing nothing.
    const body = renderIssueBody(finding(), CONTEXT);
    expect(body).toMatch(/close the issue instead of inventing a change/);
    expect(body).toMatch(/an honest no-op is a better outcome/);
  });

  it("names a verification command", () => {
    expect(renderIssueBody(finding(), CONTEXT)).toMatch(/```bash\npnpm /);
  });

  it("includes the commit sha when one is known and omits the line when it is not", () => {
    expect(renderIssueBody(finding(), { ...CONTEXT, commitSha: "8a5b9a3" })).toContain("`8a5b9a3`");
    expect(renderIssueBody(finding(), CONTEXT)).not.toContain("Detected at commit");
  });
});

describe("renderIssueTitle", () => {
  it("names the kind and the subject", () => {
    expect(renderIssueTitle(finding())).toBe("[self-audit] unused-dependency: left-pad");
  });

  it("truncates a subject that would be unreadable in a list view", () => {
    // Failure signatures are long: normalizeFailureSignature writes <uuid>,
    // <hash> and <url> placeholders into them.
    const title = renderIssueTitle(finding({ subject: "worker:" + "x".repeat(200) }));
    expect(title.length).toBeLessThan(120);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("labels", () => {
  it("are the two the pipeline actually reads", () => {
    // agent:ready is the dispatcher's intake gate; evolution:auto is how the
    // NEXT run recognises its own past issues for dedupe. A typo in either is
    // silent — the loop would file issues nothing ever claims, forever.
    expect(EVOLUTION_LABEL).toBe("evolution:auto");
    expect(AGENT_READY_LABEL).toBe("agent:ready");
  });
});
