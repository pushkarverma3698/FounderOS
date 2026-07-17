/**
 * FounderOS — Video Factory: Model Selection Matrix
 * ==================================================
 * PURE function: (shot list, tier, budget) → per-shot engine assignment with
 * cost estimate and a typed budget verdict. Replaces the manual `--model` CLI
 * flag the audit flagged (F7): model choice is code, never a human memory or
 * a prompt instruction.
 *
 * Matrix logic: the hook shot carries the video — it gets the premium model
 * on standard/premium tiers. Body b-roll rides the fast tier. Title cards
 * render locally on HyperFrames at $0. Economy tier forces everything to fast.
 */

import type { ShotList, Shot } from "./video-shotlist.js";

export type Engine = "veo" | "hyperframes";
export type QualityTier = "premium" | "standard" | "economy";

/** Veo pricing (USD per generated second) — update alongside docs/VIDEO-FACTORY.md. */
export const VEO_MODELS = {
  premium: { model: "veo-3.1-generate-preview", usd_per_s: 0.4 },
  fast: { model: "veo-3.1-fast-generate-preview", usd_per_s: 0.15 },
} as const;

/** Flat audio estimates (ElevenLabs VO ~950 chars + Eleven Music track). */
export const AUDIO_EST_USD = { voiceover: 0.15, music: 0.2 } as const;

export interface ShotAssignment {
  shot_id: string;
  engine: Engine;
  model: string;
  gen_seconds: number;
  est_cost_usd: number;
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
  const wantPremium = shot.scene_role === "hook" && tier !== "economy";
  const pick = wantPremium ? VEO_MODELS.premium : VEO_MODELS.fast;
  return {
    shot_id: shot.id,
    engine: "veo",
    model: pick.model,
    gen_seconds: shot.gen_seconds,
    est_cost_usd: round2(shot.gen_seconds * pick.usd_per_s),
    reason:
      pick === VEO_MODELS.premium
        ? "Hook shot carries the video — premium model for maximum fidelity."
        : shot.scene_role === "hook"
          ? "Economy tier: hook on the fast model."
          : "Body b-roll — fast model; consistency comes from the style anchor + seed.",
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
