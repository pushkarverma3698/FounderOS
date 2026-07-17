/**
 * FounderOS — Video Factory: Brand Registry
 * ==========================================
 * Loads and validates brand profiles from video-factory/brands/<slug>/brand.json.
 * The Zod schema IS the contract (rule: fix the schema, not the code) — a
 * malformed brand file is a typed failure the planner can surface, never a
 * silent guess. Pure I/O + validation; zero LLM calls, zero network.
 *
 * One brand.json drives N videos: the brief compiler (video-brief.ts) reads
 * these tokens to produce deterministic production briefs for any client.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const BrandPaletteSchema = z.object({
  background: z.string().regex(HEX_COLOR),
  surface: z.string().regex(HEX_COLOR),
  primary: z.string().regex(HEX_COLOR),
  text: z.string().regex(HEX_COLOR),
  muted: z.string().regex(HEX_COLOR),
  accent: z.string().regex(HEX_COLOR),
});

export const BrandVideoPrefsSchema = z.object({
  aspect_ratios: z.array(z.enum(["16:9", "9:16", "1:1"])).min(1),
  pacing: z.enum(["calm", "brisk", "energetic"]),
  captions: z.enum(["always", "optional"]),
  music: z.string(),
  voice: z.object({ language: z.string(), style: z.string() }),
  motion: z.string(),
  avoid: z.array(z.string()).default([]),
});

export const BrandProfileSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be kebab-case"),
  name: z.string().min(1),
  canonical_name_confirmed: z.boolean(),
  website: z.string().url(),
  industry: z.string(),
  location: z.string(),
  palette: BrandPaletteSchema,
  typography: z.object({ heading: z.string(), body: z.string(), style: z.string() }),
  tone: z.array(z.string()).min(1),
  tagline: z.string(),
  mission: z.string(),
  copy_lines: z.array(z.string()).min(1),
  pillars: z.array(z.string()).default([]),
  pillars_label: z.string().default(""),
  audiences: z.array(z.string()).min(1),
  cta: z.object({
    line: z.string(),
    website: z.string(),
    phone: z.string().optional(),
    email: z.string().optional(),
  }),
  socials: z.record(z.string(), z.string()).default({}),
  video: BrandVideoPrefsSchema,
  notes: z.string().default(""),
});

export type BrandProfile = z.infer<typeof BrandProfileSchema>;

export type BrandLoadResult =
  | { success: true; brand: BrandProfile }
  | { success: false; error: string };

/** Default registry location — repo-relative, overridable for tests/deploys. */
export function brandsDir(): string {
  return process.env["VIDEO_BRANDS_DIR"] ?? join(process.cwd(), "video-factory", "brands");
}

/** List registered brand slugs (directories containing a brand.json). */
export function listBrands(dir = brandsDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "brand.json")))
    .map((e) => e.name)
    .sort();
}

/** Load + validate one brand profile. Typed failure, never a guess. */
export function loadBrand(slug: string, dir = brandsDir()): BrandLoadResult {
  const file = join(dir, slug, "brand.json");
  if (!existsSync(file)) {
    const known = listBrands(dir);
    return {
      success: false,
      error: `Unknown brand "${slug}" — no ${file}. Registered brands: ${known.join(", ") || "(none)"}`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { success: false, error: `brand.json for "${slug}" is not valid JSON: ${(err as Error).message}` };
  }
  const parsed = BrandProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { success: false, error: `brand.json for "${slug}" failed schema validation: ${issues}` };
  }
  if (parsed.data.slug !== slug) {
    return { success: false, error: `brand.json slug "${parsed.data.slug}" does not match directory "${slug}"` };
  }
  return { success: true, brand: parsed.data };
}
