/**
 * Video Factory — title-card generator tests ($0, pure).
 * The generated composition must honor the seek-safe contract mechanically.
 */

import { describe, it, expect } from "vitest";
import { loadBrand, type BrandProfile } from "../../../src/tools/video-brand.js";
import { generateTitleCard } from "../../../src/tools/video-title-card.js";

function thp(): BrandProfile {
  const res = loadBrand("the-health-place");
  if (!res.success) throw new Error(res.error);
  return res.brand;
}

const spec = { compositionId: "test-cta", width: 1080, height: 1920, duration_s: 5 };

describe("generateTitleCard", () => {
  it("is deterministic", () => {
    expect(generateTitleCard(thp(), spec)).toBe(generateTitleCard(thp(), spec));
  });

  it("honors the seek-safe contract: one paused timeline, no wall-clock JS, no infinite repeats", () => {
    const html = generateTitleCard(thp(), spec);
    expect(html).toContain("gsap.timeline({ paused: true })");
    expect(html).toContain('window.__timelines["test-cta"]');
    expect(html).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|Date\.now|Math\.random/);
    expect(html).not.toContain("repeat: -1");
    // entrances only, via gsap.from — no exits, no tweens-to
    expect(html).not.toContain("tl.to(");
    expect(html.match(/tl\.from\(/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain("linear-gradient");
    expect(html).toContain("radial-gradient");
  });

  it("declares clip metadata and canvas dimensions", () => {
    const html = generateTitleCard(thp(), spec);
    expect(html).toContain('data-composition-id="test-cta"');
    expect(html).toContain('data-duration="5"');
    expect(html).toContain('data-width="1080"');
    expect(html).toContain('data-height="1920"');
    expect(html).toContain('class="scene clip"');
    expect(html).toContain('data-track-index="1"');
  });

  it("carries brand tokens: palette, name, CTA line, contacts — HTML-escaped", () => {
    const brand = thp();
    const html = generateTitleCard(brand, spec);
    expect(html).toContain(brand.palette.background);
    expect(html).toContain(brand.palette.accent);
    expect(html).toContain("The Health Place");
    expect(html).toContain("Begin your wellness journey.");
    expect(html).toContain("thehealthplace.in");

    const spicy = { ...brand, name: `<script>alert("x")</script>` };
    expect(generateTitleCard(spicy, spec)).not.toContain(`<script>alert`);
  });

  it("scales entrance timings into the card duration (all land by 60%)", () => {
    const short = generateTitleCard(thp(), { ...spec, duration_s: 4 });
    const times = [...short.matchAll(/}, ([\d.]+)\);/g)].map((m) => Number(m[1]));
    expect(Math.max(...times)).toBeLessThanOrEqual(4 * 0.6 + 0.01);
  });
});
