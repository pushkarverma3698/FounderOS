/**
 * Proof Drop pipeline — pure function unit tests (no LLM, no DB).
 */

import { describe, it, expect } from "vitest";
import {
  PROOF_DROP_ARTIFACT_TYPES,
  PROOF_DROP_MIN_ICP,
  WEEKLY_PROOF_DROP_TARGET,
  getWeekStart,
  countProofDropsThisWeek,
  parseProofDropLog,
  buildProofDropStats,
  formatProofDropStats,
  buildProofDropCadenceNudge,
  normalizeProofDropCompany,
} from "../../../src/outbound/proof-drop.js";
import { getWorkflow } from "../../../src/workflows/registry.js";
import { validateSignalPayload } from "../../../src/agents/contracts.js";

describe("proof drop constants", () => {
  it("targets 2 high-craft drops per week (Phase D-Bis cadence)", () => {
    expect(WEEKLY_PROOF_DROP_TARGET).toBe(2);
    expect(PROOF_DROP_MIN_ICP).toBeGreaterThanOrEqual(5);
    expect(PROOF_DROP_ARTIFACT_TYPES).toContain("hero_redesign");
  });
});

describe("getWeekStart", () => {
  it("returns Monday 00:00 for a Wednesday", () => {
    const wed = new Date("2026-06-17T15:00:00");
    const start = getWeekStart(wed);
    expect(start.getDay()).toBe(1);
    expect(start.getHours()).toBe(0);
    expect(start.getDate()).toBe(15);
  });
});

describe("countProofDropsThisWeek", () => {
  it("counts only entries since Monday", () => {
    const now = new Date("2026-06-17T12:00:00");
    const entries = [
      { company: "OldCo", at: "2026-06-08T10:00:00.000Z" },
      { company: "NewCo", at: "2026-06-16T10:00:00.000Z" },
    ];
    expect(countProofDropsThisWeek(entries, now)).toBe(1);
  });
});

describe("parseProofDropLog", () => {
  it("drops malformed rows", () => {
    expect(parseProofDropLog([{ company: "A", at: "2026-06-16T00:00:00Z" }, {}, null])).toEqual([
      { company: "A", at: "2026-06-16T00:00:00Z" },
    ]);
  });
});

describe("buildProofDropStats", () => {
  it("computes remaining drops toward weekly target", () => {
    const now = new Date("2026-06-17T12:00:00");
    const stats = buildProofDropStats(
      [{ company: "Linear", at: "2026-06-16T10:00:00.000Z" }],
      now,
    );
    expect(stats.countThisWeek).toBe(1);
    expect(stats.remaining).toBe(1);
    expect(stats.target).toBe(2);
  });
});

describe("formatProofDropStats", () => {
  it("shows on-track when target met", () => {
    const html = formatProofDropStats({
      countThisWeek: 2,
      target: 2,
      remaining: 0,
      recent: [{ company: "Linear", at: "2026-06-16T00:00:00Z" }],
    });
    expect(html).toContain("On track");
    expect(html).toContain("Linear");
  });
});

describe("buildProofDropCadenceNudge", () => {
  it("returns null when on track", () => {
    expect(
      buildProofDropCadenceNudge({ countThisWeek: 2, target: 2, remaining: 0, recent: [] }),
    ).toBeNull();
  });

  it("nudges with /proofdrop when below target", () => {
    const nudge = buildProofDropCadenceNudge({
      countThisWeek: 0,
      target: 2,
      remaining: 2,
      recent: [],
    });
    expect(nudge).toContain("/proofdrop");
    expect(nudge).toContain("0/2");
  });
});

describe("normalizeProofDropCompany", () => {
  it("trims and rejects empty", () => {
    expect(normalizeProofDropCompany("  Linear  ")).toBe("Linear");
    expect(normalizeProofDropCompany("")).toBeNull();
  });
});

describe("proof_drop workflow registry", () => {
  it("registers a 4-step Proof Drop SOP with company param", () => {
    const wf = getWorkflow("proof_drop");
    expect(wf).toBeDefined();
    expect(wf!.params).toEqual(["company"]);
    expect(wf!.steps).toHaveLength(4);
    expect(wf!.steps[0]!.id).toBe("icp_gate");
    expect(wf!.steps[2]!.task).toContain("proof_drop_ready");
    expect(wf!.steps[3]!.task.toLowerCase()).toContain("send_email");
  });
});

describe("proof_drop_ready contract", () => {
  it("validates a well-formed payload", () => {
    const result = validateSignalPayload("proof_drop_ready", {
      company: "Linear",
      artifactType: "hero_redesign",
      artifactSummary: "Dark-mode hero with scroll-driven agent metrics mock.",
      outreachHook: "Saw your launch — mocked a cinematic hero concept.",
    });
    expect(result.ok).toBe(true);
  });
});
