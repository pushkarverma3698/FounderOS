/**
 * P3 — Engineering handoff slice (typed state isolation).
 */
import { describe, it, expect } from "vitest";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import {
  extractEngineeringHandoff,
  validateEngineeringHandoff,
  formatEngineeringHandoffEnvelope,
  parseEngineeringHandoffEnvelope,
  findEngineeringHandoff,
  isolateEngineeringMessages,
  engineeringHandoffTokenEstimate,
  ENGINEERING_HANDOFF_TOKEN_CEILING,
  ENGINEERING_HANDOFF_MARKER,
} from "../../../src/agents/handoff-engineering.js";
import { ENGINEERING_HANDOFF_SCHEMA_VERSION } from "../../../src/agents/state.js";

const ISSUE_PROMPT =
  "Create a GitHub issue on pushkarverma3698/FounderOS branch main titled 'P3 test' with body 'verify'.";

describe("extractEngineeringHandoff", () => {
  it("parses owner/repo/branch from github text deterministically", () => {
    const h = extractEngineeringHandoff(ISSUE_PROMPT);
    expect(h.schemaVersion).toBe(ENGINEERING_HANDOFF_SCHEMA_VERSION);
    expect(h.owner).toBe("pushkarverma3698");
    expect(h.repo).toBe("FounderOS");
    expect(h.branch).toBe("main");
    expect(h.taskBrief).toContain("Create a GitHub issue");
  });

  it("caps taskBrief length", () => {
    const long = "x".repeat(2000);
    const h = extractEngineeringHandoff(long);
    expect(h.taskBrief.length).toBeLessThanOrEqual(800);
  });
});

describe("validateEngineeringHandoff", () => {
  it("accepts a well-formed handoff", () => {
    const result = validateEngineeringHandoff(extractEngineeringHandoff(ISSUE_PROMPT));
    expect(result.ok).toBe(true);
  });

  it("rejects empty taskBrief without throwing", () => {
    const result = validateEngineeringHandoff({ schemaVersion: 1, taskBrief: "" });
    expect(result.ok).toBe(false);
    expect(() => validateEngineeringHandoff(null)).not.toThrow();
  });
});

describe("handoff envelope round-trip", () => {
  it("formats and parses the envelope in a routing directive", () => {
    const handoff = extractEngineeringHandoff(ISSUE_PROMPT);
    const envelope = formatEngineeringHandoffEnvelope(handoff);
    expect(envelope).toContain(ENGINEERING_HANDOFF_MARKER);
    const parsed = parseEngineeringHandoffEnvelope(`[ROUTING DIRECTIVE] ${envelope}`);
    expect(parsed?.owner).toBe("pushkarverma3698");
    expect(parsed?.repo).toBe("FounderOS");
  });

  it("findEngineeringHandoff locates envelope in system message", () => {
    const handoff = extractEngineeringHandoff(ISSUE_PROMPT);
    const directive = `[ROUTING] ${formatEngineeringHandoffEnvelope(handoff)}`;
    const found = findEngineeringHandoff([new SystemMessage(directive), new HumanMessage(ISSUE_PROMPT)]);
    expect(found?.repo).toBe("FounderOS");
  });
});

describe("isolateEngineeringMessages — P3 boundary", () => {
  it("strips routing bloat; only slice fields remain", () => {
    const handoff = extractEngineeringHandoff(ISSUE_PROMPT);
    const bloated = [
      new SystemMessage(
        "[ROUTING DIRECTIVE: classifier routed to engineering] " +
          "ADMIN CONTEXT: company-wide priorities and 2000 chars of unrelated bloat ".repeat(40) +
          formatEngineeringHandoffEnvelope(handoff),
      ),
      new HumanMessage(ISSUE_PROMPT),
      new HumanMessage("stale turn from hours ago that must not leak"),
    ];
    const isolated = isolateEngineeringMessages(bloated, handoff);
    expect(isolated).toHaveLength(2);
    const combined = isolated.map((m) => String(m.content)).join("\n");
    expect(combined).not.toMatch(/ADMIN CONTEXT/);
    expect(combined).not.toMatch(/stale turn/);
    expect(combined).toContain("pushkarverma3698/FounderOS");
    expect(combined).toContain(handoff.taskBrief);
  });

  it("isolated slice stays under token ceiling (no company-wide bloat)", () => {
    const handoff = extractEngineeringHandoff(ISSUE_PROMPT);
    const tokens = engineeringHandoffTokenEstimate(handoff);
    expect(tokens).toBeLessThanOrEqual(ENGINEERING_HANDOFF_TOKEN_CEILING);
  });
});
