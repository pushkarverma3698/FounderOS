/**
 * Founder-facing text boundary.
 *
 * Two guarantees, both regression-locked here:
 *   1. Absolute server paths never reach the founder — only the filename does.
 *   2. URLs, ratios and ordinary prose survive redaction untouched.
 *
 * Origin: the 2026-08-14 Reality Benchmark scored 22 of 24 replies as leaking,
 * on absolute artifact paths and the tool-name receipts block alone.
 */

import { describe, it, expect } from "vitest";
import { redactInternalPaths, founderReceiptsBlock, receiptsBlock } from "../../../src/kernel/index.js";
import type { StepResult, ToolReceipt } from "../../../src/kernel/contracts.js";

function receipt(tool: string): ToolReceipt {
  return {
    tool,
    at: "2026-08-14T05:00:00.000Z",
    args_hash: "a".repeat(64),
    result_digest: "b".repeat(64),
    ok: true,
  };
}

function okStep(step_id: string, receipts: ToolReceipt[]): StepResult {
  return {
    step_id,
    status: "ok",
    output: { done: true },
    tool_receipts: receipts,
  } as StepResult;
}

describe("redactInternalPaths", () => {
  it("replaces an absolute artifact path with just the filename", () => {
    const text = "I built the export at /home/founderos/Projects/founderos/artifacts/jobs_export.csv for you.";
    expect(redactInternalPaths(text)).toBe("I built the export at jobs_export.csv for you.");
  });

  it("redacts every path in a reply, not only the first", () => {
    const text = "Wrote /opt/founderos/artifacts/a.csv and /opt/founderos/artifacts/b.md.";
    const out = redactInternalPaths(text);
    expect(out).toContain("a.csv");
    expect(out).toContain("b.md");
    expect(out).not.toContain("/opt/founderos");
  });

  it("leaves https URLs completely intact", () => {
    const text = "See https://github.com/pushkarverma3698/FounderOS/pull/486 for the change.";
    expect(redactInternalPaths(text)).toBe(text);
  });

  it("leaves ratios and ordinary slashes alone", () => {
    const text = "Runs 24/7 and covers read/write paths, 3/4 complete.";
    expect(redactInternalPaths(text)).toBe(text);
  });

  it("is a no-op on text with no absolute path", () => {
    const text = "297 jobs are in the pipeline. None are blocked.";
    expect(redactInternalPaths(text)).toBe(text);
  });
});

describe("founderReceiptsBlock", () => {
  it("states the verification count without naming any tool", () => {
    const results = [okStep("s1", [receipt("job_state"), receipt("write_artifact")])];
    const block = founderReceiptsBlock(results);

    expect(block).toContain("2 actions completed and verified");
    expect(block).not.toContain("job_state");
    expect(block).not.toContain("write_artifact");
    expect(block).not.toContain("a".repeat(8));
  });

  it("uses the singular for exactly one action", () => {
    expect(founderReceiptsBlock([okStep("s1", [receipt("ops_state")])])).toContain("1 action completed");
  });

  it("renders nothing when no action succeeded", () => {
    expect(founderReceiptsBlock([okStep("s1", [])])).toBe("");
  });

  it("counts receipts across every step, not just the first", () => {
    const results = [okStep("s1", [receipt("job_state")]), okStep("s2", [receipt("write_artifact")])];
    expect(founderReceiptsBlock(results)).toContain("2 actions");
  });

  it("keeps the INTERNAL block naming tools and digests for the same results", () => {
    const results = [okStep("s1", [receipt("job_state")])];
    const internal = receiptsBlock(results);

    expect(internal).toContain("job_state");
    expect(internal).toContain("Action receipts");
    // The mechanism survived; only the audience changed.
    expect(founderReceiptsBlock(results)).not.toContain("job_state");
  });
});
