/**
 * Agent guards — deploy/lib/agent-guard.sh, wired into deploy/agent-dispatch and deploy/vps-daemons/pr-brain.
 * ============================================================================================================
 * Oplify, 2026-10-11: issues #115, #117 and #119 were the same bug (sign-in tells you whether an email exists). Three agents
 * each branched for it (task/issue-115, -117, -119), one PR (#118) was titled for a module it no longer contained, and
 * #120 fixed billing under an issue about sign-in. Nothing stopped a PR being aimed at the production branch either.
 *
 * What is pinned here, from the outside, against the real scripts:
 *   - ONE AGENT PER ISSUE: a dispatch is refused (issue -> agent:failed, one comment, one message, no agent run) when the
 *     issue has an open task PR, or its brief points at an issue an agent holds (open PR, remote task branch, or
 *     agent:working / agent:review). A hand run (`--issue N`) lifts the referenced-issue check.
 *   - AFTER A RUN: the PR is retargeted to the integration branch, put back to draft, and a merged PR fails the issue.
 *   - PRODUCTION is never a target: pr-brain does not mark a cleared agent PR into production ready.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DispatchSandbox, goodBrief } from "./dispatch-sandbox.js";

const REPO = "owner/oplify-messaging-api";
const LIB = fileURLToPath(new URL("../../../deploy/lib/agent-guard.sh", import.meta.url));

const bash = (script: string, input = ""): { status: number | null; stdout: string } => {
  const r = spawnSync("bash", ["-c", `source ${LIB}\n${script}`], { input, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout.trim() };
};

describe("guard_forbidden_base", () => {
  it.each([
    ["production", 0],
    ["prod", 0],
    ["beta", 1],
    ["main", 1],
    ["task/issue-1", 1],
  ])("%s -> exit %i", (branch, status) => {
    expect(bash(`guard_forbidden_base ${branch}`).status).toBe(status);
  });
});

describe("guard_issue_refs", () => {
  const refs = (body: string): string => bash("guard_issue_refs", body).stdout.replace(/\n/g, ",");
  it("lists each #N once, in number order", () => expect(refs("see #119, #117 and #119 again")).toBe("117,119"));
  it("ignores comments, fenced code and other repos' links", () => {
    expect(refs("<!-- #5 -->\n```\nfoo #6\n```\nowner/other#7 and https://x/pull/8 but #9")).toBe("9");
  });
  it("an anchor or a hex colour is not a reference", () => expect(refs("page#top and #fff")).toBe(""));
});

describe("one agent per issue (the #115 / #117 / #119 case)", () => {
  let sb: DispatchSandbox;
  const refused = () => sb.messages().filter((m) => /not started/.test(m));

  beforeEach(() => {
    sb = new DispatchSandbox([REPO]);
    sb.addBetaBranch(REPO);
    // Real state of OplifyMessage/oplify-messaging-api on 2026-10-11: three task branches, PR #116 and #118 closed, #120 open.
    sb.addRemoteBranches(REPO, ["task/issue-115-sign-in-enum", "task/issue-117", "task/issue-119"]);
    sb.addPr({ number: 120, headRefName: "task/issue-119", baseRefName: "beta" });
    sb.addPr({ number: 118, headRefName: "task/issue-117", baseRefName: "beta", state: "CLOSED" });
  });
  afterEach(() => sb.destroy());

  it("refuses #119 when its brief points at #115, which already has a branch", () => {
    sb.addIssue({ number: 119, body: `${goodBrief()}\nSame bug as #115.` });
    sb.addIssue({ number: 115, labels: ["agent:review"] });

    sb.tick({ agyOut: "should never run" });

    expect(sb.agyRuns()).toBe(0);
    expect(sb.labelsOf(119)).toEqual(expect.arrayContaining(["agent:failed"]));
    expect(sb.labelsOf(119)).not.toContain("agent:working");
    expect(sb.commentsOf(119).join("\n")).toMatch(/One agent per issue/);
    expect(sb.commentsOf(119).join("\n")).toMatch(/#115/);
    expect(refused()).toHaveLength(1);
  });

  it("refuses an issue that already has its own open task PR", () => {
    sb.addIssue({ number: 119 });

    sb.tick({ agyOut: "should never run" });

    expect(sb.agyRuns()).toBe(0);
    expect(sb.commentsOf(119).join("\n")).toMatch(/#119 already has open PR #120/);
  });

  it("refuses when the referenced issue only carries agent:working", () => {
    sb.addIssue({ number: 130, body: `${goodBrief()}\nBuilds on #131.` });
    sb.addIssue({ number: 131, labels: ["agent:working"] });

    sb.tick({ agyOut: "should never run" });

    expect(sb.agyRuns()).toBe(0);
    expect(sb.commentsOf(130).join("\n")).toMatch(/#131, which is agent:working/);
  });

  it("does not refuse an issue whose only history is its own leftover branch and a closed PR", () => {
    sb.addIssue({ number: 117 });

    sb.tick({ agyOut: "ran" });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.commentsOf(117).join("\n")).not.toMatch(/One agent per issue/);
  });

  it("a hand run with --issue lifts the referenced-issue check, but not the issue's own open PR", () => {
    sb.addIssue({ number: 140, body: `${goodBrief()}\nFollow-up to #115.` });
    sb.addIssue({ number: 119 });

    sb.tick({ agyOut: "ran", args: ["--issue", "140"] });
    expect(sb.agyRuns()).toBe(1);

    sb.tick({ agyOut: "should never run", args: ["--issue", "119"] });
    expect(sb.agyRuns()).toBe(1);
    expect(sb.commentsOf(119).join("\n")).toMatch(/#119 already has open PR #120/);
  });

  it("when GitHub cannot be read the issue is skipped untouched, not claimed and not refused", () => {
    sb.addIssue({ number: 150, body: `${goodBrief()}\nRelated to #115.` });
    sb.patchGh({ failApi: true });

    sb.tick({ agyOut: "should never run" });

    expect(sb.agyRuns()).toBe(0);
    expect(sb.labelsOf(150)).toEqual(["agent:ready"]);
    expect(sb.commentsOf(150)).toEqual([]);
  });
});

describe("the PR after a run", () => {
  let sb: DispatchSandbox;
  const OPEN_PR = (base: string): string =>
    `git -c user.name=t -c user.email=t@t commit --allow-empty -q -m work && gh pr create --repo ${REPO} --head "$(git branch --show-current)" --base ${base} --title t --body b >/dev/null`;

  beforeEach(() => {
    sb = new DispatchSandbox([REPO]);
    sb.addBetaBranch(REPO);
  });
  afterEach(() => sb.destroy());

  it("a PR the agent aimed at production is retargeted to beta and the issue still goes to review", () => {
    sb.addIssue({ number: 200 });

    sb.tick({ agyOut: "done", agyHook: OPEN_PR("production") });

    expect(sb.prs()[0]?.baseRefName).toBe("beta");
    expect(sb.labelsOf(200)).toContain("agent:review");
    expect(sb.commentsOf(200).join("\n")).toMatch(/aimed at production \(forbidden\); retargeting to beta/);
  });

  it("a PR already on beta is left alone and no correction is posted", () => {
    sb.addIssue({ number: 201 });

    sb.tick({ agyOut: "done", agyHook: OPEN_PR("beta") });

    expect(sb.prs()[0]?.baseRefName).toBe("beta");
    expect(sb.commentsOf(201).join("\n")).not.toMatch(/corrected/);
  });

  it("the prompt tells the agent the rules the checks enforce", () => {
    sb.addIssue({ number: 202 });
    sb.tick({ agyOut: "done", agyHook: OPEN_PR("beta") });
    const prompt = sb.agyPrompts().join("\n");
    expect(prompt).toMatch(/Fixes #202/);
    expect(prompt).toMatch(/Never merge, approve or mark a PR ready/);
    expect(prompt).toMatch(/never target\s+production/);
  });
});

describe("guard_after_pr, directly", () => {
  const run = (info: string, editOk: boolean) =>
    bash(
      `REPO=o/r
       gh() { case "$1 $2" in
         "pr view") echo '${info}' ;;
         "pr edit") ${editOk ? "return 0" : "return 1"} ;;
         "pr ready") echo "ready $*" >&2 ;;
       esac; }
       guard_after_pr 7 beta; echo "rc=$?"`,
    );

  it("merged PR -> exit 2", () => expect(run('{"state":"MERGED","baseRefName":"beta","isDraft":false}', true).stdout).toMatch(/MERGED[\s\S]*rc=2/));
  it("wrong base and the retarget fails -> exit 1", () =>
    expect(run('{"state":"OPEN","baseRefName":"production","isDraft":true}', false).stdout).toMatch(/could not retarget[\s\S]*rc=1/));
  it("correct base, draft -> silent exit 0", () => expect(run('{"state":"OPEN","baseRefName":"beta","isDraft":true}', true).stdout).toBe("rc=0"));
  it("ready PR is put back to draft", () => expect(run('{"state":"OPEN","baseRefName":"beta","isDraft":false}', true).stdout).toMatch(/put back to draft[\s\S]*rc=0/));
});

describe("pr-brain never marks an agent PR into production ready", () => {
  const src = readFileSync(fileURLToPath(new URL("../../../deploy/vps-daemons/pr-brain", import.meta.url)), "utf8");
  const fn = src.slice(src.indexOf("merge_cleared() {"), src.indexOf("# Every gate is a full Claude session"));

  it("checks the base before the employer-org branch that calls `gh pr ready`", () => {
    const prod = fn.indexOf('"$base" == "production"');
    const ready = fn.indexOf("gh pr ready");
    expect(prod).toBeGreaterThan(-1);
    expect(prod).toBeLessThan(ready);
  });

  it("the guard lib is in the dispatcher's source list", () => {
    expect(readFileSync(fileURLToPath(new URL("../../../deploy/agent-dispatch", import.meta.url)), "utf8")).toMatch(/pr-moves\.sh agent-guard\.sh; do/);
  });
});
