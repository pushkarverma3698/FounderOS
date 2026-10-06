import { describe, expect, it } from "vitest";
import { contractFixture, SHA_A, SHA_B } from "../../helpers/contract-fixture.js";
import { notVerifiedFor, readVerdict, reviewDecisionOf } from "../../../src/tools/pipeline-evidence-card.js";

describe("reviewDecisionOf (pr-brain's own verdict text)", () => {
  it("maps only the two clear states and treats everything else as UNKNOWN", () => {
    expect(reviewDecisionOf("CLEARED — marked ready for merge (self-approval impossible; ready IS the pass) · t")).toBe("APPROVE");
    expect(reviewDecisionOf("APPROVED · t")).toBe("APPROVE");
    expect(reviewDecisionOf("CHANGES REQUESTED — blocked · t")).toBe("REQUEST_CHANGES");
    expect(reviewDecisionOf("REVIEWED, left as draft — not cleared · t")).toBe("UNKNOWN");
    expect(reviewDecisionOf("unknown — could not read PR state")).toBe("UNKNOWN");
    expect(reviewDecisionOf("")).toBe("UNKNOWN");
  });

  it("does not take a verdict that merely mentions CLEARED later in the text", () => {
    expect(reviewDecisionOf("REVIEWED, left as draft — not cleared · CLEARED the cache")).toBe("UNKNOWN");
  });
});

describe("notVerifiedFor", () => {
  it("a unit-only oracle means nothing checks the change on prod: that is listed", () => {
    const out = notVerifiedFor(contractFixture());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/o1/);
    expect(out[0]).toMatch(/unit-only/);
  });

  it("an http or telegram oracle is checked after deploy, so it adds nothing here", () => {
    expect(notVerifiedFor(contractFixture({ oracle: { id: "o2", kind: "http", target: "https://x.test/h", before: {}, expected_after: {} } }))).toEqual([]);
    expect(notVerifiedFor(contractFixture({ oracle: { id: "o3", kind: "telegram", before: {}, expected_after: {} } }))).toEqual([]);
  });
});

describe("readVerdict", () => {
  it("passes a PASS for this head through unchanged", () => {
    expect(readVerdict({ status: "PASS", reasons: [], head_sha: SHA_B, mode: "green" }, SHA_B)).toEqual({ status: "PASS", reasons: [], head_sha: SHA_B });
  });

  it("a PASS computed for another head is UNKNOWN, with the reason", () => {
    const v = readVerdict({ status: "PASS", reasons: [], head_sha: SHA_A }, SHA_B);
    expect(v.status).toBe("UNKNOWN");
    expect(v.reasons.join(" ")).toMatch(/head/);
    expect(v.head_sha).toBe(SHA_B);
  });

  it("anything that is not exactly PASS or FAIL is UNKNOWN, never PASS", () => {
    for (const bad of [null, undefined, "PASS", 7, [], {}, { status: "pass" }, { status: "OK", reasons: [] }]) {
      expect(readVerdict(bad, SHA_B).status).toBe("UNKNOWN");
    }
  });

  it("keeps a FAIL and its reasons", () => {
    const v = readVerdict({ status: "FAIL", reasons: ["locked test edited"], head_sha: SHA_B }, SHA_B);
    expect(v).toEqual({ status: "FAIL", reasons: ["locked test edited"], head_sha: SHA_B });
  });

  it("a PASS that carries reasons is inconsistent, so UNKNOWN", () => {
    expect(readVerdict({ status: "PASS", reasons: ["hm"], head_sha: SHA_B }, SHA_B).status).toBe("UNKNOWN");
  });
});
