/**
 * FounderOS — Video Factory Tools (agent interface)
 * ==================================================
 * Marketing-department tools for the productized social-video service:
 *   list_video_brands   — enumerate registered client brand profiles (read).
 *   compile_video_brief — deterministic (brand, request) → production brief (read, $0).
 *
 * Both are PURE reads: no LLM, no network, no side effects — so neither is
 * HITL-gated. The brief is the contract handed to the executor (claude_code in
 * the video-factory/ workspace, or a human) which runs the local HyperFrames
 * render at $0 API cost. Publishing a finished video still goes through the
 * existing comms/marketing publish gates.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { listBrands, loadBrand } from "../../tools/video-brand.js";
import { compileVideoBrief } from "../../tools/video-brief.js";
import { compileShotList } from "../../tools/video-shotlist.js";
import { planModels, type QualityTier } from "../../tools/video-models.js";
import { generateTitleCard } from "../../tools/video-title-card.js";
import {
  compileProductionPlan,
  deriveStatus,
  ProductionPlanSchema,
  StepReceiptSchema,
  type StepReceipt,
} from "../../tools/video-production.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "agent-tool:video" });

function projectsDir(): string {
  return process.env["VIDEO_PROJECTS_DIR"] ?? join(process.cwd(), "video-factory", "projects");
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "video";
}

export const listVideoBrandsTool = tool(
  async () => {
    const slugs = listBrands();
    if (slugs.length === 0) {
      return "No brands registered in video-factory/brands/. Onboard one per video-factory/brands/README.md.";
    }
    const rows = slugs.map((slug) => {
      const res = loadBrand(slug);
      return res.success
        ? { slug, name: res.brand.name, industry: res.brand.industry, formats: res.brand.video.aspect_ratios, confirmed: res.brand.canonical_name_confirmed }
        : { slug, error: res.error };
    });
    return JSON.stringify(rows);
  },
  {
    name: "list_video_brands",
    description:
      "List client brand profiles registered in the Video Factory (video-factory/brands/). " +
      "Returns JSON [{slug, name, industry, formats, confirmed}]. Use a slug with " +
      "compile_video_brief to plan a video for that client.",
    schema: z.object({}),
  },
);

export const compileVideoBriefTool = tool(
  async ({ brand_slug, format, topic, duration_s }) => {
    const res = loadBrand(brand_slug);
    if (!res.success) return `compile_video_brief failed (brand registry): ${res.error}`;
    const brief = compileVideoBrief(res.brand, {
      format,
      topic,
      ...(typeof duration_s === "number" ? { duration_s } : {}),
    });
    log.info({ brand: brand_slug, format, duration: brief.duration_s }, "video brief compiled");
    return brief.markdown;
  },
  {
    name: "compile_video_brief",
    description:
      "Compile a deterministic video production brief from a registered brand profile. " +
      "Formats: hero-16x9 (launch/website), reel-9x16 (Instagram/Shorts), square-1x1 (feed). " +
      "Returns a markdown brief with brand tokens, scene plan, VO word budget, and the " +
      "local HyperFrames execution steps. $0 — pure code, no model call. Hand the brief " +
      "to claude_code (engineering) to author + render in video-factory/, or to the founder.",
    schema: z.object({
      brand_slug: z.string().describe("Registered brand slug, e.g. 'the-health-place' (see list_video_brands)."),
      format: z.enum(["hero-16x9", "reel-9x16", "square-1x1"]).describe("Output format/aspect."),
      topic: z.string().describe("What the video is about, e.g. 'launch hero' or 'myth-busting: crash diets'."),
      duration_s: z.number().optional().nullable().describe("Target seconds (10–120). Defaults: hero 55s, reel/square 30s."),
    }),
  },
);

const FormatEnum = z.enum(["hero-16x9", "reel-9x16", "square-1x1"]);

export const compileShotListTool = tool(
  async ({ brand_slug, format, topic, duration_s, tier, budget_usd }) => {
    const res = loadBrand(brand_slug);
    if (!res.success) return `compile_shot_list failed (brand registry): ${res.error}`;
    const shotlist = compileShotList(res.brand, { format, topic, ...(typeof duration_s === "number" ? { duration_s } : {}) });
    const models = planModels(shotlist, {
      ...(tier ? { tier: tier as QualityTier } : {}),
      ...(typeof budget_usd === "number" ? { budget_usd } : {}),
    });
    const byShot = new Map(models.assignments.map((a) => [a.shot_id, a]));
    const rows = shotlist.shots
      .map((s) => {
        const a = byShot.get(s.id);
        return `| ${s.id} | ${s.scene_role} | ${s.duration_s}s | ${s.camera} | ${s.transition_out.type} | ${a?.model ?? "?"} | $${(a?.est_cost_usd ?? 0).toFixed(2)} |`;
      })
      .join("\n");
    return [
      `# Shot list — ${shotlist.brand_slug} · ${shotlist.topic} (${shotlist.format}, ${shotlist.duration_s}s, ${shotlist.pacing})`,
      ``,
      `| shot | scene | dur | camera | out-transition | model | est |`,
      `|---|---|---|---|---|---|---|`,
      rows,
      ``,
      `- VO budget: ~${shotlist.vo_word_budget} words · Music: ${shotlist.music_direction}`,
      `- Estimated spend: video $${models.video_est_usd.toFixed(2)} + audio $${models.audio_est_usd.toFixed(2)} = **$${models.total_est_usd.toFixed(2)}** (budget $${models.budget_usd.toFixed(2)})`,
      models.verdict.ok ? `- Budget: OK` : `- ⚠ BUDGET EXCEEDED: ${models.verdict.reason}`,
      `- Style anchor threaded through every shot; project seed ${shotlist.project_seed}.`,
      `- Next: plan_video_production to write the executable production plan.`,
    ].join("\n");
  },
  {
    name: "compile_shot_list",
    description:
      "Compile a deterministic shot-by-shot creative plan (camera angles, transitions, pacing, " +
      "caption overlays, per-shot model + cost) for a brand video. $0 — pure code, no model call. " +
      "Preview step before plan_video_production.",
    schema: z.object({
      brand_slug: z.string().describe("Registered brand slug (see list_video_brands)."),
      format: FormatEnum.describe("Output format/aspect."),
      topic: z.string().describe("What the video is about."),
      duration_s: z.number().optional().nullable().describe("Target seconds (10–120)."),
      tier: z.enum(["premium", "standard", "economy"]).optional().nullable().describe("Quality tier (default standard)."),
      budget_usd: z.number().optional().nullable().describe("Spend cap for the estimate gate (default $15)."),
    }),
  },
);

export const planVideoProductionTool = tool(
  async ({ brand_slug, format, topic, duration_s, tier, budget_usd, vo_script, include_music }) => {
    const res = loadBrand(brand_slug);
    if (!res.success) return `plan_video_production failed (brand registry): ${res.error}`;
    const shotlist = compileShotList(res.brand, { format, topic, ...(typeof duration_s === "number" ? { duration_s } : {}) });
    const models = planModels(shotlist, {
      ...(tier ? { tier: tier as QualityTier } : {}),
      ...(typeof budget_usd === "number" ? { budget_usd } : {}),
    });
    if (!models.verdict.ok) {
      return `plan_video_production refused (video-models budget gate): ${models.verdict.reason}`;
    }
    if (vo_script) {
      const words = vo_script.trim().split(/\s+/).length;
      const cap = Math.round(shotlist.vo_word_budget * 1.2);
      if (words > cap) {
        return (
          `plan_video_production refused (vo-script over budget): script is ${words} words; ` +
          `budget for ${shotlist.duration_s}s is ~${shotlist.vo_word_budget} (hard cap ${cap}). Shorten the script — never speed up the voice.`
        );
      }
    }
    const project = `${brand_slug}--${slugify(topic)}--${format}`;
    const plan = compileProductionPlan(shotlist, models, {
      project,
      ...(vo_script ? { vo_script } : {}),
      ...(include_music === false ? { include_music: false } : {}),
    });
    const cta = shotlist.shots.find((s) => s.kind === "title-card");
    const dir = join(projectsDir(), project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "production.json"), JSON.stringify({ plan, shotlist }, null, 2));
    if (cta) {
      writeFileSync(
        join(dir, "cta.html"),
        generateTitleCard(res.brand, {
          compositionId: `${project}-cta`,
          width: shotlist.canvas.width,
          height: shotlist.canvas.height,
          duration_s: cta.duration_s,
        }),
      );
    }
    log.info({ project, steps: plan.steps.length, est: models.total_est_usd }, "production plan written");
    return [
      `Production plan written: video-factory/projects/${project}/production.json (${plan.steps.length} steps, est $${models.total_est_usd.toFixed(2)}).`,
      `Shots: ${shotlist.shots.length} (${shotlist.shots.filter((s) => s.kind === "veo-broll").length} generated + CTA title card). VO: ${vo_script ? "scripted" : "none"}. Music: ${include_music === false ? "no" : "yes"}.`,
      `Execute (idempotent, receipt-checkpointed, bounded retries):`,
      `  cd video-factory && node scripts/produce.mjs --project projects/${project} --approve-spend ${Math.ceil(models.total_est_usd)}`,
      `Re-running only executes missing/failed-once steps — paid steps can never double-bill.`,
    ].join("\n");
  },
  {
    name: "plan_video_production",
    description:
      "Compile a COMPLETE executable video production plan (shot list → per-shot Nano Banana keyframe → " +
      "Kling image-to-video, Veo fallback → ffmpeg composite with transitions/captions/audio mix → QA) and write it to " +
      "video-factory/projects/<project>/production.json plus a deterministic CTA title card. " +
      "$0 and side-effect-free beyond local files — actual paid generation happens only when the " +
      "founder (or claude_code with approval) runs produce.mjs, which is budget-gated and idempotent. " +
      "Optionally pass vo_script (must fit the word budget from compile_shot_list).",
    schema: z.object({
      brand_slug: z.string().describe("Registered brand slug."),
      format: FormatEnum.describe("Output format/aspect."),
      topic: z.string().describe("What the video is about."),
      duration_s: z.number().optional().nullable().describe("Target seconds (10–120)."),
      tier: z.enum(["premium", "standard", "economy"]).optional().nullable().describe("Quality tier (default standard)."),
      budget_usd: z.number().optional().nullable().describe("Hard spend cap (default $15) — plan is refused above it."),
      vo_script: z.string().optional().nullable().describe("Voiceover script (word budget enforced; omit for captions+music only)."),
      include_music: z.boolean().optional().nullable().describe("Generate a music bed via Eleven Music (default true)."),
    }),
  },
);

export const videoProductionStatusTool = tool(
  async ({ project }) => {
    const dir = join(projectsDir(), project);
    const planFile = join(dir, "production.json");
    if (!existsSync(planFile)) return `video_production_status: no production.json in ${dir}. Run plan_video_production first.`;
    let plan;
    try {
      plan = ProductionPlanSchema.parse(JSON.parse(readFileSync(planFile, "utf8")).plan);
    } catch (err) {
      return `video_production_status failed (plan file invalid): ${(err as Error).message}`;
    }
    const receipts: Record<string, StepReceipt> = {};
    const rdir = join(dir, "receipts");
    if (existsSync(rdir)) {
      for (const f of readdirSync(rdir).filter((f) => f.endsWith(".json"))) {
        const parsed = StepReceiptSchema.safeParse(JSON.parse(readFileSync(join(rdir, f), "utf8")));
        if (parsed.success) receipts[parsed.data.step_id] = parsed.data;
      }
    }
    const status = deriveStatus(plan, receipts);
    const done = status.steps.filter((s) => s.status === "done").length;
    return [
      `# ${project} — phase: ${status.phase} (${done}/${status.steps.length} steps done)`,
      status.failures.length > 0
        ? `FAILURES:\n${status.failures.map((f) => `- ${f.step_id} (${f.kind}, ${f.attempts} attempts): ${f.error}`).join("\n")}`
        : ``,
      status.next.length > 0 ? `Ready to run: ${status.next.join(", ")} (pending spend ~$${status.pending_cost_usd.toFixed(2)})` : ``,
      status.phase === "delivered" ? `Deliverable: video-factory/projects/${project}/renders/${project}.mp4` : ``,
    ]
      .filter((l) => l !== ``)
      .join("\n");
  },
  {
    name: "video_production_status",
    description:
      "Derive the state of a video production from its receipts (pure read): phase, per-step status, " +
      "terminal failures with the failing component named, remaining estimated spend.",
    schema: z.object({ project: z.string().describe("Project dir name under video-factory/projects/.") }),
  },
);
