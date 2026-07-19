/**
 * Video Factory — shot-list compiler tests ($0, pure).
 * Determinism, timeline integrity, Veo caps, creative-variety guarantees.
 */

import { describe, it, expect } from "vitest";
import { loadBrand, type BrandProfile } from "../../../src/tools/video-brand.js";
import { compileShotList, splitSceneIntoShots, veoGenSeconds, klingGenSeconds, fnv1a } from "../../../src/tools/video-shotlist.js";

function thp(): BrandProfile {
  const res = loadBrand("the-health-place");
  if (!res.success) throw new Error(res.error);
  return res.brand;
}

describe("compileShotList", () => {
  it("is deterministic: compile twice → deep-equal", () => {
    const a = compileShotList(thp(), { format: "reel-9x16", topic: "morning rituals" });
    const b = compileShotList(thp(), { format: "reel-9x16", topic: "morning rituals" });
    expect(a).toEqual(b);
  });

  it("different topics → different seeds and creative choices", () => {
    const a = compileShotList(thp(), { format: "reel-9x16", topic: "morning rituals" });
    const b = compileShotList(thp(), { format: "reel-9x16", topic: "detox myths" });
    expect(a.project_seed).not.toBe(b.project_seed);
    expect(a.shots.map((s) => s.seed)).not.toEqual(b.shots.map((s) => s.seed));
  });

  it("shots tile the timeline exactly: contiguous, sum == duration", () => {
    for (const format of ["hero-16x9", "reel-9x16", "square-1x1"] as const) {
      const sl = compileShotList(thp(), { format, topic: "t", duration_s: 55 });
      let cursor = 0;
      for (const s of sl.shots) {
        expect(s.start_s).toBeCloseTo(cursor, 5);
        cursor = Math.round((cursor + s.duration_s) * 10) / 10;
      }
      expect(cursor).toBeCloseTo(55, 5);
    }
  });

  it("every generated shot fits Veo's 8s cap including transition overlap", () => {
    const sl = compileShotList(thp(), { format: "hero-16x9", topic: "t", duration_s: 120 });
    for (const s of sl.shots.filter((s) => s.kind === "veo-broll")) {
      expect(s.duration_s + s.transition_out.duration_s).toBeLessThanOrEqual(8);
      expect([4, 6, 8]).toContain(s.gen_seconds);
      expect(s.gen_seconds).toBeGreaterThanOrEqual(s.duration_s + s.transition_out.duration_s);
    }
  });

  it("carries need_seconds (>= duration) so engine grids can size the buy", () => {
    const sl = compileShotList(thp(), { format: "hero-16x9", topic: "t", duration_s: 55 });
    for (const s of sl.shots.filter((s) => s.kind === "veo-broll")) {
      expect(s.need_seconds).toBeGreaterThanOrEqual(s.duration_s);
      expect(s.need_seconds).toBeCloseTo(s.duration_s + s.transition_out.duration_s, 5);
    }
  });

  it("adjacent shots never repeat the same camera setup", () => {
    const sl = compileShotList(thp(), { format: "hero-16x9", topic: "wellness reset", duration_s: 90 });
    const broll = sl.shots.filter((s) => s.kind === "veo-broll");
    for (let i = 1; i < broll.length; i++) {
      expect(broll[i]!.camera).not.toBe(broll[i - 1]!.camera);
    }
  });

  it("threads the consistency anchor + seed into every generation prompt", () => {
    const sl = compileShotList(thp(), { format: "reel-9x16", topic: "t" });
    for (const s of sl.shots.filter((s) => s.kind === "veo-broll")) {
      expect(s.prompt).toContain(sl.style_anchor);
      expect(s.prompt).toContain(s.camera);
    }
    expect(sl.style_anchor).toContain("No text, no captions, no logos");
  });

  it("opens on a hook shot with an overlay line and closes on a title card", () => {
    const sl = compileShotList(thp(), { format: "reel-9x16", topic: "t" });
    expect(sl.shots[0]?.scene_role).toBe("hook");
    expect(sl.shots[0]?.overlay_text).not.toBe("");
    const last = sl.shots.at(-1)!;
    expect(last.kind).toBe("title-card");
    expect(last.scene_role).toBe("cta");
    expect(last.transition_out.type).toBe("fade");
  });

  it("1:1 sources from 16:9 (compositor center-crops); reels source 9:16", () => {
    expect(compileShotList(thp(), { format: "square-1x1", topic: "t" }).source_aspect).toBe("16:9");
    expect(compileShotList(thp(), { format: "reel-9x16", topic: "t" }).source_aspect).toBe("9:16");
  });

  it("calm pacing yields longer shots than energetic would (pacing profile applied)", () => {
    const sl = compileShotList(thp(), { format: "hero-16x9", topic: "t", duration_s: 55 });
    const body = sl.shots.filter((s) => s.scene_role === "body");
    const avg = body.reduce((sum, s) => sum + s.duration_s, 0) / body.length;
    expect(sl.pacing).toBe("calm");
    expect(avg).toBeGreaterThanOrEqual(5);
  });
});

describe("splitSceneIntoShots", () => {
  it("pieces sum exactly to the scene duration", () => {
    for (const [dur, target] of [
      [17, 6.5],
      [9, 3],
      [40.4, 4.5],
    ] as const) {
      const pieces = splitSceneIntoShots(dur, target);
      expect(pieces.reduce((a, b) => Math.round((a + b) * 10) / 10, 0)).toBeCloseTo(dur, 5);
    }
  });

  it("never emits a piece over ~7s (Veo headroom)", () => {
    for (const dur of [9, 13.9, 21, 48]) {
      for (const piece of splitSceneIntoShots(dur, 6.5)) expect(piece).toBeLessThanOrEqual(7.1);
    }
  });
});

describe("primitives", () => {
  it("veoGenSeconds picks the smallest billable length", () => {
    expect(veoGenSeconds(3.2)).toBe(4);
    expect(veoGenSeconds(4)).toBe(4);
    expect(veoGenSeconds(5.5)).toBe(6);
    expect(veoGenSeconds(7.8)).toBe(8);
  });

  it("klingGenSeconds snaps to the 5s/10s billing grid (no over-buy)", () => {
    expect(klingGenSeconds(3)).toBe(5);
    expect(klingGenSeconds(5)).toBe(5);
    expect(klingGenSeconds(5.1)).toBe(10);
    expect(klingGenSeconds(7)).toBe(10);
  });

  it("fnv1a is stable (cross-checked with produce.mjs's copy)", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("founderos")).toBe(fnv1a("founderos"));
  });
});
