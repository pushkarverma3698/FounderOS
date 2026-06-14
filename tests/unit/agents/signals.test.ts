/**
 * Phase 4 — durable cross-department signals over Postgres.
 *
 * prepareSignal is the pure boundary: it validates the payload against the
 * typed contract (ADR-022) and resolves the default target department BEFORE
 * anything is written. The DB write (publishDeptEvent) and the scheduler sweep
 * are thin wrappers around it. We test the pure logic here; the consumer's
 * formatter lives in the scheduler tests.
 */
import { describe, it, expect } from "vitest";
import { prepareSignal, DEFAULT_TARGET_DEPT } from "../../../src/agents/agent-tools/signals.js";

describe("prepareSignal", () => {
  it("validates the payload and defaults the target department by event type", () => {
    const r = prepareSignal("lead_discovered", {
      company: "Acme",
      icpScore: 78,
      source: "web",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.signal.event_type).toBe("lead_discovered");
      expect(r.signal.to_dept).toBe(DEFAULT_TARGET_DEPT["lead_discovered"]);
      expect(r.signal.from_dept).toBe("research");
      // payload is the parsed/validated object, not the raw input
      expect((r.signal.payload as { company: string }).company).toBe("Acme");
    }
  });

  it("honours an explicit target department override", () => {
    const r = prepareSignal(
      "demo_ready",
      { company: "Acme", repoUrl: "https://github.com/turicks/acme" },
      { toDept: "marketing" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signal.to_dept).toBe("marketing");
  });

  it("threads through the thread_id for provenance", () => {
    const r = prepareSignal(
      "lead_discovered",
      { company: "Acme", icpScore: 50, source: "web" },
      { threadId: "tg-123" },
    );
    if (r.ok) expect(r.signal.thread_id).toBe("tg-123");
  });

  it("rejects an invalid payload via the contract (no DB write attempted)", () => {
    const r = prepareSignal("lead_discovered", { icpScore: 50, source: "web" }); // company missing
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/company/i);
  });

  it("rejects an unknown event type", () => {
    const r = prepareSignal("made_up", { x: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown event type/i);
  });
});
