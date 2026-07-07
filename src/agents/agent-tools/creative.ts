/**
 * FounderOS — Creative Tools (agent interface)
 * =============================================
 * Tools for the Creative department: image generation (Nano Banana) + brand
 * asset listing. Generated images flow straight into the S3 `agent_assets`
 * layer (roadmap #7: bytes in object storage, only a pointer in state) — the
 * tool returns the asset_id + a presigned URL, never raw image bytes.
 *
 * Cost discipline (roadmap #6): the cheap DRAFT model is the default. The
 * expensive Nano Banana Pro tier fires ONLY when the caller passes final=true
 * AND the daily budget gate is clear. No HITL inside the creative loop — drafts
 * are internal; the existing publish gate (comms/marketing) fires when a finished
 * asset is actually sent (roadmap #8).
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import { generateImage, ImageGenError, IMAGE_MODEL_FINAL } from "../../tools/image-gen.js";
import { uploadFile, StorageError } from "../../infra/storage/s3-client.js";
import { saveAsset, getBrandAssets } from "../../infra/storage/asset-repo.js";
import { logLlmCost, getTodayCostUsd } from "../../db/queries.js";
import { getDailyBudgetCapUsd, checkDailyBudgetGate } from "../../infra/daily-budget.js";
import { TENANT } from "../../core/config.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "agent-tool:creative" });

/** Resolve a run id for asset attribution: explicit arg, else the thread id. */
function resolveRunId(explicit: string | undefined | null, config?: RunnableConfig): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const threadId = config?.configurable?.["thread_id"];
  return typeof threadId === "string" && threadId ? threadId : "creative";
}

// ── generate_image ──────────────────────────────────────────────────────────

export const generateImageTool = tool(
  async ({ prompt, final, intent, run_id, asset_type }, config) => {
    const runId = resolveRunId(run_id, config as RunnableConfig);
    const wantFinal = final === true;

    // Budget gate — Pro tier only. Drafts are cheap and never gated.
    if (wantFinal) {
      const spent = await getTodayCostUsd(TENANT);
      const gate = checkDailyBudgetGate(spent, getDailyBudgetCapUsd());
      if (!gate.ok) {
        return (
          `🛑 Final (Nano Banana Pro, ~$${IMAGE_MODEL_FINAL.usdPerImage}/img) blocked — ` +
          `daily budget cap reached ($${spent.toFixed(4)}). Generate a draft instead, ` +
          `or raise the cap. (No image was generated, no spend.)`
        );
      }
    }

    let img;
    try {
      img = await generateImage(prompt, { final: wantFinal, intent: intent ?? undefined });
    } catch (err) {
      if (err instanceof ImageGenError) {
        log.error({ stage: err.stage, msg: err.message }, "generate_image failed");
        return `generate_image failed (${err.stage}): ${err.message}`;
      }
      return `generate_image failed: ${(err as Error).message}`;
    }

    // Record the image spend so the daily budget tracker sees it (rule #14 quota intent).
    try {
      await logLlmCost({
        tenant_id: TENANT,
        agent: "creative",
        tier: img.tier,
        model: img.model,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: img.usd.toFixed(6),
        lead_id: null,
      });
    } catch (err) {
      log.warn({ err: (err as Error).message }, "generate_image: cost log failed (image still produced)");
    }

    // Bytes → S3; pointer → Postgres. Never put image bytes in graph state.
    const ext = img.mimeType.includes("jpeg") ? "jpg" : img.mimeType.split("/")[1] ?? "png";
    const filename = `creative_${img.tier}_${Date.now()}.${ext}`;
    let s3Key: string;
    try {
      s3Key = await uploadFile(Buffer.from(img.base64, "base64"), filename, runId, "creative");
    } catch (err) {
      const msg = err instanceof StorageError ? err.message : (err as Error).message;
      return `generate_image: image generated (${img.model}) but S3 upload failed: ${msg}`;
    }

    let assetId: string;
    try {
      assetId = await saveAsset({
        run_id: runId,
        s3_key: s3Key,
        original_filename: filename,
        asset_type: asset_type ?? "output",
        mime_type: img.mimeType,
        agent_id: "creative",
        expires_at: null,
      });
    } catch (err) {
      return `generate_image: uploaded to S3 (key=${s3Key}) but DB record failed: ${(err as Error).message}`;
    }

    log.info({ assetId, model: img.model, tier: img.tier, usd: img.usd }, "generate_image ok");
    return JSON.stringify({
      asset_id: assetId,
      s3_key: s3Key,
      model: img.model,
      tier: img.tier,
      usd: img.usd,
      note: "Use get_download_url to share this image. Drafts are internal — publish via comms/marketing (HITL).",
    });
  },
  {
    name: "generate_image",
    description:
      "Generate an image from a text prompt. Uses the cheap DRAFT model (Nano " +
      "Banana 2) by default. Pass final=true ONLY for a publish-grade asset — " +
      "that uses Nano Banana Pro (~$0.13/img) and is checked against the daily " +
      "budget. The image is stored in S3; the tool returns { asset_id, s3_key, " +
      "model, tier, usd }. Drafts stay internal — never auto-publish.",
    schema: z.object({
      prompt: z.string().describe("What to draw — be specific about subject, style, composition."),
      final: z
        .boolean()
        .optional()
        .nullable()
        .describe("true = publish-grade Nano Banana Pro (budget-gated). Default false = cheap draft."),
      intent: z.string().optional().nullable().describe("Optional context, e.g. 'launch graphic for LinkedIn'."),
      run_id: z.string().optional().nullable().describe("Run/thread id for asset attribution (defaults to the conversation)."),
      asset_type: z
        .enum(["output", "brand", "scratch"])
        .optional()
        .nullable()
        .describe("'brand' to register as a reusable brand asset; default 'output'."),
    }),
  },
);

// ── list_brand_assets ─────────────────────────────────────────────────────────

export const listBrandAssetsTool = tool(
  async ({ limit }) => {
    try {
      const rows = await getBrandAssets(limit ?? 20);
      if (rows.length === 0) {
        return "No brand assets registered yet. Generate one with generate_image(asset_type='brand').";
      }
      return JSON.stringify(
        rows.map((r) => ({
          asset_id: r.id,
          s3_key: r.s3_key,
          filename: r.original_filename,
          mime_type: r.mime_type,
          created_at: r.created_at?.toISOString(),
        })),
      );
    } catch (err) {
      return `list_brand_assets failed: ${(err as Error).message}`;
    }
  },
  {
    name: "list_brand_assets",
    description:
      "List the registered brand assets (newest first) so visuals stay " +
      "on-brand across a campaign. Returns a JSON array of { asset_id, s3_key, " +
      "filename, mime_type, created_at }.",
    schema: z.object({
      limit: z.number().optional().nullable().describe("Max assets to return (default 20)."),
    }),
  },
);
