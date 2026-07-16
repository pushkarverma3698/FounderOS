/**
 * Video Factory — compositing compiler tests ($0, pure).
 * The ffmpeg plan is data: offsets, trims, crops, mixes are all assertable.
 */

import { describe, it, expect } from "vitest";
import { loadBrand, type BrandProfile } from "../../../src/tools/video-brand.js";
import { compileShotList } from "../../../src/tools/video-shotlist.js";
import { compileCompositePlan, normalizeSteps, compositeStep, trimmedLength, escDrawtext, wrapCaption } from "../../../src/tools/video-compose.js";
import type { ComposePaths } from "../../../src/tools/video-compose.js";

function sl(format: "hero-16x9" | "reel-9x16" | "square-1x1" = "reel-9x16", duration = 30) {
  const res = loadBrand("the-health-place");
  if (!res.success) throw new Error(res.error);
  return compileShotList(res.brand as BrandProfile, { format, topic: "t", duration_s: duration });
}

function paths(shotlist = sl(), vo = true, music = true): ComposePaths {
  return {
    shotFiles: Object.fromEntries(shotlist.shots.map((s) => [s.id, `assets/${s.id}.mp4`])),
    workDir: "work",
    voFile: vo ? "assets/vo.mp3" : null,
    musicFile: music ? "assets/music.mp3" : null,
    outFile: "renders/out.mp4",
  };
}

describe("compileCompositePlan", () => {
  it("is deterministic", () => {
    expect(compileCompositePlan(sl(), paths())).toEqual(compileCompositePlan(sl(), paths()));
  });

  it("normalizes every shot to canvas with cover-scale + center-crop (the 1:1 path)", () => {
    const square = sl("square-1x1");
    const steps = normalizeSteps(square, paths(square));
    expect(steps).toHaveLength(square.shots.length);
    for (const step of steps) {
      const vf = step.argv[step.argv.indexOf("-vf") + 1]!;
      expect(vf).toContain("scale=1080:1080:force_original_aspect_ratio=increase");
      expect(vf).toContain("crop=1080:1080");
      expect(vf).toContain("fps=24");
    }
  });

  it("trims non-final shots with transition overlap; final shot exact", () => {
    const list = sl();
    for (let i = 0; i < list.shots.length; i++) {
      const shot = list.shots[i]!;
      const isLast = i === list.shots.length - 1;
      expect(trimmedLength(shot, isLast)).toBeCloseTo(shot.duration_s + (isLast ? 0 : shot.transition_out.duration_s), 5);
    }
  });

  it("xfade chain: overlap consumption keeps the final duration exactly on target", () => {
    const list = sl();
    const filter = compositeStep(list, paths(list)).argv.join(" ");
    // reconstruct: sum(trimmed) - sum(non-cut transitions) must equal duration
    let total = 0;
    let overlaps = 0;
    list.shots.forEach((s, i) => {
      const isLast = i === list.shots.length - 1;
      total += trimmedLength(s, isLast);
      if (!isLast && s.transition_out.type !== "cut") overlaps += s.transition_out.duration_s;
    });
    expect(total - overlaps).toBeCloseTo(list.duration_s, 5);
    expect(filter).toContain("xfade=transition=");
    expect(filter).toContain(`-t ${list.duration_s}`);
  });

  it("burns caption overlays with timeline-accurate enable windows", () => {
    const list = sl();
    const filter = compositeStep(list, paths(list)).argv.join(" ");
    const hook = list.shots[0]!;
    expect(hook.overlay_text).not.toBe("");
    expect(filter).toContain("drawtext=");
    expect(filter).toContain(`enable=between(t\\,${Math.round((hook.start_s + 0.3) * 100) / 100}`);
  });

  it("audio: VO + ducked music mix to -14 LUFS; VO-only degrades cleanly", () => {
    const list = sl();
    const both = compositeStep(list, paths(list, true, true)).argv.join(" ");
    expect(both).toContain("amix=inputs=2");
    expect(both).toContain("volume=0.22");
    expect(both).toContain("loudnorm=I=-14");

    const voOnly = compositeStep(list, paths(list, true, false)).argv.join(" ");
    expect(voOnly).not.toContain("amix");
    expect(voOnly).toContain("[vo]loudnorm");
  });

  it("ambient mode (no VO, no music): clips' native audio rides the transition grammar", () => {
    const list = sl();
    const argv = compositeStep(list, paths(list, false, false)).argv;
    const filter = argv.join(" ");
    expect(argv).not.toContain("-an");
    // one acrossfade per non-cut junction, mirroring the xfade chain
    const nonCut = list.shots.slice(0, -1).filter((s) => s.transition_out.type !== "cut").length;
    expect((filter.match(/acrossfade=d=/g) ?? []).length).toBe(nonCut);
    expect(filter).toContain("loudnorm=I=-14");
    expect(filter).toContain(`afade=t=out:st=${Math.round((list.duration_s - 1.5) * 100) / 100}:d=1.5`);

    // normalization keeps audio: veo shots resample native ambient, title cards get silence
    const norms = normalizeSteps(list, paths(list, false, false));
    const veoNorm = norms[0]!.argv.join(" ");
    expect(veoNorm).toContain("aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo");
    const cardNorm = norms.at(-1)!.argv.join(" ");
    expect(cardNorm).toContain("anullsrc");
  });

  it("ends on a fade-out and ships faststart mp4", () => {
    const list = sl();
    const argv = compositeStep(list, paths(list)).argv;
    expect(argv.join(" ")).toContain(`fade=t=out:st=${Math.round((list.duration_s - 0.6) * 100) / 100}:d=0.6`);
    expect(argv).toContain("+faststart");
  });
});

describe("escDrawtext", () => {
  it("escapes filter metacharacters and strips unsafe ones", () => {
    expect(escDrawtext("A place: to pause, breathe")).toBe("A place\\: to pause\\, breathe");
    expect(escDrawtext("50%\"off\"$")).toBe("50off");
    expect(escDrawtext("it's calm")).toBe("it\\'s calm");
  });
});

describe("wrapCaption", () => {
  it("wraps long brand copy at word boundaries — captions never clip the frame", () => {
    const long = "When an individual heals, relationships heal. When relationships heal, families heal.";
    const lines = wrapCaption(long, 30);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
    expect(lines.join(" ")).toBe(long);
  });

  it("short lines pass through unwrapped", () => {
    expect(wrapCaption("A place to pause.", 30)).toEqual(["A place to pause."]);
  });

  it("burns one drawtext per wrapped line, block-anchored", () => {
    const list = sl();
    const filter = compositeStep(list, paths(list)).argv.join(" ");
    const hookLines = wrapCaption(list.shots[0]!.overlay_text, Math.max(12, Math.floor((1080 * 0.86) / (Math.round(1080 * 0.052) * 0.55))));
    const count = (filter.match(/drawtext=/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(hookLines.length);
  });
});
