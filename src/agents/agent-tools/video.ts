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

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { listBrands, loadBrand } from "../../tools/video-brand.js";
import { compileVideoBrief } from "../../tools/video-brief.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "agent-tool:video" });

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
