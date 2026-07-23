/**
 * Video Factory — model-selection matrix tests ($0, pure).
 * Kling-first image-to-video: keyframe + Kling animate, Veo fallback recorded,
 * cost estimates exact (keyframe + animate), budget gate typed.
 */

import { describe, it, expect } from "vitest";
import { loadBrand, type BrandProfile } from "../../../src/tools/video-brand.js";
import { compileShotList } from "../../../src/tools/video-shotlist.js";
import { planModels, KLING_MODELS, KEYFRAME_MODELS, VEO_MODELS } from "../../../src/tools/video-models.js";

function shotlist(duration = 30) {
  const res = loadBrand("the-health-place");
  if (!res.success) throw new Error(res.error);
  return compileShotList(res.brand as BrandProfile, { format: "reel-9x16", topic: "t", duration_s: duration });
}

describe("planModels", () => {
  it("is deterministic", () => {
    expect(planModels(shotlist())).toEqual(planModels(shotlist()));
  });

  it("hook gets Kling Pro + Nano Banana Pro; body rides Turbo + draft; title card is $0 local", () => {
    const plan = planModels(shotlist());
    const sl = shotlist();
    const byId = new Map(plan.assignments.map((a) => [a.shot_id, a]));
    for (const shot of sl.shots) {
      const a = byId.get(shot.id)!;
      if (shot.kind === "title-card") {
        expect(a.engine).toBe("hyperframes");
        expect(a.est_cost_usd).toBe(0);
      } else if (shot.scene_role === "hook") {
        expect(a.engine).toBe("kling");
        expect(a.model).toBe(KLING_MODELS.pro.model);
        expect(a.keyframe_model).toBe(KEYFRAME_MODELS.pro.model);
      } else {
        expect(a.engine).toBe("kling");
        expect(a.model).toBe(KLING_MODELS.turbo.model);
        expect(a.keyframe_model).toBe(KEYFRAME_MODELS.draft.model);
      }
    }
  });

  it("every generated shot records a Veo fallback path (reliability, never a dead render)", () => {
    for (const a of planModels(shotlist()).assignments.filter((a) => a.engine === "kling")) {
      expect(a.fallback_engine).toBe("veo");
      expect([VEO_MODELS.premium.model, VEO_MODELS.fast.model]).toContain(a.fallback_model);
      expect(a.fallback_gen_seconds).toBeGreaterThan(0);
    }
  });

  it("Kling clips bill only on the 5s/10s grid", () => {
    for (const a of planModels(shotlist(90)).assignments.filter((a) => a.engine === "kling")) {
      expect([5, 10]).toContain(a.gen_seconds);
    }
  });

  it("economy tier forces every generated shot onto Kling Turbo + draft keyframe", () => {
    const plan = planModels(shotlist(), { tier: "economy" });
    for (const a of plan.assignments.filter((a) => a.engine === "kling")) {
      expect(a.model).toBe(KLING_MODELS.turbo.model);
      expect(a.keyframe_model).toBe(KEYFRAME_MODELS.draft.model);
    }
  });

  it("premium tier puts every generated shot on Kling Pro + Nano Banana Pro", () => {
    for (const a of planModels(shotlist(), { tier: "premium" }).assignments.filter((a) => a.engine === "kling")) {
      expect(a.model).toBe(KLING_MODELS.pro.model);
      expect(a.keyframe_model).toBe(KEYFRAME_MODELS.pro.model);
    }
  });

  it("cost = keyframe + gen_seconds × rate, and totals add up", () => {
    const plan = planModels(shotlist());
    for (const a of plan.assignments.filter((a) => a.engine === "kling")) {
      const rate = a.model === KLING_MODELS.pro.model ? KLING_MODELS.pro.usd_per_s : KLING_MODELS.turbo.usd_per_s;
      expect(a.est_cost_usd).toBeCloseTo(a.gen_seconds * rate + (a.keyframe_cost_usd ?? 0), 2);
    }
    const videoSum = plan.assignments.reduce((s, a) => s + a.est_cost_usd, 0);
    expect(plan.video_est_usd).toBeCloseTo(videoSum, 2);
    expect(plan.total_est_usd).toBeCloseTo(plan.video_est_usd + plan.audio_est_usd, 2);
  });

  it("budget gate: over-budget → typed verdict naming the component, never a silent downgrade", () => {
    const plan = planModels(shotlist(60), { budget_usd: 1 });
    expect(plan.verdict.ok).toBe(false);
    if (!plan.verdict.ok) {
      expect(plan.verdict.component).toBe("video-models");
      expect(plan.verdict.over_by_usd).toBeGreaterThan(0);
      expect(plan.verdict.reason).toContain("exceeds budget");
    }
    // assignments unchanged — the gate reports, it does not mutate the creative plan
    expect(planModels(shotlist(60), { budget_usd: 100 }).assignments).toEqual(plan.assignments);
  });

  it("within budget → ok verdict", () => {
    expect(planModels(shotlist(), { budget_usd: 50 }).verdict).toEqual({ ok: true });
  });
});
