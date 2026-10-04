/**
 * agent-dispatch's task branch name never ends in a hyphen — deploy/agent-dispatch (slugify).
 * =========================================================================================
 * Measured 2026-10-03: #831 was claimed as `task/issue-831-ag-020-job-brief-commands-hit-the-right-`
 * (slugify cut the slug at 40 characters, mid-word boundary, leaving the hyphen). The executor opened
 * PR #834 from `task/issue-831-ag-020-job-brief-commands-hit-the-right`. The dispatcher looked up
 * `--head` with the hyphenated name, found nothing, and labelled #831 agent:failed ("pr=none, commits=0")
 * eight minutes after a good PR existed.
 *
 * The hook below does what that executor did: it drops a trailing hyphen from the branch name before
 * opening the PR. Once the daemon never builds such a name, the hook has nothing to trim and the lookup matches.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DispatchSandbox } from "./dispatch-sandbox.js";

/** slugify("AG-020 job brief commands hit the right thing") is "ag-020-job-brief-commands-hit-the-right-thing"; cut -c1-40 ends at "…-right-". */
const TITLE = "AG-020 job brief commands hit the right thing";

/** The executor's work, as seen on 2026-10-03: commit, rename the branch without its trailing hyphen, open the PR from that. */
const TRIM_AND_OPEN_A_PR =
  'b="$(git branch --show-current)"; t="${b%-}"; ' +
  '[ "$t" = "$b" ] || git branch -m "$b" "$t"; ' +
  'git -c user.name=t -c user.email=t@t commit --allow-empty -q -m work && ' +
  'gh pr create --repo owner/founderos --head "$(git branch --show-current)" --title t --body b >/dev/null';

let sb: DispatchSandbox;

beforeEach(() => {
  sb = new DispatchSandbox(["owner/founderos"]);
  sb.addIssue({ number: 831, title: TITLE });
});

afterEach(() => {
  sb.destroy();
});

describe("a title whose 40-character slug ends on a word boundary", () => {
  it("is claimed on a branch with no trailing hyphen", () => {
    sb.tick({ agyOut: "done", agyRc: 0, agyHook: TRIM_AND_OPEN_A_PR });

    const claim = sb.commentsOf(831).find((c) => c.includes("Claimed by agent-dispatch")) ?? "";
    const named = /Branch: `([^`]+)`/.exec(claim)?.[1];
    expect(named).toBe("task/issue-831-ag-020-job-brief-commands-hit-the-right");
    expect(sb.agyPrompts().join("\n")).toContain("You are already on branch task/issue-831-ag-020-job-brief-commands-hit-the-right,");
  });

  it("hands the PR the executor opened to review instead of marking the issue agent:failed", () => {
    sb.tick({ agyOut: "done", agyRc: 0, agyHook: TRIM_AND_OPEN_A_PR });

    expect(sb.prs()).toHaveLength(1);
    expect(sb.prs()[0]?.headRefName).toBe("task/issue-831-ag-020-job-brief-commands-hit-the-right");
    expect(sb.labelsOf(831)).toEqual(expect.arrayContaining(["agent:review"]));
    expect(sb.labelsOf(831)).not.toContain("agent:failed");
    expect(sb.ghLog()).not.toMatch(/pr=none/);
  });
});
