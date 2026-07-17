/**
 * FounderOS — Video Factory: Deterministic Title-Card Generator
 * ==============================================================
 * PURE function: (brand, canvas, duration) → complete seek-safe HyperFrames
 * composition (HTML string). This removes the last LLM from the execution
 * path (audit F1): the CTA card is compiled from brand tokens by code, never
 * hand-authored, so `hyperframes check` failures cannot spawn retry loops.
 *
 * Honors the seek-safe contract from docs/VIDEO-FACTORY.md: one paused GSAP
 * timeline on window.__timelines, gsap.from entrances only, no wall-clock JS,
 * radial (never linear) glow on dark backgrounds.
 */

import type { BrandProfile } from "./video-brand.js";

export interface TitleCardSpec {
  compositionId: string;
  width: number;
  height: number;
  duration_s: number;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Generate the CTA title-card composition for a brand. */
export function generateTitleCard(brand: BrandProfile, spec: TitleCardSpec): string {
  const { width: w, height: h, duration_s: d } = spec;
  const p = brand.palette;
  const scale = Math.min(w, h) / 1080;
  const px = (n: number) => `${Math.round(n * scale)}px`;
  const contacts = [
    brand.socials["instagram"],
    brand.cta.website,
    brand.cta.phone,
  ].filter((x): x is string => Boolean(x));
  // Entrances finish by 60% of the card so short CTA scenes still land every line.
  const t = (frac: number) => Math.round(frac * d * 0.6 * 100) / 100;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${w}, height=${h}" />
    <script src="assets/vendor/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${w}px; height: ${h}px; overflow: hidden; background: ${p.background}; font-family: ${brand.typography.heading}; color: ${p.text}; }
      #root { position: relative; width: ${w}px; height: ${h}px; background: ${p.background}; }
      .glow { position: absolute; inset: 0; background: radial-gradient(ellipse ${Math.round(w * 0.62)}px ${Math.round(h * 0.74)}px at 50% 42%, ${p.surface} 0%, rgba(0,0,0,0) 70%); }
      .scene { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0 ${px(60)}; }
      .wordmark { font-size: ${px(84)}; font-weight: 600; letter-spacing: 0.2em; color: ${p.text}; text-transform: uppercase; }
      .divider { width: ${px(300)}; height: 2px; background: ${p.accent}; margin: ${px(36)} auto; }
      .cta-line { font-size: ${px(44)}; font-weight: 300; letter-spacing: 0.08em; color: ${p.muted}; }
      .contact { font-size: ${px(28)}; font-weight: 400; letter-spacing: 0.1em; color: ${p.primary}; margin-top: ${px(38)}; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="${esc(spec.compositionId)}" data-start="0" data-duration="${d}" data-width="${w}" data-height="${h}">
      <div class="glow"></div>
      <section id="cta" class="scene clip" data-start="0" data-duration="${d}" data-track-index="1">
        <div id="cta-mark" class="wordmark">${esc(brand.name)}</div>
        <div id="cta-divider" class="divider"></div>
        <div id="cta-line" class="cta-line">${esc(brand.cta.line)}</div>
        <div id="cta-contact" class="contact">${esc(contacts.join("  ·  "))}</div>
      </section>
    </div>
    <script>
      // Seek-safe contract: ONE paused timeline, absolute positions, no wall-clock JS.
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.from("#cta-mark", { opacity: 0, y: 28, duration: 1.1, ease: "power2.out" }, ${t(0.12)});
      tl.from("#cta-divider", { scaleX: 0, duration: 0.9, ease: "power2.inOut" }, ${t(0.3)});
      tl.from("#cta-line", { opacity: 0, y: 20, duration: 1.0, ease: "power1.out" }, ${t(0.45)});
      tl.from("#cta-contact", { opacity: 0, duration: 1.0, ease: "power1.out" }, ${t(0.62)});
      window.__timelines["${esc(spec.compositionId)}"] = tl;
    </script>
  </body>
</html>
`;
}
