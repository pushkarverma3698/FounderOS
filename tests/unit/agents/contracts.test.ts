/**
 * Typed inter-department contracts (Phase 2).
 *
 * dept_signals.payload is "schema defined by event_type convention" (schema.ts).
 * These contracts make that convention explicit + enforced: a deterministic
 * validator (no LLM call) gates every cross-department payload at the boundary,
 * so handoffs carry typed objects instead of raw message dumps (CLAUDE rule #21).
 */
import { describe, it, expect } from "vitest";
import {
  SIGNAL_EVENT_TYPES,
  SIGNAL_CONTRACTS,
  validateSignalPayload,
  isSignalEventType,
} from "../../../src/agents/contracts.js";

describe("signal event-type registry", () => {
  it("registers exactly one Zod contract per known event type", () => {
    for (const ev of SIGNAL_EVENT_TYPES) {
      expect(SIGNAL_CONTRACTS[ev]).toBeDefined();
    }
    // No orphan contracts without an event type.
    expect(Object.keys(SIGNAL_CONTRACTS).sort()).toEqual([...SIGNAL_EVENT_TYPES].sort());
  });

  it("isSignalEventType narrows known vs unknown event types", () => {
    expect(isSignalEventType("lead_discovered")).toBe(true);
    expect(isSignalEventType("not_a_real_event")).toBe(false);
    expect(isSignalEventType("")).toBe(false);
  });
});

describe("validateSignalPayload — deterministic boundary gate", () => {
  it("accepts a well-formed lead_discovered payload and returns the parsed object", () => {
    const result = validateSignalPayload("lead_discovered", {
      company: "Acme Corp",
      icpScore: 82,
      source: "linkedin",
      contactEmail: "cfo@acme.com",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.eventType).toBe("lead_discovered");
      expect((result.payload as { company: string }).company).toBe("Acme Corp");
    }
  });

  it("rejects an unknown event type without throwing", () => {
    const result = validateSignalPayload("totally_made_up", { x: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown event type/i);
  });

  it("rejects a payload that violates its contract (missing required field)", () => {
    const result = validateSignalPayload("lead_discovered", {
      // company missing
      icpScore: 50,
      source: "web",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/company/i);
  });

  it("rejects an out-of-range icpScore (0–100 contract)", () => {
    const result = validateSignalPayload("lead_discovered", {
      company: "Acme",
      icpScore: 9000,
      source: "web",
    });
    expect(result.ok).toBe(false);
  });

  it("validates proposal_approved, demo_ready, design_brief_ready, and site_deployed contracts", () => {
    expect(
      validateSignalPayload("proposal_approved", {
        company: "Acme",
        proposalId: "p_123",
        amountUsd: 5000,
      }).ok,
    ).toBe(true);
    expect(
      validateSignalPayload("demo_ready", {
        company: "Acme",
        repoUrl: "https://github.com/turicks/acme-demo",
      }).ok,
    ).toBe(true);
    expect(
      validateSignalPayload("design_brief_ready", {
        client: "AgentOps",
        preset: "neon",
        copyBlocks: { hero: "Ship agents you can trust" },
      }).ok,
    ).toBe(true);
    expect(
      validateSignalPayload("site_deployed", {
        client: "AgentOps",
        siteUrl: "https://agentops.example.com",
        presetUsed: "neon",
      }).ok,
    ).toBe(true);
  });

  it("never throws on hostile input (null/undefined/non-object)", () => {
    expect(() => validateSignalPayload("lead_discovered", null)).not.toThrow();
    expect(() => validateSignalPayload("lead_discovered", undefined)).not.toThrow();
    expect(() => validateSignalPayload("lead_discovered", 42)).not.toThrow();
    expect(validateSignalPayload("lead_discovered", null).ok).toBe(false);
  });
});
