/**
 * Unit tests for the structured tool-failure envelope (rule #22, #24).
 * Deterministic, stage-tagged failures so the gateway never misses a real tool
 * error and the founder always sees the REAL failing component.
 */

import { describe, it, expect } from "vitest";
import {
  TOOL_FAILURE_MARKER,
  TOOL_NOTICE_MARKER,
  toolFailure,
  toolNotice,
  isStructuredToolFailure,
  isToolNotice,
  getToolFailureStage,
  withToolErrorBoundary,
} from "../../../src/agents/tool-result.js";

describe("toolFailure", () => {
  it("leads with a founder-readable message and embeds a machine marker", () => {
    const out = toolFailure("db", "turicks-brain query failed");
    expect(out).toContain("turicks-brain query failed");
    expect(out).toContain(TOOL_FAILURE_MARKER);
    expect(out.startsWith("❌")).toBe(true);
  });

  it("names the real failing component in the stage tag", () => {
    expect(getToolFailureStage(toolFailure("db", "x"))).toBe("db");
    expect(getToolFailureStage(toolFailure("embedding", "x"))).toBe("embedding");
    expect(getToolFailureStage(toolFailure("external_api", "x"))).toBe("external_api");
  });
});

describe("isStructuredToolFailure", () => {
  it("detects an envelope deterministically regardless of body content", () => {
    expect(isStructuredToolFailure(toolFailure("db", "anything"))).toBe(true);
  });

  it("does not flag ordinary successful tool output", () => {
    expect(isStructuredToolFailure("Current business context:\n• priorities: ship v2")).toBe(false);
    expect(isStructuredToolFailure("1. [adr] We chose Composio because it failed less")).toBe(false);
  });

  it("returns null stage for non-envelope content", () => {
    expect(getToolFailureStage("just some text")).toBeNull();
  });
});

// M4 fix: a deliberate, successful soft-decline (suppression block, daily
// limit, duplicate-outreach guard) must never be mistaken for a failure by the
// gateway's keyword heuristic, even though its text contains keywords like
// "blocked"/"limit reached" that the heuristic scans for.
describe("toolNotice / isToolNotice", () => {
  it("embeds the notice marker without an error-looking prefix", () => {
    const out = toolNotice("BLOCKED: alice@x.com is on the do-not-contact list. Email not sent.");
    expect(out).toContain(TOOL_NOTICE_MARKER);
    expect(out.startsWith("❌")).toBe(false);
  });

  it("isToolNotice detects the marker regardless of keyword content", () => {
    const out = toolNotice("Daily email limit reached (20/20 sent today).");
    expect(isToolNotice(out)).toBe(true);
  });

  it("isToolNotice is false for ordinary content with no marker", () => {
    expect(isToolNotice("BLOCKED: alice@x.com is on the do-not-contact list.")).toBe(false);
  });

  it("a notice never also reads as a structured failure", () => {
    const out = toolNotice("Already emailed alice@x.com recently — not re-sent.");
    expect(isStructuredToolFailure(out)).toBe(false);
    expect(isToolNotice(out)).toBe(true);
  });
});

describe("withToolErrorBoundary", () => {
  it("returns the tool result on success", async () => {
    const out = await withToolErrorBoundary("db", "read context", async () => "ok result");
    expect(out).toBe("ok result");
  });

  it("converts a thrown error into a stage-tagged envelope, not a raw crash", async () => {
    const out = await withToolErrorBoundary("db", "read founder_context", async () => {
      throw new Error("connection refused 5432");
    });
    expect(isStructuredToolFailure(out)).toBe(true);
    expect(getToolFailureStage(out)).toBe("db");
    expect(out).toContain("read founder_context");
    expect(out).toContain("connection refused 5432");
  });
});
