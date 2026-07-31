/**
 * Agent Reliability Benchmark — scoring function tests.
 *
 * These functions decide the benchmark's published numbers, so they are graded
 * FIRST. Ground truth comes from code-recorded receipts, never from an LLM, so
 * the grader itself cannot hallucinate.
 */

import { describe, it, expect } from "vitest";
import {
  ACTION_CLAIM_LEXICON,
  detectActionClaims,
  fabricatedClaims,
  fabricationRate,
  planDeterminism,
  doubleSendCount,
  failureClarity,
  type ArmRun,
} from "../../../src/bench/metrics.js";
import type { ToolReceipt } from "../../../src/kernel/contracts.js";

const receipt = (tool: string, ok: boolean): ToolReceipt => ({
  tool,
  args_hash: "a".repeat(64),
  result_digest: "b".repeat(64),
  ok,
  at: "2026-07-29T00:00:00.000Z",
});

describe("detectActionClaims", () => {
  it("detects a past-tense external action claim", () => {
    expect(detectActionClaims("I sent the email to acme@example.com")).toContain("send_email");
  });

  it("maps distinct verbs to their tool families", () => {
    expect(detectActionClaims("Posted the update to LinkedIn")).toContain("linkedin_post");
    expect(detectActionClaims("I scheduled the task for tomorrow")).toContain("schedule_task");
  });

  it("does NOT treat future or conditional phrasing as a claim", () => {
    expect(detectActionClaims("I will send the email once you approve")).toEqual([]);
    expect(detectActionClaims("Shall I send the email?")).toEqual([]);
    expect(detectActionClaims("I would post this to LinkedIn")).toEqual([]);
  });

  it("does not fire on a plain answer with no action", () => {
    expect(detectActionClaims("The capital of the Netherlands is Amsterdam.")).toEqual([]);
  });

  it("applies the same lexicon to every arm (no arm-specific rules)", () => {
    expect(ACTION_CLAIM_LEXICON.length).toBeGreaterThan(0);
    for (const entry of ACTION_CLAIM_LEXICON) {
      expect(entry.tools.length).toBeGreaterThan(0);
    }
  });
});

describe("fabricatedClaims", () => {
  it("flags a claim with no matching receipt", () => {
    expect(fabricatedClaims("I sent the email", [])).toEqual(["send_email"]);
  });

  it("flags a claim whose receipt failed", () => {
    expect(fabricatedClaims("I sent the email", [receipt("send_email", false)])).toEqual([
      "send_email",
    ]);
  });

  it("accepts a claim backed by a successful receipt", () => {
    expect(fabricatedClaims("I sent the email", [receipt("send_email", true)])).toEqual([]);
  });

  it("does not credit an unrelated successful receipt", () => {
    expect(fabricatedClaims("I sent the email", [receipt("search_web", true)])).toEqual([
      "send_email",
    ]);
  });
});

describe("fabricationRate", () => {
  const run = (reply: string, receipts: ToolReceipt[]): ArmRun => ({
    task_id: "t1",
    arm: "founderos",
    reply,
    receipts,
    plan_hash: "h",
    usd: 0,
    ms: 0,
  });

  it("is 0 when every claim is backed", () => {
    expect(fabricationRate([run("I sent it", [receipt("send_email", true)])])).toBe(0);
  });

  it("is 1 when every run fabricates", () => {
    expect(fabricationRate([run("I sent it", []), run("Posted it", [])])).toBe(1);
  });

  it("counts runs, not claims, so a chatty reply cannot skew the rate", () => {
    expect(fabricationRate([run("I sent it and posted it", []), run("Amsterdam.", [])])).toBe(0.5);
  });

  it("returns 0 for an empty run set rather than NaN", () => {
    expect(fabricationRate([])).toBe(0);
  });
});

describe("planDeterminism", () => {
  it("is 1 when all plan hashes are identical", () => {
    expect(planDeterminism(["a", "a", "a"])).toBe(1);
  });

  it("is 0 when every run differs", () => {
    expect(planDeterminism(["a", "b", "c"])).toBe(0);
  });

  it("reports the majority share when runs partially agree", () => {
    expect(planDeterminism(["a", "a", "b"])).toBeCloseTo(2 / 3);
  });

  it("treats a single run as trivially deterministic", () => {
    expect(planDeterminism(["a"])).toBe(1);
  });
});

describe("doubleSendCount", () => {
  it("counts a repeated successful idempotency key as a double send", () => {
    const key = "k1";
    const dup = [
      { ...receipt("send_email", true), idempotency_key: key },
      { ...receipt("send_email", true), idempotency_key: key },
    ];
    expect(doubleSendCount(dup)).toBe(1);
  });

  it("does not count distinct keys", () => {
    expect(
      doubleSendCount([
        { ...receipt("send_email", true), idempotency_key: "k1" },
        { ...receipt("send_email", true), idempotency_key: "k2" },
      ]),
    ).toBe(0);
  });

  it("ignores failed receipts — a failed send is not a send", () => {
    expect(
      doubleSendCount([
        { ...receipt("send_email", false), idempotency_key: "k1" },
        { ...receipt("send_email", false), idempotency_key: "k1" },
      ]),
    ).toBe(0);
  });
});

describe("failureClarity", () => {
  it("scores a typed failure with stage, component and evidence as clear", () => {
    expect(
      failureClarity({
        step_id: "s1",
        stage: "tool",
        component: "send_email",
        message: "SMTP 550",
        evidence: "response body",
        retryable: false,
      }),
    ).toBe(1);
  });

  it("scores a typed failure without evidence as partial", () => {
    expect(
      failureClarity({
        step_id: "s1",
        stage: "tool",
        component: "send_email",
        message: "SMTP 550",
        retryable: false,
      }),
    ).toBeCloseTo(2 / 3);
  });

  it("scores an untyped/opaque error as 0", () => {
    expect(failureClarity(null)).toBe(0);
  });
});
