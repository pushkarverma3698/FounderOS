/**
 * B5 — GitHub / cross-dept loop-wedge regression test.
 *
 * The bug (H09/H15/H17): a failing github tool (auth/401) returns a structured
 * toolFailure envelope but the ReAct agent keeps retrying until GraphRecursionError.
 * Fix: capConsecutiveToolFailures() — on the 2nd consecutive structured failure
 * for the same tool within a turn, upgrade the result to a terminal message that
 * tells the founder the real error (rule #22) and signals the agent to stop.
 *
 * Tests verify:
 *   - 1st failure → returned as-is (retryable, the agent may legitimately try once)
 *   - 2nd consecutive failure → TERMINAL surfaced-error message (no marker, no retry)
 *   - Success between two failures → resets the counter (2nd call NOT terminal)
 *   - Counter is isolated per tool name (tool-A's failures don't bleed into tool-B)
 *   - A non-failure (success string) passes through unchanged regardless of prior state
 */

import { describe, it, expect } from "vitest";
import {
  makeToolFailureCounter,
  capConsecutiveToolFailures,
} from "../../../src/agents/agent-tools/engineering.js";
import { toolFailure, isStructuredToolFailure } from "../../../src/agents/tool-result.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const AUTH_FAIL = toolFailure("auth", "GitHub read failed: Bad credentials — rotate GITHUB_TOKEN (expired or missing scope)");
const NET_FAIL  = toolFailure("network", "GitHub read failed: getaddrinfo ENOTFOUND api.github.com — GitHub unreachable, retry shortly");
const SUCCESS   = '{"login":"pushkarverma3698","public_repos":12}';

// ── makeToolFailureCounter ────────────────────────────────────────────────────

describe("makeToolFailureCounter", () => {
  it("returns a fresh counter with increment and reset methods", () => {
    const counter = makeToolFailureCounter();
    expect(counter.get("github_read")).toBe(0);
    counter.increment("github_read");
    expect(counter.get("github_read")).toBe(1);
    counter.reset("github_read");
    expect(counter.get("github_read")).toBe(0);
  });

  it("tracks tools independently", () => {
    const counter = makeToolFailureCounter();
    counter.increment("github_read");
    counter.increment("github_read");
    expect(counter.get("github_read")).toBe(2);
    expect(counter.get("github_write")).toBe(0);
  });
});

// ── capConsecutiveToolFailures ────────────────────────────────────────────────

describe("capConsecutiveToolFailures", () => {
  it("passes the 1st structured failure through unchanged (retryable)", () => {
    const counter = makeToolFailureCounter();
    const result = capConsecutiveToolFailures(counter, "github_read", AUTH_FAIL);
    // First failure: returned as-is — the ReAct agent may retry once
    expect(result).toBe(AUTH_FAIL);
    expect(isStructuredToolFailure(result)).toBe(true);
    expect(counter.get("github_read")).toBe(1);
  });

  it("returns a TERMINAL message on the 2nd consecutive structured failure", () => {
    const counter = makeToolFailureCounter();
    capConsecutiveToolFailures(counter, "github_read", AUTH_FAIL); // 1st
    const second = capConsecutiveToolFailures(counter, "github_read", AUTH_FAIL); // 2nd

    // Must NOT be a structured toolFailure (the marker would still look retryable)
    expect(isStructuredToolFailure(second)).toBe(false);
    // Must name the real failing component (rule #22)
    expect(second).toContain("GitHub auth failed");
    expect(second.toLowerCase()).toMatch(/token|auth|401|credential/);
    // Must tell the agent to stop retrying
    expect(second.toLowerCase()).toMatch(/stop|do not retry|cannot retry|give up|no further/);
  });

  it("resets counter when a success is returned between two failures", () => {
    const counter = makeToolFailureCounter();
    capConsecutiveToolFailures(counter, "github_read", AUTH_FAIL);  // 1st failure → count=1
    capConsecutiveToolFailures(counter, "github_read", SUCCESS);    // success → count=0
    const afterReset = capConsecutiveToolFailures(counter, "github_read", AUTH_FAIL); // 1st again

    // After reset, this is the first failure again — must be returned as-is
    expect(afterReset).toBe(AUTH_FAIL);
    expect(isStructuredToolFailure(afterReset)).toBe(true);
    expect(counter.get("github_read")).toBe(1);
  });

  it("passes a success string through unchanged and resets the counter", () => {
    const counter = makeToolFailureCounter();
    counter.increment("github_read");
    const result = capConsecutiveToolFailures(counter, "github_read", SUCCESS);
    expect(result).toBe(SUCCESS);
    expect(counter.get("github_read")).toBe(0);
  });

  it("isolates counters per tool — github_read failures do not affect github_write", () => {
    const counter = makeToolFailureCounter();
    capConsecutiveToolFailures(counter, "github_read", AUTH_FAIL); // read count=1
    capConsecutiveToolFailures(counter, "github_read", AUTH_FAIL); // read count=2 → terminal

    // github_write hasn't failed yet — its 1st failure is still retryable
    const writeFirst = capConsecutiveToolFailures(counter, "github_write", NET_FAIL);
    expect(writeFirst).toBe(NET_FAIL);
    expect(isStructuredToolFailure(writeFirst)).toBe(true);
  });

  it("works correctly with network-stage failures too", () => {
    const counter = makeToolFailureCounter();
    capConsecutiveToolFailures(counter, "github_read", NET_FAIL); // 1st
    const second = capConsecutiveToolFailures(counter, "github_read", NET_FAIL); // 2nd

    expect(isStructuredToolFailure(second)).toBe(false);
    expect(second.toLowerCase()).toMatch(/stop|do not retry|cannot retry|give up|no further/);
  });
});
