/**
 * FounderOS — Video Factory: Model Selection Matrix
 * ==================================================
 * PURE function: (shot list, tier, budget) → per-shot engine assignment with
 * cost estimate and a typed budget verdict. Replaces the manual `--model` CLI
 * flag the audit flagged (F7): model choice is code, never a human memory or
 * a prompt instruction.
 *
 * v2 (Kling-first, image-to-video): every generated shot is a Nano Banana
 * keyframe animated by Kling (fal.ai) — the reference-image conditioning the
 * audit (F8, "green-screen-grade") was missing. Veo 3.1 is retained as an
 * automatic per-shot FALLBACK (recorded here, invoked at runtime by
 * gen-kling.mjs) so a Kling/fal outage never fails a render. Title cards stay
 * local on HyperFrames at $0. Kling clips bill on a 5s/10s grid.
 */

import { klingGenSeconds, veoGenSeconds, type ShotList, type Shot } from "./video-shotlist.js";

export type Engine = "veo" | "hyperframes" | "kling";
export type QualityTier = "premium" | "standard" | "economy";

/** Veo pricing (USD/s) — the reliability fallback, not the primary path. */
export const VEO_MODELS = {
  premium: { model: "veo-3.1-generate-preview", usd_per_s: 0.4 },
  fast: { model: "veo-3.1-fast-generate-preview", usd_per_s: 0.15 },
} as const;

/**
 * Kling image-to-video via fal.ai (USD/s). Model ids are pinned here and
 * live-verified once with FAL_KEY (see docs plan verification). `turbo` is the
 * cost/quality sweet spot for volume; `pro` is the cinematic hero tier.
 */
export const KLING_MODELS = {
  pro: { model: "fal-ai/kling-video/v3/pro/image-to-video", usd_per_s: 0.112 },
  turbo: { model: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video", usd_per_s: 0.084 },
} as const;

/** Nano Banana keyframe generators (flat USD/image) — the "draft cheap" stage. */
export const KEYFRAME_MODELS = {
  pro: { model: "gemini-3-pro-image", usd: 0.134 },
  draft: { model: "gemini-3.1-flash-image", usd: 0.01 },
} as const;

/** Flat audio estimates (ElevenLabs VO ~950 chars + Eleven Music track). */
export const AUDIO_EST_USD = { voiceover: 0.15, music: 0.2 } as const;

export interface ShotAssignment {
  shot_id: string;
  engine: Engine;
  model: string;
  /** Billable generation length on the primary engine (Kling grid: 5 or 10). */
  gen_seconds: number;
  /** Keyframe + primary animate. */
  est_cost_usd: number;
  /** Nano Banana keyframe model + cost (absent for local title cards). */
  keyframe_model?: string;
  keyframe_cost_usd?: number;
  /** Reliability path: engine/model/length used if the primary hard-fails. */
  fallback_engine?: "veo";
  fallback_model?: string;
  fallback_gen_seconds?: number;
  /** Why this model — auditability of every creative/cost decision. */
  reason: string;
}

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; component: "video-models"; reason: string; over_by_usd: number };

export interface ModelPlan {
  tier: QualityTier;
  assignments: ShotAssignment[];
  video_est_usd: number;
  audio_est_usd: number;
  total_est_usd: number;
  budget_usd: number;
  verdict: BudgetVerdict;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function assignShot(shot: Shot, tier: QualityTier): ShotAssignment {
  if (shot.kind === "title-card") {
    return {
      shot_id: shot.id,
      engine: "hyperframes",
      model: "hyperframes-local",
      gen_seconds: 0,
      est_cost_usd: 0,
      reason: "Title card renders locally from the deterministic template — $0.",
    };
  }
  // Hero fidelity for the hook (it carries the video) and for the premium tier;
  // economy forces the cost-efficient turbo path everywhere.
  const wantPro = (shot.scene_role === "hook" || tier === "premium") && tier !== "economy";
  const kling = wantPro ? KLING_MODELS.pro : KLING_MODELS.turbo;
  const keyframe = wantPro ? KEYFRAME_MODELS.pro : KEYFRAME_MODELS.draft;
  const genSeconds = klingGenSeconds(shot.need_seconds);
  const animateCost = round2(genSeconds * kling.usd_per_s);
  const veoFallback = shot.scene_role === "hook" && tier !== "economy" ? VEO_MODELS.premium : VEO_MODELS.fast;
  return {
    shot_id: shot.id,
    engine: "kling",
    model: kling.model,
    gen_seconds: genSeconds,
    est_cost_usd: round2(animateCost + keyframe.usd),
    keyframe_model: keyframe.model,
    keyframe_cost_usd: keyframe.usd,
    fallback_engine: "veo",
    fallback_model: veoFallback.model,
    fallback_gen_seconds: veoGenSeconds(shot.need_seconds),
    reason: wantPro
      ? "Hero shot: Nano Banana Pro keyframe → Kling 3.0 Pro I2V for maximum fidelity."
      : "Body/volume: draft keyframe → Kling Turbo I2V; consistency comes from the anchored keyframe + seed.",
  };
}

/**
 * Assign an engine + model to every shot and gate the total against the
 * budget. A blown budget is a typed verdict the planner surfaces to the
 * founder — never a silent downgrade, never a mid-run surprise bill.
 */
export function planModels(shotlist: ShotList, opts: { tier?: QualityTier; budget_usd?: number } = {}): ModelPlan {
  const tier = opts.tier ?? "standard";
  const budget = opts.budget_usd ?? 15;
  const assignments = shotlist.shots.map((s) => assignShot(s, tier));
  const videoEst = round2(assignments.reduce((sum, a) => sum + a.est_cost_usd, 0));
  const audioEst = round2(AUDIO_EST_USD.voiceover + AUDIO_EST_USD.music);
  const total = round2(videoEst + audioEst);
  const verdict: BudgetVerdict =
    total <= budget
      ? { ok: true }
      : {
          ok: false,
          component: "video-models",
          reason:
            `Estimated spend $${total.toFixed(2)} exceeds budget $${budget.toFixed(2)}. ` +
            `Options: tier "economy", shorter duration, or raise budget_usd explicitly.`,
          over_by_usd: round2(total - budget),
        };
  return { tier, assignments, video_est_usd: videoEst, audio_est_usd: audioEst, total_est_usd: total, budget_usd: budget, verdict };
}
