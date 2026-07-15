/**
 * Video Factory — brief compiler tests ($0, pure).
 * Determinism is the contract: same brand + same request → byte-identical brief.
 */

import { describe, it, expect } from "vitest";
import { loadBrand } from "../../../src/tools/video-brand.js";
import { compileVideoBrief, planScenes } from "../../../src/tools/video-brief.js";
import type { BrandProfile } from "../../../src/tools/video-brand.js";

function thp(): BrandProfile {
  const res = loadBrand("the-health-place");
  if (!res.success) throw new Error(res.error);
  return res.brand;
}

describe("compileVideoBrief", () => {
  it("is deterministic: compile twice → byte-identical markdown", () => {
    const a = compileVideoBrief(thp(), { format: "hero-16x9", topic: "launch hero" });
    const b = compileVideoBrief(thp(), { format: "hero-16x9", topic: "launch hero" });
    expect(a.markdown).toBe(b.markdown);
    expect(a).toEqual(b);
  });

  it("maps formats to the right canvas + composition file", () => {
    const hero = compileVideoBrief(thp(), { format: "hero-16x9", topic: "t" });
    const reel = compileVideoBrief(thp(), { format: "reel-9x16", topic: "t" });
    const square = compileVideoBrief(thp(), { format: "square-1x1", topic: "t" });
    expect(hero.canvas).toEqual({ width: 1920, height: 1080 });
    expect(reel.canvas).toEqual({ width: 1080, height: 1920 });
    expect(square.canvas).toEqual({ width: 1080, height: 1080 });
    expect(hero.markdown).toContain("index.html");
    expect(reel.markdown).toContain("index-vertical.html");
    expect(square.markdown).toContain("index-square.html");
  });

  it("briefs by word count, not seconds (~160 wpm)", () => {
    const brief = compileVideoBrief(thp(), { format: "hero-16x9", topic: "t", duration_s: 60 });
    expect(brief.vo_word_budget).toBe(160);
    expect(brief.markdown).toContain("~160 words");
  });

  it("clamps duration to [10, 120]s", () => {
    expect(compileVideoBrief(thp(), { format: "reel-9x16", topic: "t", duration_s: 3 }).duration_s).toBe(10);
    expect(compileVideoBrief(thp(), { format: "reel-9x16", topic: "t", duration_s: 900 }).duration_s).toBe(120);
  });

  it("scene plan covers the full duration with hook first and CTA last", () => {
    const brief = compileVideoBrief(thp(), { format: "hero-16x9", topic: "t", duration_s: 55 });
    const total = brief.scenes.reduce((s, b) => s + b.duration_s, 0);
    expect(total).toBe(55);
    expect(brief.scenes[0]?.role).toBe("hook");
    expect(brief.scenes.at(-1)?.role).toBe("cta");
    // contiguous, no gaps
    let cursor = 0;
    for (const s of brief.scenes) {
      expect(s.start_s).toBe(cursor);
      cursor += s.duration_s;
    }
  });

  it("carries brand tokens + unconfirmed-name warning into the brief", () => {
    const brief = compileVideoBrief(thp(), { format: "hero-16x9", topic: "launch" });
    expect(brief.markdown).toContain("#0E2B20");
    expect(brief.markdown).toContain("8 Dimensions of Wellness");
    expect(brief.markdown).toContain("Brand name unconfirmed");
    expect(brief.markdown).toContain("hyperframes lint && hyperframes check");
  });

  it("confirmed brands get no warning", () => {
    const res = loadBrand("turicks");
    if (!res.success) throw new Error(res.error);
    const brief = compileVideoBrief(res.brand, { format: "reel-9x16", topic: "proof drop" });
    expect(brief.markdown).not.toContain("Brand name unconfirmed");
  });
});

describe("planScenes", () => {
  it("scales body beats with duration: 30s→2, 55s→3, 90s→4", () => {
    expect(planScenes(30, 0).filter((s) => s.role === "body")).toHaveLength(2);
    expect(planScenes(55, 8).filter((s) => s.role === "body")).toHaveLength(3);
    expect(planScenes(90, 0).filter((s) => s.role === "body")).toHaveLength(4);
  });

  it("first body beat presents pillars when the brand has them", () => {
    const scenes = planScenes(55, 8);
    const firstBody = scenes.find((s) => s.role === "body");
    expect(firstBody?.direction).toContain("8 pillars");
  });

  it("hook stays >=3s even on the shortest video", () => {
    const scenes = planScenes(10, 0);
    expect(scenes[0]?.duration_s).toBeGreaterThanOrEqual(3);
  });
});
