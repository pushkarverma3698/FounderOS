/**
 * FounderOS — Video Factory: Brief Compiler
 * ==========================================
 * PURE function: (brand, request) → deterministic production brief.
 * Same inputs → byte-identical brief (determinism rule: routing/parsing/
 * composition logic is code, never prompt instructions). Zero LLM calls.
 *
 * The brief is the contract between the kernel and whatever executes the
 * production: the local HyperFrames CLI in video-factory/ (today's path,
 * driven by claude_code or a human), or Veo/ElevenLabs enrichment later.
 */

import type { BrandProfile } from "./video-brand.js";

export type VideoFormat = "hero-16x9" | "reel-9x16" | "square-1x1";

export interface VideoBriefRequest {
  format: VideoFormat;
  /** What the video is about, e.g. "launch hero", "myth-busting: detox teas". */
  topic: string;
  /** Target length in seconds. Defaults per format. */
  duration_s?: number;
}

export interface SceneBeat {
  id: string;
  role: "hook" | "body" | "cta";
  start_s: number;
  duration_s: number;
  direction: string;
}

export interface VideoBrief {
  brand_slug: string;
  format: VideoFormat;
  aspect_ratio: "16:9" | "9:16" | "1:1";
  canvas: { width: number; height: number };
  duration_s: number;
  /** ~160 spoken words per 60s — always brief by WORD COUNT, never by seconds. */
  vo_word_budget: number;
  scenes: SceneBeat[];
  /** Rendered markdown brief for the executor (claude_code / human / agent). */
  markdown: string;
}

const FORMAT_SPECS: Record<VideoFormat, { ratio: "16:9" | "9:16" | "1:1"; w: number; h: number; default_s: number; file: string }> = {
  "hero-16x9": { ratio: "16:9", w: 1920, h: 1080, default_s: 55, file: "index.html" },
  "reel-9x16": { ratio: "9:16", w: 1080, h: 1920, default_s: 30, file: "index-vertical.html" },
  "square-1x1": { ratio: "1:1", w: 1080, h: 1080, default_s: 30, file: "index-square.html" },
};

const MIN_DURATION_S = 10;
const MAX_DURATION_S = 120;
const WORDS_PER_MINUTE = 160;

/** Deterministic scene plan: hook (first ~10%), body beats, CTA (last ~10%). */
export function planScenes(durationS: number, pillarsCount: number): SceneBeat[] {
  const hookS = Math.max(3, Math.round(durationS * 0.11));
  const ctaS = Math.max(4, Math.round(durationS * 0.1));
  const bodyS = durationS - hookS - ctaS;
  // 2 body beats under 40s, 3 at 40s+, 4 at 75s+ — enough dwell per beat for calm pacing.
  const bodyBeats = durationS >= 75 ? 4 : durationS >= 40 ? 3 : 2;
  const per = bodyS / bodyBeats;

  const scenes: SceneBeat[] = [
    {
      id: "s1-hook",
      role: "hook",
      start_s: 0,
      duration_s: hookS,
      direction: "Hook in the first 3 seconds — strongest brand line, muted-viewer readable.",
    },
  ];
  let cursor = hookS;
  for (let i = 0; i < bodyBeats; i++) {
    const d = i === bodyBeats - 1 ? bodyS - Math.round(per) * (bodyBeats - 1) : Math.round(per);
    scenes.push({
      id: `s${i + 2}-body`,
      role: "body",
      start_s: cursor,
      duration_s: d,
      direction:
        i === 0 && pillarsCount > 0
          ? `Present the ${pillarsCount} pillars visually (grid/orbit), staggered entrances.`
          : "One atomic idea per beat; every element animates IN (gsap.from), no exits.",
    });
    cursor += d;
  }
  scenes.push({
    id: `s${bodyBeats + 2}-cta`,
    role: "cta",
    start_s: cursor,
    duration_s: durationS - cursor,
    direction: "Wordmark + CTA line + contact/socials. Final scene is the only place an exit may exist.",
  });
  return scenes;
}

/** Compile a deterministic production brief from brand tokens + request. */
export function compileVideoBrief(brand: BrandProfile, req: VideoBriefRequest): VideoBrief {
  const spec = FORMAT_SPECS[req.format];
  const duration = Math.min(MAX_DURATION_S, Math.max(MIN_DURATION_S, Math.round(req.duration_s ?? spec.default_s)));
  const voWords = Math.round((duration / 60) * WORDS_PER_MINUTE);
  const scenes = planScenes(duration, brand.pillars.length);

  const sceneLines = scenes
    .map((s) => `| ${s.id} | ${s.start_s}s | ${s.duration_s}s | ${s.direction} |`)
    .join("\n");
  const socials = Object.entries(brand.socials)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");

  const markdown = [
    `# Production Brief — ${brand.name} · ${req.topic}`,
    ``,
    `- **Format**: ${req.format} (${spec.ratio}, ${spec.w}x${spec.h}) → author \`${spec.file}\``,
    `- **Duration**: ${duration}s · **VO budget**: ~${voWords} words (words, not seconds)`,
    `- **Pacing**: ${brand.video.pacing} · **Motion**: ${brand.video.motion}`,
    `- **Captions**: ${brand.video.captions} (majority watch muted — text must carry the story)`,
    `- **Music**: ${brand.video.music} · **Voice**: ${brand.video.voice.style} (${brand.video.voice.language})`,
    ``,
    `## Brand tokens`,
    `- Palette: bg ${brand.palette.background} · surface ${brand.palette.surface} · primary ${brand.palette.primary} · text ${brand.palette.text} · muted ${brand.palette.muted} · accent ${brand.palette.accent}`,
    `- Typography: ${brand.typography.style}`,
    `- Tone: ${brand.tone.join(", ")}`,
    `- Tagline: ${brand.tagline}`,
    brand.pillars.length > 0 ? `- ${brand.pillars_label || "Pillars"}: ${brand.pillars.join(", ")}` : ``,
    `- Audiences: ${brand.audiences.join(", ")}`,
    `- Copy bank: ${brand.copy_lines.map((l) => `"${l}"`).join(" / ")}`,
    `- CTA: ${brand.cta.line} — ${brand.cta.website}${brand.cta.phone ? ` · ${brand.cta.phone}` : ""}${socials ? ` · ${socials}` : ""}`,
    brand.video.avoid.length > 0 ? `- AVOID: ${brand.video.avoid.join("; ")}` : ``,
    ``,
    `## Scene plan`,
    `| scene | start | duration | direction |`,
    `|---|---|---|---|`,
    sceneLines,
    ``,
    `## Execution (video-factory/, local HyperFrames — $0 render)`,
    `1. Author \`${spec.file}\` in a project under video-factory/projects/ — seek-safe contract:`,
    `   one \`gsap.timeline({paused:true})\` on \`window.__timelines\`, no wall-clock JS, no repeat:-1.`,
    `2. Gate: \`hyperframes lint && hyperframes check\` must pass (0 errors, WCAG AA).`,
    `3. Render: \`hyperframes render -o renders/<name>.mp4 --quality standard\`.`,
    brand.canonical_name_confirmed ? `` : `4. ⚠ Brand name unconfirmed with client — flag before external delivery.`,
  ]
    .filter((l) => l !== ``)
    .join("\n");

  return {
    brand_slug: brand.slug,
    format: req.format,
    aspect_ratio: spec.ratio,
    canvas: { width: spec.w, height: spec.h },
    duration_s: duration,
    vo_word_budget: voWords,
    scenes,
    markdown,
  };
}
