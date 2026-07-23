/**
 * Video Factory — receipt-key parity ($0, pure).
 *
 * The idempotency key (audit F4) is derived in TWO runtimes: the TS planner
 * (video-production.ts `stepKey`) and the standalone executor
 * (video-factory/scripts/lib/step-key.mjs, imported by produce.mjs). If they
 * ever disagree, receipts silently double-spend or go stale. This test pins
 * them together over every step of a real compiled plan + the new kinds.
 */

import { describe, it, expect } from "vitest";
// @ts-expect-error — plain-JS executor module, no types (single source of truth for the key)
import { stepKey as mjsStepKey, fnv1a as mjsFnv1a } from "../../../video-factory/scripts/lib/step-key.mjs";
import { loadBrand, type BrandProfile } from "../../../src/tools/video-brand.js";
import { compileShotList, fnv1a } from "../../../src/tools/video-shotlist.js";
import { planModels } from "../../../src/tools/video-models.js";
import { compileProductionPlan, stepKey } from "../../../src/tools/video-production.js";

function realPlan() {
  const res = loadBrand("the-health-place");
  if (!res.success) throw new Error(res.error);
  const shotlist = compileShotList(res.brand as BrandProfile, { format: "reel-9x16", topic: "t", duration_s: 30 });
  return compileProductionPlan(shotlist, planModels(shotlist), { project: "thp--t--reel-9x16", vo_script: "hello", include_music: true });
}

describe("receipt-key parity (TS ⇄ produce.mjs)", () => {
  it("fnv1a is byte-identical across runtimes", () => {
    for (const s of ["", "a", "founderos", "keyframe-sh-01", "gen-sh-07"]) {
      expect(mjsFnv1a(s)).toBe(fnv1a(s));
    }
  });

  it("stepKey agrees on every step of a real plan (incl. keyframe + kling kinds)", () => {
    const plan = realPlan();
    expect(plan.steps.some((s) => s.kind === "keyframe")).toBe(true);
    expect(plan.steps.some((s) => s.kind === "kling")).toBe(true);
    for (const step of plan.steps) {
      expect(mjsStepKey(step), `mismatch on ${step.id} [${step.kind}]`).toBe(stepKey(step));
    }
  });

  it("stepKey is order-insensitive to JS object key iteration (JSON canonical)", () => {
    const a = { id: "gen-sh-01", kind: "kling", params: { prompt: "p", image: "i.png", duration_s: 5 }, produces: "assets/sh-01.mp4" };
    expect(mjsStepKey(a)).toBe(stepKey(a as never));
  });
});
