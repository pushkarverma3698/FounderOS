/**
 * verify:branch is the pre-push hook since #1115 (scripts/install-hooks.sh). The dispatcher pushes Pipeline V2 work on
 * `task/issue-<N>` with no slug (deploy/agent-dispatch: `branch="task/issue-${issue}"`), so a rule that rejects that name
 * would stop every approved-spec run at its first push.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "verify-branch-name.sh");

function verify(branch: string): { code: number | null; out: string } {
  const r = spawnSync("bash", [SCRIPT], { env: { ...process.env, GITHUB_HEAD_REF: branch }, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe("verify-branch-name.sh", () => {
  it("accepts the dispatcher's Pipeline V2 branch, task/issue-<N> with no slug", () => {
    expect(verify("task/issue-119")).toMatchObject({ code: 0 });
  });

  it("still accepts the slugged dispatcher branch and the human shapes", () => {
    expect(verify("task/issue-710-test-docs").code).toBe(0);
    expect(verify("fix/locked-test-rule").code).toBe(0);
    expect(verify("antigravity/fix-agent-hallucinations").code).toBe(0);
  });

  it("still rejects malformed names", () => {
    expect(verify("task/issue-").code).toBe(1);
    expect(verify("task/issue-abc").code).toBe(1);
    expect(verify("claude/sweet-pike-6b0c3c").code).toBe(1);
    expect(verify("wip").code).toBe(1);
  });
});
