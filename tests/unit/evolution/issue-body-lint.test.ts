/**
 * The self-audit's issue body must pass the same brief lint the /task tool is held to.
 * ====================================================================================
 * src/evolution/dispatch-findings.ts files `agent:ready` issues on a schedule, unattended,
 * straight through `issues.create`, so no lint runs at filing time. The dispatcher's
 * claim-time check is the gate that catches a body that fails, by labelling the issue
 * `agent:needs-brief` and not claiming it. This test moves that failure earlier, to CI: the
 * body the loop REALLY produces, for every kind it is willing to dispatch, has all nine
 * sections filled and cites only files that exist in this checkout. So a rename of
 * src/kernel/worker.ts that leaves the guidance text stale fails here, not silently on the
 * VPS three days later.
 */

import { describe, it, expect } from "vitest";
import { DISPATCHABLE_KINDS, renderIssueBody } from "../../../src/evolution/issue-body.js";
import { repoRoot } from "../../../src/evolution/repo-root.js";
import type { Finding, FindingKind } from "../../../src/evolution/types.js";
import { findAdapterSilent, findApplyLinkUnrecognised } from "../../../src/evolution/analyzers/jobhunt.js";
import { lintAgentBrief } from "../../../src/tools/agent-brief-lint.js";
import { checkoutFileExists } from "../../../src/tools/dispatch-brief-check.js";
import { NOW, healthy, postings, withSilent } from "../../helpers/jobhunt-fixtures.js";

const CONTEXT = {
  fingerprint: "a".repeat(64),
  commitSha: "1e797039",
  detectedAt: new Date("2026-09-29T09:00:00Z"),
};

/**
 * The two jobhunt kinds come from the analyzer itself rather than a hand-written literal, so the
 * body linted here is the one the 09:30 check would really file: ashby silent for 24h after a steady
 * baseline, and smartrecruiters with 14 of 40 new postings (35%) lacking a form link.
 */
const ADAPTER_SILENT = findAdapterSilent(withSilent("ashby"), NOW)[0]!;
const APPLY_LINK_UNRECOGNISED = findApplyLinkUnrecognised(
  healthy({
    newPostings: [
      ...postings("smartrecruiters", 14, { fromHoursAgo: 150, toHoursAgo: 2 }, { hasFormLink: false }),
      ...postings("smartrecruiters", 26, { fromHoursAgo: 150, toHoursAgo: 2 }, { hasFormLink: true }),
    ],
  }),
  NOW,
)[0]!;

/** One realistic finding per dispatchable kind. `location`s are files that exist in this checkout. */
const FINDINGS: Readonly<Partial<Record<FindingKind, Finding>>> = {
  "adapter-silent": ADAPTER_SILENT,
  "apply-link-unrecognised": APPLY_LINK_UNRECOGNISED,
  "unapplied-lesson": {
    kind: "unapplied-lesson",
    subject: "worker:email::ETIMEDOUT",
    evidence: "A resolved lesson for this signature has times_applied = 0 after 14 recurrences.",
    severity: "medium",
    location: "src/kernel/lessons.ts",
  },
  "recurring-failure": {
    kind: "recurring-failure",
    subject: "email",
    evidence: "email failed under 4 distinct signatures in the last 30 days.",
    severity: "high",
  },
  "unused-dependency": {
    kind: "unused-dependency",
    subject: "left-pad",
    evidence: "left-pad is declared in package.json and imported nowhere under src/.",
    severity: "low",
    location: "package.json",
  },
  "untested-module": {
    kind: "untested-module",
    subject: "src/tools/index.ts",
    evidence: "src/tools/index.ts has no test file that imports it.",
    severity: "medium",
    location: "src/tools/index.ts",
  },
};

describe("the self-audit issue body passes the brief lint", () => {
  it("covers every kind the loop is willing to dispatch, so a new kind cannot skip the lint", () => {
    expect(Object.keys(FINDINGS).sort()).toEqual([...DISPATCHABLE_KINDS].sort());
  });

  for (const [kind, finding] of Object.entries(FINDINGS) as Array<[FindingKind, Finding]>) {
    it(`${kind}: nine sections filled, and every cited file exists in this checkout`, async () => {
      const body = renderIssueBody(finding, CONTEXT);
      const verdict = await lintAgentBrief(body, checkoutFileExists(repoRoot()));

      expect(verdict).toMatchObject({ ok: true, missing: [], warnings: [] });
    });
  }

  it("would catch stale guidance: a finding pointing at a file that is gone fails the lint", async () => {
    // The proof that the assertions above are not vacuous.
    const stale = { ...(FINDINGS["untested-module"] as Finding), location: "src/tools/gone-since-the-audit.ts" };
    const verdict = await lintAgentBrief(renderIssueBody(stale, CONTEXT), checkoutFileExists(repoRoot()));

    expect(verdict.ok).toBe(false);
    expect(verdict.missingPaths).toEqual(["src/tools/gone-since-the-audit.ts"]);
  });
});
