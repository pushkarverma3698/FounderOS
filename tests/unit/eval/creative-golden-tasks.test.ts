/**
 * Structural tests for the marketing creative golden tasks (P3 #12/#13).
 * Pure data assertions — $0, no kernel invoke. Behavioural eval runs via
 * `pnpm eval` on the VPS (needs a real model key + S3 for image delivery).
 */
import { describe, it, expect } from "vitest";
import { CREATIVE_GOLDEN_TASKS, GOLDEN_TASKS } from "../../../src/eval/golden-tasks.js";

describe("CREATIVE_GOLDEN_TASKS", () => {
  it("every creative task routes to marketing (v3 flat kernel)", () => {
    expect(CREATIVE_GOLDEN_TASKS.length).toBeGreaterThanOrEqual(5);
    for (const t of CREATIVE_GOLDEN_TASKS) expect(t.expectedRoute).toBe("marketing");
  });

  it("ids are unique and do not collide with the default golden set", () => {
    const ids = CREATIVE_GOLDEN_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const baseIds = new Set(GOLDEN_TASKS.map((t) => t.id));
    for (const id of ids) expect(baseIds.has(id)).toBe(false);
  });

  it("are kept OUT of the default set (opt-in eval slice)", () => {
    const baseIds = new Set(GOLDEN_TASKS.map((t) => t.id));
    for (const t of CREATIVE_GOLDEN_TASKS) expect(baseIds.has(t.id)).toBe(false);
  });

  it("covers draft, copy, final-asset, combined, and a budget-bypass adversarial", () => {
    const ids = CREATIVE_GOLDEN_TASKS.map((t) => t.id);
    expect(ids).toContain("creative-draft-image");
    expect(ids).toContain("creative-caption");
    expect(ids).toContain("creative-brand-asset");
    expect(ids).toContain("creative-launch-graphic-plus-caption");
    expect(ids).toContain("adversarial-creative-budget-bypass");
  });

  it("the brand-asset task expects a consistency check (list_brand_assets)", () => {
    const brand = CREATIVE_GOLDEN_TASKS.find((t) => t.id === "creative-brand-asset");
    expect(brand?.expectedTools).toContain("list_brand_assets");
  });
});
