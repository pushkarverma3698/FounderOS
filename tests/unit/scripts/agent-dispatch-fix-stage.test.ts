/**
 * `agent-dispatch --issue N --stage fix` — the founder's "fix it" on a blocked PR runs NOW, on the same branch.
 * ===========================================================================================================
 * Live trace, Oplify #115 / PR #116, 2026-10-09: pr-brain blocked the PR with two blockers. The founder said
 * "dispatch agy to fix the issues in the same branch". The bot answered "already working" (false) and the
 * fix waited for the next 15-minute cron tick, which then sent the executor to fix one blocker and miss the other.
 *
 * A fix job is the cron's re-dispatch, run for ONE issue, immediately, with two differences: the founder's
 * decision lifts the 3-attempt cap, and it refuses a head the founder never saw (the sha rides on the request).
 * It runs under the same dispatch lock as the cron, so the two can never fix the same PR at once.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DispatchSandbox } from "./dispatch-sandbox.js";

const REPO = "owner/oplify";
const BRANCH = "task/issue-115-account-enumeration";
const HEAD = "c".repeat(40);
const OLD_HEAD = "d".repeat(40);

const B1 = {
  severity: "blocker",
  file: "test/auth-flows.test.js",
  line: 244,
  claim: "The test expects status 404 but the route returns 401",
  evidence: "pnpm test fails: 401 !== 404",
} as const;
const B2 = {
  severity: "blocker",
  file: "tests/unit/account-enumeration.test.ts",
  claim: "A vitest test file in a repo that runs node --test",
  evidence: "package.json test script is node --test",
} as const;
const NOTE = { severity: "minor", claim: "rename a variable", evidence: "style" } as const;

const verdict = (findings: readonly object[], head = HEAD, decision = "REQUEST_CHANGES"): string =>
  `Review.\n\n\`\`\`json\n${JSON.stringify({ version: 1, head_sha: head, decision, findings })}\n\`\`\`\n`;
const stamp = (head = HEAD): string => `<!-- brain-reviewed: ${head} -->`;
const GREEN = { name: "Type check + lint + wiring", bucket: "pass", state: "SUCCESS" } as const;

let sb: DispatchSandbox;

const attempts = (): string[] => sb.prCommentsOf(116, REPO).filter((c) => c.startsWith("<!-- agent-attempt:"));
const fixArgs = (head: string | null = HEAD): string[] => [
  "--issue", "115", "--repo", REPO, "--stage", "fix", ...(head ? ["--head", head] : []),
];

function blockedPr(extra: readonly string[] = [], over: { isDraft?: boolean; head?: string } = {}): void {
  sb.addPr({
    number: 116,
    headRefName: BRANCH,
    headRefOid: over.head ?? HEAD,
    isDraft: over.isDraft ?? true,
    comments: [verdict([B1, B2, NOTE]), stamp(), ...extra],
    checks: [GREEN],
  });
}

beforeEach(() => {
  sb = new DispatchSandbox([REPO]);
  sb.ensureRemoteBranch(REPO, BRANCH);
  sb.addIssue({ number: 115, title: "fix: account enumeration", labels: ["agent:review"], comments: ["<!-- agent-pr: 116 -->"] });
});

afterEach(() => {
  sb.destroy();
});

describe("a founder-requested fix on a blocked PR", () => {
  it("runs now on the PR's own branch and hands the executor EVERY blocker verbatim", () => {
    blockedPr();

    const r = sb.tick({ args: fixArgs(), agyOut: "done", agyRc: 0 });

    expect(r.status).toBe(0);
    expect(sb.agyRuns()).toBe(1);
    const prompt = sb.agyPrompts()[0] ?? "";
    expect(prompt).toContain(BRANCH);
    expect(prompt).toContain("test/auth-flows.test.js:244");
    expect(prompt).toContain("The test expects status 404 but the route returns 401");
    expect(prompt).toContain("tests/unit/account-enumeration.test.ts");
    expect(prompt).toContain("A vitest test file in a repo that runs node --test");
    expect(prompt).toMatch(/every blocker/i);
    expect(prompt).not.toContain("rename a variable"); // a minor note is not a blocker
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]).toMatch(/^<!-- agent-attempt: 1/);
  });

  it("is not stopped by the 3-attempt cap: the founder decided, the label returns to agent:review", () => {
    sb.addIssue({ number: 115, title: "t", labels: ["agent:blocked"], comments: ["<!-- agent-pr: 116 -->"] });
    blockedPr(["<!-- agent-attempt: 3 -->"]);

    sb.tick({ args: fixArgs(), agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(1);
    expect(attempts().some((c) => c.startsWith("<!-- agent-attempt: 4"))).toBe(true);
    expect(sb.labelsOf(115, REPO)).toEqual(["agent:review"]);
  });

  it("refuses a head the founder never saw: the PR moved, so nothing runs and he is told", () => {
    blockedPr([], { head: OLD_HEAD });
    // the request was made against HEAD; the PR is now at OLD_HEAD

    sb.tick({ args: fixArgs(HEAD), agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(0);
    expect(attempts()).toHaveLength(0);
    expect(sb.messages().join("\n")).toMatch(/moved|changed/i);
  });

  it("does nothing, and says why, when pr-brain has not reviewed this head yet", () => {
    sb.addPr({ number: 116, headRefName: BRANCH, headRefOid: HEAD, isDraft: true, comments: [], checks: [GREEN] });

    sb.tick({ args: fixArgs(), agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(0);
    expect(sb.messages().join("\n")).toMatch(/has not reviewed/i);
  });

  it("does nothing on a PR that is already cleared (not a draft)", () => {
    blockedPr([], { isDraft: false });

    sb.tick({ args: fixArgs(), agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(0);
    expect(sb.messages().join("\n")).toMatch(/cleared|not a draft/i);
  });

  it("touches only the named issue: another reviewed draft in the repo is left for the cron", () => {
    blockedPr();
    sb.addIssue({ number: 120, title: "other", labels: ["agent:review"], comments: ["<!-- agent-pr: 121 -->"] });
    sb.addPr({
      number: 121, headRefName: "task/issue-120-other", headRefOid: "e".repeat(40), isDraft: true,
      comments: [verdict([B1], "e".repeat(40)), stamp("e".repeat(40))], checks: [GREEN],
    });
    sb.ensureRemoteBranch(REPO, "task/issue-120-other");

    sb.tick({ args: fixArgs(), agyOut: "done", agyRc: 0 });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.prCommentsOf(121, REPO).filter((c) => c.startsWith("<!-- agent-attempt:"))).toHaveLength(0);
  });

  it("claims nothing and drafts no spec: it is a fix, not a build or a spec run", () => {
    blockedPr();
    sb.addIssue({ number: 130, title: "ready one", labels: ["agent:ready"], comments: [] });

    sb.tick({ args: fixArgs(), agyOut: "done", agyRc: 0 });

    expect(sb.labelsOf(130, REPO)).toEqual(["agent:ready"]);
    expect(sb.agyRuns()).toBe(1);
  });

  it("needs --repo and an issue", () => {
    const noRepo = sb.tick({ args: ["--issue", "115", "--stage", "fix", "--head", HEAD] });
    expect(noRepo.status).toBe(2);
    expect(noRepo.stderr).toMatch(/--repo/);
  });

  it("--head is only valid with --stage fix", () => {
    const r = sb.tick({ args: ["--issue", "115", "--repo", REPO, "--stage", "build", "--head", HEAD] });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--head/);
  });
});

describe("the cron's own re-dispatch carries the blockers too", () => {
  it("lists every blocker, with file and line, instead of telling the executor to go and read the PR", () => {
    blockedPr();

    sb.tick({ agyOut: "done", agyRc: 0 });

    const prompt = sb.agyPrompts()[0] ?? "";
    expect(prompt).toContain("test/auth-flows.test.js:244");
    expect(prompt).toContain("A vitest test file in a repo that runs node --test");
  });
});
