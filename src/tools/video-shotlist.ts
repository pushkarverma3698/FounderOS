/**
 * FounderOS — Video Factory: Shot-List Compiler
 * ==============================================
 * PURE function: (brand, request) → seeded, shot-by-shot creative plan.
 * Same inputs → deeply-equal shot list (determinism rule). Zero LLM calls.
 *
 * This is the creative-orchestration layer the audit (docs/VIDEO-PIPELINE-AUDIT.md,
 * F8) found missing: camera-angle rotation, transition grammar, pacing profiles,
 * text overlays, and a consistency anchor threaded through every generated shot.
 * Variety comes from a deterministic seed (fnv1a of brand+topic+format), so two
 * topics get different creative choices while the same request always replays
 * byte-identically.
 */

import type { BrandProfile } from "./video-brand.js";
import { planScenes, type SceneBeat, type VideoFormat } from "./video-brief.js";

export type ShotKind = "veo-broll" | "title-card";
export type TransitionType = "cut" | "fade" | "dissolve" | "slideleft" | "circleopen" | "wipeleft";

export interface ShotTransition {
  type: TransitionType;
  duration_s: number;
}

export interface Shot {
  id: string;
  scene_id: string;
  scene_role: SceneBeat["role"];
  kind: ShotKind;
  start_s: number;
  /** Exact seconds this shot occupies on the final timeline. */
  duration_s: number;
  /** Veo billing/generation length (int 4/6/8s) — clip is trimmed to duration_s + overlap. */
  gen_seconds: number;
  /** Raw timeline need (duration_s + transition overlap); engine grids derive from this. */
  need_seconds: number;
  camera: string;
  subject: string;
  /** Full generation prompt (camera + subject + consistency anchor). Empty for title cards. */
  prompt: string;
  /** Caption burned over this shot at composite time ("" = none). */
  overlay_text: string;
  /** Transition INTO the next shot (last shot: fade out). */
  transition_out: ShotTransition;
  seed: number;
}

export interface ShotList {
  brand_slug: string;
  topic: string;
  format: VideoFormat;
  /** Veo source aspect — 1:1 is produced by center-cropping 16:9 sources in post. */
  source_aspect: "16:9" | "9:16";
  canvas: { width: number; height: number };
  fps: 24;
  duration_s: number;
  pacing: BrandProfile["video"]["pacing"];
  /** Style block appended to every shot prompt — the visual-consistency contract. */
  style_anchor: string;
  vo_word_budget: number;
  music_direction: string;
  project_seed: number;
  shots: Shot[];
}

export interface ShotListRequest {
  format: VideoFormat;
  topic: string;
  duration_s?: number;
}

const CANVAS: Record<VideoFormat, { w: number; h: number; source: "16:9" | "9:16"; default_s: number }> = {
  "hero-16x9": { w: 1920, h: 1080, source: "16:9", default_s: 55 },
  "reel-9x16": { w: 1080, h: 1920, source: "9:16", default_s: 30 },
  "square-1x1": { w: 1080, h: 1080, source: "16:9", default_s: 30 },
};

/**
 * Pacing profile = the editorial rhythm. Target shot length drives the
 * shot-by-shot split of each scene; the transition set drives cut grammar.
 * Longest transition is 0.8s, and Veo clips cap at 8s generated — so target
 * lengths stay ≤ 7s to leave overlap headroom (audit F8/F11 math).
 */
const PACING: Record<
  BrandProfile["video"]["pacing"],
  { target_shot_s: number; transitions: TransitionType[]; transition_s: number }
> = {
  calm: { target_shot_s: 6.5, transitions: ["dissolve", "fade", "dissolve", "fade"], transition_s: 0.8 },
  brisk: { target_shot_s: 4.5, transitions: ["fade", "slideleft", "cut", "dissolve"], transition_s: 0.45 },
  energetic: { target_shot_s: 3, transitions: ["cut", "slideleft", "cut", "circleopen", "wipeleft"], transition_s: 0.25 },
};

/** Camera grammar — adjacent shots always rotate to a different setup. */
const CAMERA_ANGLES = [
  "sweeping aerial establishing shot, slow forward drift",
  "medium tracking shot, smooth gimbal glide",
  "intimate close-up, shallow depth of field, soft bokeh",
  "macro detail shot, textures filling the frame",
  "slow dolly-in toward the subject, deliberate and cinematic",
  "low-angle hero shot, subject framed against light",
  "top-down overhead shot, graphic composition",
  "handheld over-the-shoulder view, natural and human",
] as const;

const HOOK_CAMERAS = [
  "dramatic push-in from wide to close, high production value",
  "sweeping drone reveal, golden-hour light",
  "snap-focus close-up opening on a striking detail",
] as const;

/** 32-bit FNV-1a — tiny, stable, dependency-free deterministic hash. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Smallest Veo-billable length (4/6/8s) that covers trim + transition overlap. */
export function veoGenSeconds(needS: number): number {
  if (needS <= 4) return 4;
  if (needS <= 6) return 6;
  return 8;
}

/**
 * Kling bills only 5s or 10s clips (fal I2V grid). Snap the timeline need to
 * that grid so we buy exactly one billable tier and never over-purchase — a
 * silent ~40%/clip credit leak if we asked Veo-grid lengths of a Kling model.
 */
export function klingGenSeconds(needS: number): 5 | 10 {
  return needS <= 5 ? 5 : 10;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Split one scene beat into shots near the pacing target, exact-sum preserved. */
export function splitSceneIntoShots(sceneDurationS: number, targetShotS: number): number[] {
  // Second term hard-caps pieces at ~7s so trim + 0.8s transition overlap always
  // fits Veo's 8s generation ceiling (see veoGenSeconds).
  const n = Math.max(1, Math.round(sceneDurationS / targetShotS), Math.ceil(sceneDurationS / 7));
  const base = round1(sceneDurationS / n);
  const durations: number[] = [];
  let used = 0;
  for (let i = 0; i < n - 1; i++) {
    durations.push(base);
    used = round1(used + base);
  }
  durations.push(round1(sceneDurationS - used));
  return durations;
}

/**
 * The consistency anchor is the anti-drift mechanism: every generated shot in
 * a project carries the same style block, and every shot seeds Veo from the
 * same project seed — so 10 independent generations read as one film.
 */
export function styleAnchor(brand: BrandProfile): string {
  return (
    `Consistent visual style across every shot of this film: ${brand.industry.toLowerCase()} in ${brand.location}. ` +
    `Mood: ${brand.tone.join(", ")}. Motion language: ${brand.video.motion}. ` +
    `Cohesive color grade echoing a palette of deep ${brand.palette.background} backgrounds with ${brand.palette.accent} accents. ` +
    `Same lighting temperature and lens character in every shot, like one cinematographer shot the whole piece. ` +
    `No text, no captions, no logos, no watermarks inside the footage.` +
    (brand.video.avoid.length > 0 ? ` Avoid: ${brand.video.avoid.join("; ")}.` : "")
  );
}

function sceneSubject(scene: SceneBeat, brand: BrandProfile, topic: string, bodyIndex: number): string {
  if (scene.role === "hook") {
    return `The single most arresting visual for "${topic}" — ${brand.mission.toLowerCase()}`;
  }
  const pillar = brand.pillars[bodyIndex % Math.max(1, brand.pillars.length)];
  const audience = brand.audiences[bodyIndex % brand.audiences.length];
  return pillar
    ? `${topic} — the "${pillar}" dimension, experienced by ${audience?.toLowerCase() ?? "people"}`
    : `${topic} — one concrete moment of the story, featuring ${audience?.toLowerCase() ?? "people"}`;
}

function overlayFor(scene: SceneBeat, brand: BrandProfile, shotInScene: number, seed: number): string {
  if (shotInScene !== 0) return "";
  if (scene.role === "hook") return brand.copy_lines[seed % brand.copy_lines.length] ?? brand.tagline;
  if (scene.role === "cta") return "";
  const idx = seed % (brand.copy_lines.length + 1);
  return idx < brand.copy_lines.length ? (brand.copy_lines[idx] ?? "") : brand.tagline;
}

/** Compile a deterministic, seeded shot list from brand tokens + request. */
export function compileShotList(brand: BrandProfile, req: ShotListRequest): ShotList {
  const spec = CANVAS[req.format];
  const duration = Math.min(120, Math.max(10, Math.round(req.duration_s ?? spec.default_s)));
  const pacing = PACING[brand.video.pacing];
  const projectSeed = fnv1a(`${brand.slug}:${req.topic}:${req.format}:${duration}`);
  const anchor = styleAnchor(brand);
  const scenes = planScenes(duration, brand.pillars.length);

  const shots: Shot[] = [];
  let cursor = 0;
  let bodyIndex = 0;
  for (const scene of scenes) {
    // CTA is a deterministic title card (video-title-card.ts) — never generated footage,
    // never hand-authored: this is what removes the claude_code loop (audit F1).
    if (scene.role === "cta") {
      shots.push({
        id: `sh-${String(shots.length + 1).padStart(2, "0")}`,
        scene_id: scene.id,
        scene_role: "cta",
        kind: "title-card",
        start_s: round1(cursor),
        duration_s: round1(scene.duration_s),
        gen_seconds: 0,
        camera: "static title card, GSAP staggered entrances",
        subject: `${brand.name} wordmark + CTA`,
        prompt: "",
        need_seconds: 0,
        overlay_text: "",
        transition_out: { type: "fade", duration_s: pacing.transition_s },
        seed: fnv1a(`${projectSeed}:cta`),
      });
      cursor += scene.duration_s;
      continue;
    }

    const pieces = splitSceneIntoShots(scene.duration_s, scene.role === "hook" ? Math.min(pacing.target_shot_s, scene.duration_s) : pacing.target_shot_s);
    for (let i = 0; i < pieces.length; i++) {
      const idx = shots.length;
      const seed = fnv1a(`${projectSeed}:${idx}`);
      const camera =
        scene.role === "hook" && i === 0
          ? HOOK_CAMERAS[seed % HOOK_CAMERAS.length]!
          : CAMERA_ANGLES[(seed + idx) % CAMERA_ANGLES.length]!;
      const prevCamera = shots.at(-1)?.camera;
      const finalCamera = camera === prevCamera ? CAMERA_ANGLES[(seed + idx + 1) % CAMERA_ANGLES.length]! : camera;
      const subject = sceneSubject(scene, brand, req.topic, bodyIndex);
      if (scene.role === "body" && i === pieces.length - 1) bodyIndex++;
      const transition = pacing.transitions[idx % pacing.transitions.length]!;
      const durationS = pieces[i]!;
      const overlap = transition === "cut" ? 0 : pacing.transition_s;
      const needS = round1(durationS + overlap);
      shots.push({
        id: `sh-${String(idx + 1).padStart(2, "0")}`,
        scene_id: scene.id,
        scene_role: scene.role,
        kind: "veo-broll",
        start_s: round1(cursor),
        duration_s: durationS,
        gen_seconds: veoGenSeconds(needS),
        need_seconds: needS,
        camera: finalCamera,
        subject,
        prompt: `${finalCamera}. ${subject}. ${anchor}`,
        overlay_text: overlayFor(scene, brand, i, seed),
        transition_out: { type: transition, duration_s: transition === "cut" ? 0 : pacing.transition_s },
        seed,
      });
      cursor = round1(cursor + durationS);
    }
  }

  // Last shot always resolves with a fade — never a hard cut to black.
  const last = shots.at(-1)!;
  last.transition_out = { type: "fade", duration_s: 0.6 };

  return {
    brand_slug: brand.slug,
    topic: req.topic,
    format: req.format,
    source_aspect: spec.source,
    canvas: { width: spec.w, height: spec.h },
    fps: 24,
    duration_s: duration,
    pacing: brand.video.pacing,
    style_anchor: anchor,
    vo_word_budget: Math.round((duration / 60) * 160),
    music_direction: `${brand.video.music}; pacing: ${brand.video.pacing}; instrumental only, no vocals`,
    project_seed: projectSeed,
    shots,
  };
}
