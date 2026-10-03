/**
 * agent-dispatch sends the executor back when its PR's REQUIRED CI is red — deploy/agent-dispatch (Pass B).
 * =========================================================================================================
 * pr-brain no longer spends a review on a head whose required CI is red (tests/unit/scripts/pr-brain-review-spend.test.ts):
 * a review cannot clear it, and founderos#791 had been reviewed on four heads while "Unit + regression tests" failed.
 * That left a hole. Pass B only re-dispatched a draft that pr-brain had STAMPED, and a skipped head is never stamped,
 * so an executor whose PR fails its own checks would sit there for ever, unreviewed and unfixed.
 *
 * Pinned from the outside: the executor is run again, told it is a CI failure and not a review finding, the attempt
 * is counted (so the bound still ends it), and nothing happens for CI that is green, still running, not required,
 * or on a PR that is not a draft.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DispatchSandbox } from "./dispatch-sandbox.js";

const REPO = "owner/founderos";
const BRANCH = "task/issue-713-fix-needs-a-second-pass";
const HEAD = "a".repeat(40);

const FAIL = { name: "Unit + regression tests", bucket: "fail", state: "FAILURE" } as const;
const PASS = { name: "Type check + lint + wiring", bucket: "pass", state: "SUCCESS" } as const;
const RUNNING = { name: "Unit + regression tests", bucket: "pending", state: "IN_PROGRESS" } as const;
const STAGING_DEPLOY_FAILED = { name: "Deploy to EC2 Staging", bucket: "fail", state: "FAILURE", required: false } as const;

let sb: DispatchSandbox;

const attempts = (): string[] => sb.prCommentsOf(56, REPO).filter((c) => c.startsWith("<!-- agent-attempt:"));

function prWith(opts: { checks?: readonly { name: string; bucket: "pass" | "fail" | "pending"; state?: string; required?: boolean }[]; isDraft?: boolean; comments?: readonly string[] }): void {
  sb.addPr({
    number: 56,
    headRefName: BRANCH,
    headRefOid: HEAD,
    isDraft: opts.isDraft ?? true,
    comments: opts.comments ?? [],
    ...(opts.checks ? { checks: opts.checks } : {}),
  });
}

beforeEach(() => {
  sb = new DispatchSandbox([REPO]);
  sb.addIssue({ number: 710, title: "parked", labels: ["agent:working"] });
  sb.ensureRemoteBranch(REPO, BRANCH);
  sb.addIssue({ number: 713, title: "fix: needs a second pass", labels: ["agent:review"], comments: [] });
});

afterEach(() => {
  sb.destroy();
});

describe("a draft PR with a failing required check and no review", () => {
  it("sends Antigravity back, as a CI failure (not a review finding), and counts the attempt", () => {
    prWith({ checks: [FAIL, PASS] });

    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.agyPrompts()[0]).toMatch(/FAILING CI check, not a review finding/);
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]).toMatch(/CI failure/);
    expect(sb.log()).toMatch(/PR #56 required CI is red at aaaaaaaa \(Unit \+ regression tests\), so pr-brain spends no review on it — re-dispatching Antigravity \(attempt 1\)/);
  });

  it("is bounded like any other re-dispatch: at the attempt limit the issue is agent:blocked and a human is told", () => {
    prWith({ checks: [FAIL], comments: ["<!-- agent-attempt: 3 -->"] });

    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(0);
    expect(sb.labelsOf(713, REPO)).toContain("agent:blocked");
    expect(sb.messages().join("\n")).toMatch(/3-attempt bound/);
  });

  it("does nothing while Antigravity's login is rejected (a pause is not a failed attempt)", () => {
    prWith({ checks: [FAIL] });

    sb.tick({ agyOut: "Error: 403 PERMISSION_DENIED: The caller does not have permission" });

    expect(sb.agyRuns()).toBe(1); // it was sent back; the run hit the wall
    expect(attempts()).toHaveLength(0);
    expect(sb.labelsOf(713, REPO)).toEqual(["agent:review"]);
  });
});

describe("everything else is left alone (and costs nothing)", () => {
  it("CI still running: nothing yet, the check may pass", () => {
    prWith({ checks: [RUNNING, PASS] });

    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(0);
    expect(attempts()).toHaveLength(0);
  });

  it("CI green and not yet reviewed: pr-brain reviews it, agent-dispatch waits (as before)", () => {
    prWith({ checks: [PASS] });

    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(0);
  });

  it("no CI reported at all: as before", () => {
    prWith({});

    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(0);
  });

  it("a failing check that is NOT required (a staging deploy) is not a red PR: pr-brain reviews it, so this waits for the verdict", () => {
    prWith({ checks: [PASS, STAGING_DEPLOY_FAILED] });

    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(0);
  });

  it("a PR that is no longer a draft is not the executor's to fix", () => {
    prWith({ checks: [FAIL], isDraft: false });

    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(0);
  });

  it("a reviewed draft is re-dispatched exactly as before, red CI or not", () => {
    prWith({ checks: [PASS], comments: [`<!-- brain-reviewed: ${HEAD} -->`] });

    sb.tick({ agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.agyPrompts()[0]).toMatch(/reviewed by pr-brain \(the independent reviewer\)/);
    expect(sb.log()).toMatch(/PR #56 reviewed at aaaaaaaa and left draft — re-dispatching Antigravity \(attempt 1\)/);
  });

  it("--dry-run says it would, and runs nothing", () => {
    prWith({ checks: [FAIL] });

    sb.tick({ args: ["--dry-run"] });

    expect(sb.agyRuns()).toBe(0);
    expect(attempts()).toHaveLength(0);
    expect(sb.log()).toMatch(/DRY RUN would re-dispatch Antigravity for PR #56/);
  });
});
