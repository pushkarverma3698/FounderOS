import { describe, expect, it } from "vitest";
import { requiredCiVerdict, reviewDecisionOf } from "../../../src/tools/pipeline-evidence-card.js";

const HEAD = "c".repeat(40);

describe("reviewDecisionOf (pr-brain's own verdict text)", () => {
  it("maps only the two clear states and treats everything else as UNKNOWN", () => {
    expect(reviewDecisionOf("CLEARED — marked ready")).toBe("APPROVE");
    expect(reviewDecisionOf("  APPROVED")).toBe("APPROVE");
    expect(reviewDecisionOf("CHANGES REQUESTED — blocked")).toBe("REQUEST_CHANGES");
    expect(reviewDecisionOf("left as draft")).toBe("UNKNOWN");
    expect(reviewDecisionOf("")).toBe("UNKNOWN");
  });

  it("does not take a verdict that merely mentions CLEARED later in the text", () => {
    expect(reviewDecisionOf("unknown — was CLEARED before")).toBe("UNKNOWN");
  });
});

describe("requiredCiVerdict (gh pr checks --required --json bucket,name)", () => {
  const run = (checks: unknown): ReturnType<typeof requiredCiVerdict> => requiredCiVerdict(JSON.stringify(checks), HEAD);

  it("every required check passed or skipped: PASS for this head", () => {
    expect(run([{ bucket: "pass", name: "test" }, { bucket: "skipping", name: "lint" }])).toEqual({ status: "PASS", reasons: [], head_sha: HEAD });
  });

  it("a failed required check is FAIL and names it", () => {
    const v = run([{ bucket: "pass", name: "lint" }, { bucket: "fail", name: "test" }, { bucket: "fail", name: "test" }]);
    expect(v.status).toBe("FAIL");
    expect(v.reasons).toEqual(["required check failed: test"]);
  });

  it("a running or cancelled check is UNKNOWN, never PASS", () => {
    expect(run([{ bucket: "pass", name: "lint" }, { bucket: "pending", name: "test" }]).status).toBe("UNKNOWN");
    expect(run([{ bucket: "cancel", name: "test" }]).reasons[0]).toContain("test");
  });

  it("no required checks, gh's sentence, or garbage is UNKNOWN with the reason", () => {
    expect(run([]).reasons[0]).toContain("no required checks");
    expect(requiredCiVerdict("no required checks reported on the 'x' branch", HEAD).status).toBe("UNKNOWN");
    expect(run({ bucket: "pass" }).status).toBe("UNKNOWN");
    expect(run([{ bucket: "PASS", name: "x" }]).status).toBe("UNKNOWN");
  });
});
