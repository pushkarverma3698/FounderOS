/**
 * agent-dispatch hands pr-brain's NON-BLOCKING findings to the executor once — deploy/agent-dispatch (Pass B).
 * =========================================================================================================
 * Only a FAIL sent the executor back. On PR #803 a PASS review named real defects as non-blockers (an unrelated
 * 24-line header comment deleted, no-CI counted as green, no comment pagination) and nobody acted on them.
 *
 * The review comment carries the typed verdict (src/tools/review-verdict.ts): a fenced json block with
 * decision APPROVE and findings of severity major or minor. Pass B reads that block, not prose. Pinned from the
 * outside: one follow-up pass per PR, stamped `nonblockers-sent:<head>`, counted toward the 3-attempt cap,
 * never run on red CI or a non-PASS review, and never able to turn a PASS into a block.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DispatchSandbox } from "./dispatch-sandbox.js";

const REPO = "owner/founderos";
const BRANCH = "task/issue-713-fix-needs-a-second-pass";
const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);

const MINOR = { severity: "minor", file: "src/a.ts", line: 3, claim: "deleted an unrelated header comment", evidence: "diff hunk @@ -1,24" } as const;
const MAJOR = { severity: "major", claim: "no comment pagination", evidence: "gh api call has no --paginate" } as const;
const BLOCKER = { severity: "blocker", claim: "breaks the build", evidence: "tsc output" } as const;

const reviewComment = (decision: string, findings: readonly object[], head = HEAD): string =>
  `Review of the PR.\n\n\`\`\`json\n${JSON.stringify({ version: 1, head_sha: head, decision, findings })}\n\`\`\`\n`;
const stamp = (head = HEAD): string => `<!-- brain-reviewed: ${head} -->`;

const FAIL = { name: "Unit + regression tests", bucket: "fail", state: "FAILURE" } as const;
const GREEN = { name: "Type check + lint + wiring", bucket: "pass", state: "SUCCESS" } as const;

let sb: DispatchSandbox;

const attempts = (): string[] => sb.prCommentsOf(56, REPO).filter((c) => c.startsWith("<!-- agent-attempt:"));
const sent = (): string[] => sb.prCommentsOf(56, REPO).filter((c) => c.includes("nonblockers-sent:"));

function readyPr(comments: readonly string[], checks: readonly { name: string; bucket: "pass" | "fail" | "pending"; state?: string }[] = [GREEN]): void {
  sb.addPr({ number: 56, headRefName: BRANCH, headRefOid: HEAD, isDraft: false, comments, checks });
}

beforeEach(() => {
  sb = new DispatchSandbox([REPO]);
  sb.ensureRemoteBranch(REPO, BRANCH);
  sb.addIssue({ number: 713, title: "fix: needs a second pass", labels: ["agent:review"], comments: [] });
});

afterEach(() => {
  sb.destroy();
});

describe("a PASS review that listed non-blocking findings", () => {
  it("sends the executor back ONCE, to fix only the listed items, and counts the attempt", () => {
    readyPr([reviewComment("APPROVE", [MINOR, MAJOR]), stamp()]);

    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(1);
    const prompt = sb.agyPrompts()[0] ?? "";
    expect(prompt).toMatch(/PASSED/);
    expect(prompt).toMatch(/NON-BLOCKING/);
    expect(prompt).toMatch(/Fix ONLY/);
    expect(prompt).toMatch(/no scope creep/i);
    expect(prompt).not.toContain("deleted an unrelated header comment"); // Pass B forwards no review text
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]).toMatch(/non-blocking/i);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain(`nonblockers-sent:${HEAD}`);
  });

  it("never loops: the next tick runs nothing", () => {
    readyPr([reviewComment("APPROVE", [MINOR]), stamp()]);

    sb.tick({ agyOut: "done", agyRc: 0 });
    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(1);
  });

  it("is once per PR, not once per head: a marker from an earlier head also stops it", () => {
    readyPr([reviewComment("APPROVE", [MINOR]), stamp(), `<!-- agent-attempt: 1 -->\n<!-- nonblockers-sent:${OLD_HEAD} -->`]);

    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(0);
  });

  it("never changes the PASS: the issue keeps agent:review and the PR stays ready", () => {
    readyPr([reviewComment("APPROVE", [MINOR]), stamp()]);

    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.labelsOf(713, REPO)).toEqual(["agent:review"]);
    expect(sb.prs(REPO)[0]?.isDraft).toBe(false);
  });

  it("at the attempt cap it stays quiet: no run, and NOT agent:blocked (a PASS is not a block)", () => {
    readyPr([reviewComment("APPROVE", [MINOR]), stamp(), "<!-- agent-attempt: 3 -->"]);

    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(0);
    expect(sb.labelsOf(713, REPO)).toEqual(["agent:review"]);
    expect(sb.messages().join("\n")).not.toMatch(/attempt bound/);
  });

  it("counts toward the cap: attempt 1 already used makes this attempt 2", () => {
    readyPr([reviewComment("APPROVE", [MINOR]), stamp(), "<!-- agent-attempt: 1 -->"]);

    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(attempts().some((c) => c.startsWith("<!-- agent-attempt: 2"))).toBe(true);
  });

  it("a wall (rejected login) is not a sent pass: no marker, no attempt, retried later", () => {
    readyPr([reviewComment("APPROVE", [MINOR]), stamp()]);

    sb.tick({ agyOut: "Error: 403 PERMISSION_DENIED: The caller does not have permission" });

    expect(sent()).toHaveLength(0);
    expect(attempts()).toHaveLength(0);
  });

  it("--dry-run says it would, and runs nothing", () => {
    readyPr([reviewComment("APPROVE", [MINOR]), stamp()]);

    sb.tick({ args: ["--dry-run"] });

    expect(sb.agyRuns()).toBe(0);
    expect(sent()).toHaveLength(0);
    expect(sb.log()).toMatch(/DRY RUN would send the non-blocking findings of PR #56/);
  });
});

describe("it does not run when", () => {
  it("required CI is red (that is the CI-failure path's business, not a polish pass)", () => {
    readyPr([reviewComment("APPROVE", [MINOR]), stamp()], [FAIL]);

    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it("the review was not a PASS (typed decision REQUEST_CHANGES)", () => {
    readyPr([reviewComment("REQUEST_CHANGES", [MINOR]), stamp()]);
    sb.tick({ agyOut: "done", agyRc: 0 });
    expect(sb.agyRuns()).toBe(0);
  });

  it("the typed APPROVE contradicts itself by carrying a blocker", () => {
    readyPr([reviewComment("APPROVE", [BLOCKER, MINOR]), stamp()]);
    sb.tick({ agyOut: "done", agyRc: 0 });
    expect(sb.agyRuns()).toBe(0);
  });

  it("the verdict names a different head than the one now on the PR", () => {
    readyPr([reviewComment("APPROVE", [MINOR], OLD_HEAD), stamp()]);
    sb.tick({ agyOut: "done", agyRc: 0 });
    expect(sb.agyRuns()).toBe(0);
  });

  it("the head was never reviewed (no brain-reviewed marker for it)", () => {
    readyPr([reviewComment("APPROVE", [MINOR])]);
    sb.tick({ agyOut: "done", agyRc: 0 });
    expect(sb.agyRuns()).toBe(0);
  });

  it("there are no non-blocking findings, or no typed block at all (prose is never parsed)", () => {
    readyPr([reviewComment("APPROVE", []), "Looks fine. Non-blockers: the header comment was deleted.", stamp()]);
    sb.tick({ agyOut: "done", agyRc: 0 });
    expect(sb.agyRuns()).toBe(0);
  });

  it("the block is not valid JSON", () => {
    readyPr(["```json\n{not json\n```", stamp()]);
    sb.tick({ agyOut: "done", agyRc: 0 });
    expect(sb.agyRuns()).toBe(0);
  });
});
