/**
 * Unit tests for scheduler pure helper functions.
 * These test the context-text builder without touching cron, DB, or LLM.
 */

import { describe, it, expect } from "vitest";
import { buildContextText, formatLeadNudge } from "../../../src/infra/scheduler.js";

describe("buildContextText", () => {
  it("formats a flat string value", () => {
    const ctx = { focus: "close Acme deal" };
    const text = buildContextText(ctx);
    expect(text).toContain("focus: close Acme deal");
  });

  it("formats an array value as comma-separated", () => {
    const ctx = { active_clients: ["Acme Corp", "Beta Ltd"] };
    const text = buildContextText(ctx);
    expect(text).toContain("active_clients: Acme Corp, Beta Ltd");
  });

  it("renders empty array as 'none'", () => {
    const ctx = { active_clients: [] as string[] };
    const text = buildContextText(ctx);
    expect(text).toContain("active_clients: none");
  });

  it("skips the last_updated key", () => {
    const ctx = { focus: "ship phase D", last_updated: "2026-06-01T00:00:00Z" };
    const text = buildContextText(ctx);
    expect(text).not.toContain("last_updated");
    expect(text).toContain("focus:");
  });

  it("returns default message when context is empty", () => {
    const text = buildContextText({});
    expect(text).toContain("No context stored yet");
    expect(text).toContain("active_clients: none");
  });

  it("returns default message when context only has last_updated", () => {
    const text = buildContextText({ last_updated: "2026-06-01T00:00:00Z" });
    expect(text).toContain("No context stored yet");
  });

  it("formats multiple keys each on its own line", () => {
    const ctx = { active_clients: ["Acme"], current_priorities: ["ship"] };
    const lines = buildContextText(ctx).split("\n");
    expect(lines).toHaveLength(2);
  });
});

describe("formatLeadNudge (dept_signals consumer)", () => {
  const sig = (payload: unknown) =>
    ({
      id: "s1",
      tenant_id: "t",
      from_dept: "research",
      to_dept: "sales",
      event_type: "lead_discovered",
      payload,
      thread_id: null,
      consumed: true,
      created_at: new Date(),
    }) as unknown as import("../../../src/db/schema.js").DeptSignal;

  it("returns empty string when there are no lead_discovered signals", () => {
    expect(formatLeadNudge([])).toBe("");
  });

  it("renders company, contact, ICP and source for a lead", () => {
    const out = formatLeadNudge([
      sig({ company: "Acme", contactName: "Sam", contactEmail: "sam@acme.com", icpScore: 88, source: "linkedin" }),
    ]);
    expect(out).toContain("Acme");
    expect(out).toContain("Sam");
    expect(out).toContain("sam@acme.com");
    expect(out).toContain("ICP 88");
    expect(out).toContain("via linkedin");
    // Surfaces work — never auto-sends.
    expect(out).toMatch(/you approve before anything sends/i);
  });

  it("pluralises and lists multiple leads", () => {
    const out = formatLeadNudge([
      sig({ company: "Acme", icpScore: 80, source: "web" }),
      sig({ company: "Beta", icpScore: 75, source: "web" }),
    ]);
    expect(out).toContain("New qualified leads");
    expect(out).toContain("Acme");
    expect(out).toContain("Beta");
  });

  it("ignores non-lead event types in the batch", () => {
    const other = { ...sig({ company: "X" }), event_type: "demo_ready" } as never;
    expect(formatLeadNudge([other])).toBe("");
  });
});
