/**
 * FounderOS — Video Factory: Production Plan + Receipt-Derived State
 * ===================================================================
 * The persistence model that eradicates try-again loops (audit F1–F6):
 *
 *   1. The PLAN is immutable data — an ordered step DAG compiled here, once,
 *      by pure code, and written to <project>/production.json (checkpoint 0).
 *   2. STATE is never mutated — it is DERIVED from receipts on disk
 *      (<project>/receipts/<step>.json). A receipt is valid only if its key
 *      matches the step's content hash; edit the plan and stale receipts
 *      invalidate themselves. Crash-safe and resumable by construction.
 *   3. RETRIES are bounded: a step whose receipt records >= max_attempts
 *      failures is terminally failed and the production halts loud, naming
 *      the component — never an infinite poll or an LLM guessing again.
 *
 * Pure logic only (compile + derive); the executor lives in
 * video-factory/scripts/produce.mjs and just replays this data.
 */

import { z } from "zod";
import { fnv1a, type ShotList } from "./video-shotlist.js";
import type { ModelPlan } from "./video-models.js";
import { compileCompositePlan } from "./video-compose.js";

export const MAX_ATTEMPTS = 2;

export const ProductionStepSchema = z.object({
  id: z.string(),
  kind: z.enum(["copy", "keyframe", "kling", "veo", "hyperframes", "elevenlabs-vo", "elevenlabs-music", "probe", "ffmpeg"]),
  /** Kind-specific parameters — the executor's entire instruction set. */
  params: z.record(z.string(), z.unknown()),
  needs: z.array(z.string()).default([]),
  produces: z.string().default(""),
  est_cost_usd: z.number().default(0),
});
export type ProductionStep = z.infer<typeof ProductionStepSchema>;

export const ProductionPlanSchema = z.object({
  version: z.literal(1),
  project: z.string(),
  brand_slug: z.string(),
  topic: z.string(),
  format: z.string(),
  duration_s: z.number(),
  canvas: z.object({ width: z.number(), height: z.number() }),
  total_est_usd: z.number(),
  max_attempts: z.number(),
  steps: z.array(ProductionStepSchema),
});
export type ProductionPlan = z.infer<typeof ProductionPlanSchema>;

export const StepReceiptSchema = z.object({
  step_id: z.string(),
  /** Content hash of the step at execution time — stale plans self-invalidate. */
  key: z.string(),
  ok: z.boolean(),
  attempts: z.number(),
  sha256: z.string().optional(),
  probe: z.object({ duration_s: z.number(), width: z.number().optional(), height: z.number().optional() }).optional(),
  /** Which engine actually produced the clip ("kling" | "veo") — records fallbacks. */
  engine_used: z.string().optional(),
  error: z.string().optional(),
});
export type StepReceipt = z.infer<typeof StepReceiptSchema>;

/** Deterministic content key for a step — the idempotency mechanism (audit F4). */
export function stepKey(step: ProductionStep): string {
  return fnv1a(JSON.stringify({ id: step.id, kind: step.kind, params: step.params, produces: step.produces })).toString(16);
}

export type StepStatus = "done" | "ready" | "blocked" | "failed";
export type ProductionPhase = "generating" | "compositing" | "delivered" | "failed";

export interface ProductionStatus {
  phase: ProductionPhase;
  steps: Array<{ id: string; kind: ProductionStep["kind"]; status: StepStatus; attempts: number; error?: string }>;
  /** Step ids executable right now (deps done, not failed, receipt missing/stale). */
  next: string[];
  /** Terminal failures — component named, evidence attached. */
  failures: Array<{ step_id: string; kind: string; attempts: number; error: string }>;
  pending_cost_usd: number;
}

/**
 * Derive the production state from plan + receipts. Pure — the executor and
 * the agent status tool both call this, so there is exactly one definition
 * of "where are we" and it is unit-tested.
 */
export function deriveStatus(plan: ProductionPlan, receipts: Record<string, StepReceipt>): ProductionStatus {
  const statuses = new Map<string, StepStatus>();
  const rows: ProductionStatus["steps"] = [];
  const failures: ProductionStatus["failures"] = [];
  let pendingCost = 0;

  for (const step of plan.steps) {
    const r = receipts[step.id];
    const fresh = r !== undefined && r.key === stepKey(step);
    const attempts = fresh ? r.attempts : 0;
    let status: StepStatus;
    if (fresh && r.ok) {
      status = "done";
    } else if (fresh && attempts >= plan.max_attempts) {
      status = "failed";
      failures.push({ step_id: step.id, kind: step.kind, attempts, error: r.error ?? "unknown failure" });
    } else if (step.needs.every((d) => statuses.get(d) === "done")) {
      status = "ready";
    } else {
      status = "blocked";
    }
    statuses.set(step.id, status);
    if (status !== "done") pendingCost += step.est_cost_usd;
    const row: ProductionStatus["steps"][number] = { id: step.id, kind: step.kind, status, attempts };
    if (fresh && !r.ok && r.error) row.error = r.error;
    rows.push(row);
  }

  const allDone = rows.every((s) => s.status === "done");
  const anyFailed = failures.length > 0;
  const compositeDone = statuses.get("qa-final") === "done";
  const generating = rows.some((s) => (s.kind === "keyframe" || s.kind === "kling" || s.kind === "veo" || s.kind === "elevenlabs-vo" || s.kind === "elevenlabs-music" || s.kind === "hyperframes") && s.status !== "done");
  const phase: ProductionPhase = anyFailed ? "failed" : allDone && compositeDone ? "delivered" : generating ? "generating" : "compositing";

  return {
    phase,
    steps: rows,
    next: rows.filter((s) => s.status === "ready").map((s) => s.id),
    failures,
    pending_cost_usd: Math.round(pendingCost * 100) / 100,
  };
}

export interface CompileProductionOptions {
  project: string;
  vo_script?: string;
  include_music?: boolean;
}

/** Assemble the full step DAG: generate → verify → normalize → composite → QA. */
export function compileProductionPlan(shotlist: ShotList, models: ModelPlan, opts: CompileProductionOptions): ProductionPlan {
  const steps: ProductionStep[] = [];
  const byShot = new Map(models.assignments.map((a) => [a.shot_id, a]));

  steps.push({
    id: "vendor-gsap",
    kind: "copy",
    params: { from: "node_modules/gsap/dist/gsap.min.js", to: "assets/vendor/gsap.min.js" },
    needs: [],
    produces: "assets/vendor/gsap.min.js",
    est_cost_usd: 0,
  });

  const genIds: string[] = [];
  for (const shot of shotlist.shots) {
    const assign = byShot.get(shot.id);
    const file = `assets/${shot.id}.mp4`;
    const genId = `gen-${shot.id}`;
    if (shot.kind === "title-card") {
      steps.push({
        id: genId,
        kind: "hyperframes",
        params: { composition: "cta.html", quality: "standard" },
        needs: ["vendor-gsap"],
        produces: file,
        est_cost_usd: 0,
      });
    } else {
      // Image-to-video: a cheap Nano Banana keyframe is generated + verified,
      // THEN animated by Kling (Gate 2 — never pay to animate an unmade frame).
      // Kling hard-failures fall back to Veo inside gen-kling.mjs (recorded in
      // engine_used). The keyframe carries no camera-motion verbs — it is a still.
      const keyframeFile = `assets/${shot.id}.keyframe.png`;
      const keyframeCost = assign?.keyframe_cost_usd ?? 0;
      steps.push({
        id: `keyframe-${shot.id}`,
        kind: "keyframe",
        params: {
          prompt: `${shot.subject}. ${shotlist.style_anchor}`,
          model: assign?.keyframe_model ?? "gemini-3.1-flash-image",
          aspect: shotlist.source_aspect,
          seed: shot.seed,
        },
        needs: [],
        produces: keyframeFile,
        est_cost_usd: keyframeCost,
      });
      steps.push({
        id: genId,
        kind: "kling",
        params: {
          prompt: shot.prompt,
          image: keyframeFile,
          model: assign?.model ?? "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
          aspect: shotlist.source_aspect,
          duration_s: assign?.gen_seconds ?? 5,
          seed: shot.seed,
          fallback_model: assign?.fallback_model ?? "veo-3.1-fast-generate-preview",
          fallback_duration_s: assign?.fallback_gen_seconds ?? shot.gen_seconds,
        },
        needs: [`keyframe-${shot.id}`],
        produces: file,
        est_cost_usd: Math.round(((assign?.est_cost_usd ?? 0) - keyframeCost) * 100) / 100,
      });
    }
    const isLast = shot === shotlist.shots.at(-1);
    steps.push({
      id: `verify-${shot.id}`,
      kind: "probe",
      params: { file, min_duration_s: Math.round((shot.duration_s + (isLast ? 0 : shot.transition_out.duration_s)) * 10) / 10 },
      needs: [genId],
      produces: "",
      est_cost_usd: 0,
    });
    genIds.push(`verify-${shot.id}`);
  }

  const voFile = opts.vo_script ? "assets/vo.mp3" : null;
  if (opts.vo_script) {
    steps.push({
      id: "gen-vo",
      kind: "elevenlabs-vo",
      params: { text: opts.vo_script, seed: shotlist.project_seed },
      needs: [],
      produces: "assets/vo.mp3",
      est_cost_usd: 0.15,
    });
    // VO must FIT the timeline — fail loud, never silently stretch (audit F10).
    steps.push({
      id: "verify-vo",
      kind: "probe",
      params: { file: "assets/vo.mp3", max_duration_s: Math.max(1, shotlist.duration_s - 0.5), remedy: "VO longer than the video — shorten the script and re-plan." },
      needs: ["gen-vo"],
      produces: "",
      est_cost_usd: 0,
    });
    genIds.push("verify-vo");
  }
  const musicFile = opts.include_music !== false ? "assets/music.mp3" : null;
  if (musicFile) {
    steps.push({
      id: "gen-music",
      kind: "elevenlabs-music",
      params: { prompt: shotlist.music_direction, duration_ms: shotlist.duration_s * 1000 },
      needs: [],
      produces: musicFile,
      est_cost_usd: 0.2,
    });
    genIds.push("gen-music");
  }

  const shotFiles = Object.fromEntries(shotlist.shots.map((s) => [s.id, `assets/${s.id}.mp4`]));
  const ffSteps = compileCompositePlan(shotlist, {
    shotFiles,
    workDir: "work",
    voFile,
    musicFile,
    outFile: `renders/${opts.project}.mp4`,
  });
  for (const ff of ffSteps) {
    const isComposite = ff.id === "composite";
    steps.push({
      id: ff.id,
      kind: "ffmpeg",
      params: { argv: ff.argv },
      needs: isComposite ? [...genIds, ...ffSteps.filter((s) => s.id !== "composite").map((s) => s.id)] : genIds,
      produces: ff.produces,
      est_cost_usd: 0,
    });
  }

  steps.push({
    id: "qa-final",
    kind: "probe",
    params: {
      file: `renders/${opts.project}.mp4`,
      min_duration_s: shotlist.duration_s - 0.5,
      max_duration_s: shotlist.duration_s + 0.5,
      width: shotlist.canvas.width,
      height: shotlist.canvas.height,
    },
    needs: ["composite"],
    produces: "",
    est_cost_usd: 0,
  });

  return {
    version: 1,
    project: opts.project,
    brand_slug: shotlist.brand_slug,
    topic: shotlist.topic,
    format: shotlist.format,
    duration_s: shotlist.duration_s,
    canvas: shotlist.canvas,
    total_est_usd: models.total_est_usd,
    max_attempts: MAX_ATTEMPTS,
    steps,
  };
}
