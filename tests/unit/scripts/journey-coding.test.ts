import { describe, expect, it } from "vitest";
import { judgeCoding, sandboxBrief } from "../../../scripts/lib/journey-coding.js";
import { AGENT_BRIEF_HEADINGS } from "../../../src/tools/agent-brief-parse.js";

const base = { prBranch: undefined, checks: [], labels: ["agent:ready"], waitedMin: 5, limitMin: 45 };

describe("judgeCoding (golden journey A)", () => {
  it("keeps waiting while nothing has happened", () => expect(judgeCoding(base).done).toBe(false));
  it("keeps waiting while CI is running", () => {
    expect(judgeCoding({ ...base, prBranch: "task/issue-9-x", checks: [null, "success"] }).done).toBe(false);
  });
  it("passes on a PR with green CI", () => {
    const r = judgeCoding({ ...base, prBranch: "task/issue-9-x", checks: ["success", "success"] });
    expect(r).toMatchObject({ done: true, ok: true });
  });
  it("fails on a PR with red CI", () => {
    const r = judgeCoding({ ...base, prBranch: "task/issue-9-x", checks: ["failure"] });
    expect(r).toMatchObject({ done: true, ok: false });
    expect(r.detail).toContain("failure");
  });
  it("fails early when the issue is failed with no PR", () => {
    const r = judgeCoding({ ...base, labels: ["agent:failed"] });
    expect(r).toMatchObject({ done: true, ok: false });
    expect(r.detail).toContain("agent:failed");
  });
  it("fails at the time limit", () => {
    expect(judgeCoding({ ...base, waitedMin: 45 })).toMatchObject({ done: true, ok: false });
  });
});

describe("sandboxBrief", () => {
  it("has all nine headings with content", () => {
    const b = sandboxBrief("t");
    for (const h of AGENT_BRIEF_HEADINGS) expect(b).toMatch(new RegExp(`## ${h.replace("/", "\\/")}\\n\\S`));
  });
});
