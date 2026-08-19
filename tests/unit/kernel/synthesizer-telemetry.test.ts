/**
 * AG-008 — the synthesizer is the ONLY writer of agent_results, and it used to
 * omit latency_ms and tools_used on every row ever written. These tests pin the
 * two pure helpers that now fill them.
 *
 * The failure direction that matters here is silent: a NaN or a negative number
 * in latency_ms is indistinguishable from a real measurement once it is stored,
 * so every unusable input must come back as null.
 */

import { describe, it, expect } from "vitest";
import { toolsUsed, turnLatencyMs } from "../../../src/kernel/synthesizer.js";
import type { StepResult, ToolReceipt } from "../../../src/kernel/contracts.js";

function receipt(tool: string, ok = true): ToolReceipt {
  return { tool, at: "2026-08-19T10:00:00.000Z", args_hash: "a".repeat(64), result_digest: "b".repeat(64), ok };
}

function okStep(step_id: string, receipts: ToolReceipt[]): StepResult {
  return { step_id, status: "ok", output: {}, tool_receipts: receipts };
}

function failedStep(step_id: string): StepResult {
  return {
    step_id,
    status: "failed",
    failure: { step_id, stage: "tool", component: "test", message: "boom", retryable: false },
  };
}

describe("turnLatencyMs", () => {
  it("returns whole milliseconds elapsed since received_at", () => {
    // Arrange
    const receivedAt = "2026-08-19T10:00:00.000Z";
    const now = Date.parse("2026-08-19T10:00:02.500Z");

    // Act
    const latency = turnLatencyMs(receivedAt, now);

    // Assert
    expect(latency).toBe(2500);
  });

  it("returns 0 for a turn measured at the instant it arrived", () => {
    const receivedAt = "2026-08-19T10:00:00.000Z";
    expect(turnLatencyMs(receivedAt, Date.parse(receivedAt))).toBe(0);
  });

  it("returns null — never NaN — for an unparseable timestamp", () => {
    const latency = turnLatencyMs("not-a-date", Date.parse("2026-08-19T10:00:00.000Z"));
    expect(latency).toBeNull();
    expect(Number.isNaN(latency)).toBe(false);
  });

  it("returns null for a missing or empty received_at", () => {
    const now = Date.parse("2026-08-19T10:00:00.000Z");
    expect(turnLatencyMs(undefined, now)).toBeNull();
    expect(turnLatencyMs(null, now)).toBeNull();
    expect(turnLatencyMs("", now)).toBeNull();
  });

  it("returns null rather than a negative number when the clock went backwards", () => {
    const latency = turnLatencyMs("2026-08-19T10:00:05.000Z", Date.parse("2026-08-19T10:00:00.000Z"));
    expect(latency).toBeNull();
  });

  it("does NOT throw on a hostile timestamp", () => {
    expect(() => turnLatencyMs("9999-99-99T99:99:99Z", Date.now())).not.toThrow();
    expect(turnLatencyMs("9999-99-99T99:99:99Z", Date.now())).toBeNull();
  });
});

describe("toolsUsed", () => {
  it("collects tool names across every ok step", () => {
    // Arrange
    const results = [
      okStep("s1", [receipt("search_web"), receipt("read_cv")]),
      okStep("s2", [receipt("send_email")]),
    ];

    // Act
    const tools = toolsUsed(results);

    // Assert
    expect(tools).toEqual(["search_web", "read_cv", "send_email"]);
  });

  it("de-duplicates a tool called in more than one step", () => {
    const results = [okStep("s1", [receipt("search_web")]), okStep("s2", [receipt("search_web")])];
    expect(toolsUsed(results)).toEqual(["search_web"]);
  });

  it("records a tool that was invoked and FAILED — it was still used", () => {
    const results = [okStep("s1", [receipt("send_email", false)])];
    expect(toolsUsed(results)).toEqual(["send_email"]);
  });

  it("does NOT invent tools from a step with no receipts", () => {
    expect(toolsUsed([okStep("s1", [])])).toEqual([]);
  });

  it("does NOT read receipts off a non-ok step", () => {
    expect(toolsUsed([failedStep("s1")])).toEqual([]);
  });

  it("returns an empty array for an empty run", () => {
    expect(toolsUsed([])).toEqual([]);
  });
});
